const std = @import("std");

const diff = @import("../core/diff.zig");
const json_rpc = @import("../protocol/json_rpc.zig");
const repository = @import("../core/repository.zig");
const runtime_mod = @import("rpc_runtime.zig");
const types = @import("../protocol/types.zig");

const Runtime = runtime_mod.Runtime;

pub fn register(server: anytype) !void {
    try server.handle("getVersion", getVersion);
    try server.handle("openRepository", openRepository);
    try server.handle("listChangedFiles", listChangedFiles);
    try server.handle("getDiffRenderModel", getDiffRenderModel);
}

fn getVersion(_: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try types.writeJson(writer, types.versionInfo());
}

fn openRepository(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const path = try json_rpc.getStringParam(request, "path");
    try runtime.session_lock.lock(runtime.io);
    defer runtime.session_lock.unlock(runtime.io);

    const repo = try runtime.session.openRepository(path);
    try types.writeJson(writer, types.openRepositoryResult(repo));
}

fn listChangedFiles(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const files = try repo.listChangedFiles();
    defer repository.freeChangedFiles(runtime.allocator, files);

    var result: std.ArrayList(types.ChangedFile) = .empty;
    defer result.deinit(runtime.allocator);
    for (files) |file| try result.append(runtime.allocator, types.changedFile(file));

    try types.writeJson(writer, result.items);
}

fn getDiffRenderModel(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const mode = getDiffOption(request, "mode") orelse "split";
    const context = getDiffOption(request, "context") orelse "diff";
    const diff_context: diff.DiffContextMode = if (std.mem.eql(u8, context, "full")) .full else .diff;

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    var model = try diff.getDiffRenderModel(runtime.allocator, repo.io, repo.root, file_id, file_id, .{ .context = diff_context });
    defer model.deinit(runtime.allocator);

    var rows: std.ArrayList(types.DiffRow) = .empty;
    defer rows.deinit(runtime.allocator);
    for (model.rows.items) |row| try rows.append(runtime.allocator, types.diffRow(row));

    try types.writeJson(writer, types.DiffRenderModel{
        .fileId = model.file_id,
        .mode = mode,
        .context = context,
        .rows = rows.items,
    });
}

fn getDiffOption(request: json_rpc.Request, name: []const u8) ?[]const u8 {
    const params = request.value.value.object.get("params") orelse return null;
    const params_object = switch (params) {
        .object => |object| object,
        else => return null,
    };
    const options = params_object.get("options") orelse return null;
    const options_object = switch (options) {
        .object => |object| object,
        else => return null,
    };
    const value = options_object.get(name) orelse return null;
    return switch (value) {
        .string => |text| text,
        else => null,
    };
}
