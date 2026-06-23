const std = @import("std");

const json_rpc = @import("../protocol/json_rpc.zig");
const rpc_handlers = @import("rpc_handlers.zig");
const rpc_runtime = @import("rpc_runtime.zig");

const Runtime = rpc_runtime.Runtime;

pub fn run(allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map) !void {
    var server = RpcServer.init(allocator);
    defer server.deinit();

    try rpc_handlers.register(&server);

    var runtime: Runtime = undefined;
    runtime.init(allocator, io, environ_map);
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
            try runtime.enqueueParseError(@errorName(err));
            continue;
        };

        request_group.concurrent(io, requestTask, .{ &server, &runtime, request }) catch |err| switch (err) {
            error.ConcurrencyUnavailable => {
                requestTask(&server, &runtime, request) catch {};
            },
        };
    }

    try request_group.await(io);
    runtime.outbound.close(io);
    try writer_group.await(io);
}

const RpcServer = struct {
    const Handler = *const fn (*Runtime, *std.Io.Writer, json_rpc.Request) anyerror!void;

    const Route = struct {
        method: []const u8,
        handler: Handler,
    };

    allocator: std.mem.Allocator,
    routes: std.ArrayList(Route),

    fn init(allocator: std.mem.Allocator) RpcServer {
        return .{ .allocator = allocator, .routes = .empty };
    }

    fn deinit(server: *RpcServer) void {
        server.routes.deinit(server.allocator);
    }

    pub fn handle(server: *RpcServer, method: []const u8, handler: Handler) !void {
        try server.routes.append(server.allocator, .{ .method = method, .handler = handler });
    }

    fn dispatch(server: *const RpcServer, runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
        for (server.routes.items) |route| {
            if (std.mem.eql(u8, request.method, route.method)) {
                return route.handler(runtime, writer, request);
            }
        }

        return error.MethodNotFound;
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

fn requestTask(server: *const RpcServer, runtime: *Runtime, request: json_rpc.Request) std.Io.Cancelable!void {
    defer request.deinit();

    const response = buildResponse(server, runtime, request) catch |err| rpc_runtime.buildError(runtime.allocator, request.id, errorCode(err), @errorName(err)) catch return;
    runtime.enqueue(response) catch |err| switch (err) {
        error.Closed => runtime.allocator.free(response),
        error.Canceled => return error.Canceled,
    };
}

fn errorCode(err: anyerror) i64 {
    return switch (err) {
        error.MethodNotFound => -32601,
        error.MissingParams, error.InvalidParams, error.MissingParam, error.InvalidParam, error.InvalidPathSegment => -32602,
        else => -32000,
    };
}

fn buildResponse(server: *const RpcServer, runtime: *Runtime, request: json_rpc.Request) ![]u8 {
    var response = std.Io.Writer.Allocating.init(runtime.allocator);
    errdefer response.deinit();

    try json_rpc.writeRawResultPrefix(&response.writer, request.id);
    try server.dispatch(runtime, &response.writer, request);
    try json_rpc.writeRawResultSuffix(&response.writer);
    return try response.toOwnedSlice();
}
