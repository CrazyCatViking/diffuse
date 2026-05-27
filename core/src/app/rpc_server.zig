const std = @import("std");

const diff = @import("../core/diff.zig");
const json_rpc = @import("../protocol/json_rpc.zig");
const session_mod = @import("../core/session.zig");
const types = @import("../protocol/types.zig");

pub fn run(allocator: std.mem.Allocator, io: std.Io) !void {
    var session = session_mod.Session.init(allocator, io);
    defer session.deinit();

    var stdout_buffer: [64 * 1024]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    while (true) {
        const line = try readStdinLine(allocator) orelse break;
        defer allocator.free(line);

        const trimmed = std.mem.trim(u8, line, "\r\n \t");
        if (trimmed.len == 0) continue;

        var request = json_rpc.parseRequest(allocator, trimmed) catch |err| {
            try json_rpc.writeError(stdout, -1, -32700, @errorName(err));
            try stdout.flush();
            continue;
        };
        defer request.deinit();

        handleRequest(allocator, &session, stdout, request) catch |err| {
            try json_rpc.writeError(stdout, request.id, -32000, @errorName(err));
        };
        try stdout.flush();
    }
}

fn readStdinLine(allocator: std.mem.Allocator) !?[]u8 {
    var line: std.ArrayList(u8) = .empty;
    errdefer line.deinit(allocator);

    var byte: [1]u8 = undefined;
    while (true) {
        const count = try std.posix.read(std.posix.STDIN_FILENO, &byte);
        if (count == 0) {
            if (line.items.len == 0) return null;
            return try line.toOwnedSlice(allocator);
        }

        if (byte[0] == '\n') return try line.toOwnedSlice(allocator);
        try line.append(allocator, byte[0]);
    }
}

fn handleRequest(allocator: std.mem.Allocator, session: *session_mod.Session, writer: anytype, request: json_rpc.Request) !void {
    if (std.mem.eql(u8, request.method, "getVersion")) {
        try json_rpc.writeRawResultPrefix(writer, request.id);
        try types.writeVersionJson(writer);
        try json_rpc.writeRawResultSuffix(writer);
        return;
    }

    if (std.mem.eql(u8, request.method, "openRepository")) {
        const path = try json_rpc.getStringParam(request, "path");
        const repo = try session.openRepository(path);
        try json_rpc.writeRawResultPrefix(writer, request.id);
        try types.writeOpenRepositoryJson(writer, repo);
        try json_rpc.writeRawResultSuffix(writer);
        return;
    }

    if (std.mem.eql(u8, request.method, "listChangedFiles")) {
        const repo = try session.requireRepo();
        const files = try repo.listChangedFiles();
        defer @import("../core/repository.zig").freeChangedFiles(allocator, files);
        try json_rpc.writeRawResultPrefix(writer, request.id);
        try types.writeChangedFilesJson(writer, files);
        try json_rpc.writeRawResultSuffix(writer);
        return;
    }

    if (std.mem.eql(u8, request.method, "getDiffRenderModel")) {
        const repo = try session.requireRepo();
        const file_id = try json_rpc.getStringParam(request, "fileId");
        var model = try diff.getDiffRenderModel(allocator, repo.io, repo.root, file_id, file_id);
        defer model.deinit(allocator);
        try json_rpc.writeRawResultPrefix(writer, request.id);
        try types.writeDiffRenderModelJson(writer, model);
        try json_rpc.writeRawResultSuffix(writer);
        return;
    }

    return error.MethodNotFound;
}
