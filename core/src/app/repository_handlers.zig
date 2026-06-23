const std = @import("std");

const json_rpc = @import("../protocol/json_rpc.zig");
const lsp = @import("../core/lsp.zig");
const repository = @import("../core/repository.zig");
const runtime_mod = @import("rpc_runtime.zig");
const types = @import("../protocol/types.zig");
const params = @import("rpc_params.zig");

const Runtime = runtime_mod.Runtime;

pub fn register(server: anytype) !void {
    try server.handle("getVersion", getVersion);
    try server.handle("openRepository", openRepository);
    try server.handle("getDiffTargetDefaults", getDiffTargetDefaults);
    try server.handle("listBranches", listBranches);
    try server.handle("listChangedFiles", listChangedFiles);
}

fn getVersion(_: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try types.writeJson(writer, types.versionInfo());
}

fn openRepository(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const path = try json_rpc.getStringParam(request, "path");
    try runtime.session_lock.lock(runtime.io);
    defer runtime.session_lock.unlock(runtime.io);

    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);
    runtime.lsp_manager.deinit(runtime.io);
    runtime.lsp_manager = lsp.Manager.init(runtime.allocator);

    const repo = try runtime.session.openRepository(path);
    try runtime.repo_watcher.start(repo.root);
    try types.writeJson(writer, types.openRepositoryResult(repo));
}

fn getDiffTargetDefaults(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    var defaults = try repo.diffTargetDefaults();
    defer defaults.deinit(runtime.allocator);

    try types.writeJson(writer, types.diffTargetDefaults(defaults));
}

fn listChangedFiles(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const target = params.getDiffTarget(request);
    const files = try repo.listChangedFiles(target);
    defer repository.freeChangedFiles(runtime.allocator, files);

    var result: std.ArrayList(types.ChangedFile) = .empty;
    defer result.deinit(runtime.allocator);
    for (files) |file| try result.append(runtime.allocator, types.changedFile(file));

    try types.writeJson(writer, result.items);
}

fn listBranches(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const branches = try repo.listBranches();
    defer repository.freeBranches(runtime.allocator, branches);

    var result: std.ArrayList(types.BranchInfo) = .empty;
    defer result.deinit(runtime.allocator);
    for (branches) |branch| try result.append(runtime.allocator, types.branchInfo(branch));

    try types.writeJson(writer, result.items);
}
