const std = @import("std");

const diff = @import("../core/diff.zig");
const json_rpc = @import("../protocol/json_rpc.zig");
const session_mod = @import("../core/session.zig");
const types = @import("../protocol/types.zig");

pub fn run(allocator: std.mem.Allocator, io: std.Io) !void {
    var runtime: Runtime = undefined;
    runtime.init(allocator, io);
    defer runtime.deinit();

    var writer_group: std.Io.Group = .init;
    try writer_group.concurrent(io, writerTask, .{&runtime});

    var request_group: std.Io.Group = .init;

    var stdin_buffer: [1024 * 1024]u8 = undefined;
    var stdin_reader = std.Io.File.stdin().readerStreaming(io, &stdin_buffer);
    const stdin = &stdin_reader.interface;

    while (true) {
        const line_slice = (stdin.takeDelimiter('\n') catch |err| switch (err) {
            error.ReadFailed => return error.ReadFailed,
            error.StreamTooLong => {
                try runtime.enqueueError(-1, -32700, "RequestTooLong");
                _ = try stdin.discardDelimiterInclusive('\n');
                continue;
            },
        }) orelse break;
        const line = try allocator.dupe(u8, line_slice);
        defer allocator.free(line);

        const trimmed = std.mem.trim(u8, line, "\r\n \t");
        if (trimmed.len == 0) continue;

        const request = json_rpc.parseRequest(allocator, trimmed) catch |err| {
            try runtime.enqueueError(-1, -32700, @errorName(err));
            continue;
        };

        request_group.concurrent(io, requestTask, .{ &runtime, request }) catch |err| switch (err) {
            error.ConcurrencyUnavailable => {
                requestTask(&runtime, request) catch {};
            },
        };
    }

    try request_group.await(io);
    runtime.outbound.close(io);
    try writer_group.await(io);
}

const Runtime = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    session: session_mod.Session,
    session_lock: std.Io.RwLock = .init,
    outbound_buffer: [128][]u8 = undefined,
    outbound: std.Io.Queue([]u8),

    fn init(runtime: *Runtime, allocator: std.mem.Allocator, io: std.Io) void {
        runtime.allocator = allocator;
        runtime.io = io;
        runtime.session = session_mod.Session.init(allocator, io);
        runtime.session_lock = .init;
        runtime.outbound_buffer = undefined;
        runtime.outbound = .init(&runtime.outbound_buffer);
    }

    fn deinit(runtime: *Runtime) void {
        runtime.session.deinit();
    }

    fn enqueue(runtime: *Runtime, message: []u8) (std.Io.QueueClosedError || std.Io.Cancelable)!void {
        errdefer runtime.allocator.free(message);
        try runtime.outbound.putOne(runtime.io, message);
    }

    fn enqueueError(runtime: *Runtime, id: i64, code: i64, message: []const u8) !void {
        const response = try buildError(runtime.allocator, id, code, message);
        try runtime.enqueue(response);
    }
};

fn writerTask(runtime: *Runtime) std.Io.Cancelable!void {
    var stdout_buffer: [64 * 1024]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(runtime.io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    while (true) {
        const message = runtime.outbound.getOne(runtime.io) catch |err| switch (err) {
            error.Closed => break,
            error.Canceled => return error.Canceled,
        };
        defer runtime.allocator.free(message);

        stdout.writeAll(message) catch continue;
        stdout.flush() catch continue;
    }
}

fn requestTask(runtime: *Runtime, request: json_rpc.Request) std.Io.Cancelable!void {
    defer request.deinit();

    const response = buildResponse(runtime, request) catch |err| buildError(runtime.allocator, request.id, -32000, @errorName(err)) catch return;
    runtime.enqueue(response) catch |err| switch (err) {
        error.Closed => runtime.allocator.free(response),
        error.Canceled => return error.Canceled,
    };
}

fn buildResponse(runtime: *Runtime, request: json_rpc.Request) ![]u8 {
    var response = std.Io.Writer.Allocating.init(runtime.allocator);
    errdefer response.deinit();

    try handleRequest(runtime, &response.writer, request);
    return try response.toOwnedSlice();
}

fn buildError(allocator: std.mem.Allocator, id: i64, code: i64, message: []const u8) ![]u8 {
    var response = std.Io.Writer.Allocating.init(allocator);
    errdefer response.deinit();

    try json_rpc.writeError(&response.writer, id, code, message);
    return try response.toOwnedSlice();
}

fn handleRequest(runtime: *Runtime, writer: anytype, request: json_rpc.Request) !void {
    if (std.mem.eql(u8, request.method, "getVersion")) {
        try json_rpc.writeRawResultPrefix(writer, request.id);
        try types.writeVersionJson(writer);
        try json_rpc.writeRawResultSuffix(writer);
        return;
    }

    if (std.mem.eql(u8, request.method, "openRepository")) {
        const path = try json_rpc.getStringParam(request, "path");
        try runtime.session_lock.lock(runtime.io);
        defer runtime.session_lock.unlock(runtime.io);

        const repo = try runtime.session.openRepository(path);
        try json_rpc.writeRawResultPrefix(writer, request.id);
        try types.writeOpenRepositoryJson(writer, repo);
        try json_rpc.writeRawResultSuffix(writer);
        return;
    }

    if (std.mem.eql(u8, request.method, "listChangedFiles")) {
        try runtime.session_lock.lockShared(runtime.io);
        defer runtime.session_lock.unlockShared(runtime.io);

        const repo = try runtime.session.requireRepo();
        const files = try repo.listChangedFiles();
        defer @import("../core/repository.zig").freeChangedFiles(runtime.allocator, files);
        try json_rpc.writeRawResultPrefix(writer, request.id);
        try types.writeChangedFilesJson(writer, files);
        try json_rpc.writeRawResultSuffix(writer);
        return;
    }

    if (std.mem.eql(u8, request.method, "getDiffRenderModel")) {
        const file_id = try json_rpc.getStringParam(request, "fileId");
        try runtime.session_lock.lockShared(runtime.io);
        defer runtime.session_lock.unlockShared(runtime.io);

        const repo = try runtime.session.requireRepo();
        var model = try diff.getDiffRenderModel(runtime.allocator, repo.io, repo.root, file_id, file_id);
        defer model.deinit(runtime.allocator);
        try json_rpc.writeRawResultPrefix(writer, request.id);
        try types.writeDiffRenderModelJson(writer, model);
        try json_rpc.writeRawResultSuffix(writer);
        return;
    }

    return error.MethodNotFound;
}
