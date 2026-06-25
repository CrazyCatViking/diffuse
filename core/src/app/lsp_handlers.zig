const std = @import("std");

const diff = @import("../core/diff.zig");
const json_rpc = @import("../protocol/json_rpc.zig");
const lsp = @import("../core/lsp.zig");
const repository = @import("../core/repository.zig");
const runtime_mod = @import("rpc_runtime.zig");
const types = @import("../protocol/types.zig");
const events = @import("rpc_events.zig");
const params = @import("rpc_params.zig");
const repo_snapshot = @import("rpc_repo.zig");

const Runtime = runtime_mod.Runtime;

pub fn register(server: anytype) !void {
    try server.handle("getLspConfigInfo", getLspConfigInfo);
    try server.handle("getLspInstallInfo", getLspInstallInfo);
    try server.handle("installLspServer", installLspServer);
    try server.handle("restartLspServer", restartLspServer);
    try server.handle("getLspStatus", getLspStatus);
    try server.handle("getLspHover", getLspHover);
    try server.handle("getLspDiagnostics", getLspDiagnostics);
}

fn getLspStatus(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const side = try params.getOptionalSyntaxSideParam(request, "side", .new);

    const target = try params.getDiffTarget(request);
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();
    var repo = snapshot.toRepository();

    const path = try resolvePathForSide(runtime.allocator, &repo, target, file_id, side);
    defer runtime.allocator.free(path);

    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);

    const status = try lsp.statusForPath(&runtime.lsp_manager, runtime.allocator, runtime.io, runtime.environ_map, repo.root, path);
    defer lsp.freeStatus(runtime.allocator, status);
    try types.writeJson(writer, types.lspStatus(status));
}

fn getLspConfigInfo(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);

    var info = try lsp.configInfo(&runtime.lsp_manager, runtime.allocator, runtime.io, runtime.environ_map);
    defer info.deinit(runtime.allocator);

    var servers: std.ArrayList(types.LspServerInfo) = .empty;
    defer servers.deinit(runtime.allocator);
    for (info.servers) |server| try servers.append(runtime.allocator, types.lspServerInfo(server));
    try types.writeJson(writer, types.lspConfigInfo(info, servers.items));
}

fn getLspInstallInfo(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const server_id = try json_rpc.getStringParam(request, "serverId");
    const command = try json_rpc.getStringParam(request, "command");
    const info = try lsp.installInfo(runtime.allocator, server_id, command);
    defer info.deinit(runtime.allocator);
    try types.writeJson(writer, types.lspInstallInfo(info));
}

fn installLspServer(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const server_id = try json_rpc.getStringParam(request, "serverId");
    const command = try json_rpc.getStringParam(request, "command");
    const progress = events.LspInstallProgress{ .runtime = runtime, .server_id = server_id };
    var result = try lsp.installServer(runtime.allocator, runtime.io, runtime.environ_map, server_id, command, progress);
    defer result.deinit(runtime.allocator);
    try types.writeJson(writer, types.installLspServerResult(result));
}

fn restartLspServer(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const server_id = try json_rpc.getStringParam(request, "serverId");
    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);

    var result = try runtime.lsp_manager.restart(runtime.allocator, runtime.io, server_id);
    defer result.deinit(runtime.allocator);
    try types.writeJson(writer, types.restartLspServerResult(result));
}

fn getLspHover(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const line = try params.getU32Param(request, "line");
    const column = try params.getU32Param(request, "column");
    const side = try params.getSyntaxSideParam(request, "side");

    const target = try params.getDiffTarget(request);
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();
    var repo = snapshot.toRepository();

    const path = try resolvePathForSide(runtime.allocator, &repo, target, file_id, side);
    defer runtime.allocator.free(path);
    const source = try diff.sourceForSide(runtime.allocator, runtime.io, repo.root, path, side, target);
    defer runtime.allocator.free(source);

    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);

    const result = try lsp.hover(&runtime.lsp_manager, runtime.allocator, runtime.io, runtime.environ_map, repo.root, path, source, line, column);
    defer lsp.freeHoverResult(runtime.allocator, result);
    try types.writeJson(writer, types.lspHover(result));
}

fn getLspDiagnostics(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const side = try params.getSyntaxSideParam(request, "side");

    const target = try params.getDiffTarget(request);
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();
    var repo = snapshot.toRepository();

    const path = try resolvePathForSide(runtime.allocator, &repo, target, file_id, side);
    defer runtime.allocator.free(path);
    const source = try diff.sourceForSide(runtime.allocator, runtime.io, repo.root, path, side, target);
    defer runtime.allocator.free(source);

    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);

    const result = try lsp.diagnostics(&runtime.lsp_manager, runtime.allocator, runtime.io, runtime.environ_map, repo.root, path, source);
    defer lsp.freeDiagnosticsResult(runtime.allocator, result);
    var diagnostics: std.ArrayList(types.LspDiagnostic) = .empty;
    defer diagnostics.deinit(runtime.allocator);
    for (result.diagnostics) |diagnostic| try diagnostics.append(runtime.allocator, types.lspDiagnostic(diagnostic));
    try types.writeJson(writer, types.lspDiagnostics(result, diagnostics.items));
}

fn resolvePathForSide(allocator: std.mem.Allocator, repo: *repository.Repository, target: repository.DiffTarget, file_id: []const u8, side: diff.SyntaxSide) ![]u8 {
    const files = repo.listChangedFiles(target) catch return allocator.dupe(u8, file_id);
    defer repository.freeChangedFiles(allocator, files);
    for (files) |file| {
        if (!std.mem.eql(u8, file.id, file_id) and
            !(file.old_path != null and std.mem.eql(u8, file.old_path.?, file_id)) and
            !(file.new_path != null and std.mem.eql(u8, file.new_path.?, file_id))) continue;
        return switch (side) {
            .old => allocator.dupe(u8, file.old_path orelse file.new_path orelse file.id),
            .new => allocator.dupe(u8, file.new_path orelse file.old_path orelse file.id),
        };
    }
    return allocator.dupe(u8, file_id);
}
