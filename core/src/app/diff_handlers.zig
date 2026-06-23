const std = @import("std");

const diff = @import("../core/diff.zig");
const json_rpc = @import("../protocol/json_rpc.zig");
const runtime_mod = @import("rpc_runtime.zig");
const types = @import("../protocol/types.zig");
const params = @import("rpc_params.zig");
const repo_snapshot = @import("rpc_repo.zig");

const Runtime = runtime_mod.Runtime;

pub fn register(server: anytype) !void {
    try server.handle("getDiffRenderModel", getDiffRenderModel);
}

fn getDiffRenderModel(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const mode = params.getDiffOption(request, "mode") orelse "split";
    const context = params.getDiffOption(request, "context") orelse "diff";
    const diff_context: diff.DiffContextMode = if (std.mem.eql(u8, context, "full")) .full else .diff;

    const grammar_root = try params.resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);
    const target = params.getDiffTarget(request);
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();
    const repo = snapshot.toRepository();

    var model = try diff.getDiffRenderModel(runtime.allocator, repo.io, repo.root, file_id, file_id, .{ .context = diff_context, .grammar_root = grammar_root, .target = target });
    defer model.deinit(runtime.allocator);

    var rows: std.ArrayList(types.DiffRow) = .empty;
    defer rows.deinit(runtime.allocator);
    for (model.rows.items) |row| try rows.append(runtime.allocator, types.diffRow(row));

    try types.writeJson(writer, types.DiffRenderModel{
        .fileId = model.file_id,
        .mode = mode,
        .context = context,
        .syntax = types.syntaxStatus(model.syntax_status),
        .rows = rows.items,
    });
}
