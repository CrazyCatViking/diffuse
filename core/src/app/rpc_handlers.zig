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
    try server.handle("getDiffTargetDefaults", getDiffTargetDefaults);
    try server.handle("listBranches", listBranches);
    try server.handle("listChangedFiles", listChangedFiles);
    try server.handle("getDiffRenderModel", getDiffRenderModel);
    try server.handle("getSyntaxSpans", getSyntaxSpans);
    try server.handle("listTreeSitterGrammars", listTreeSitterGrammars);
    try server.handle("installTreeSitterGrammar", installTreeSitterGrammar);
    try server.handle("uninstallTreeSitterGrammar", uninstallTreeSitterGrammar);
}

fn getVersion(_: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try types.writeJson(writer, types.versionInfo());
}

fn openRepository(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const path = try json_rpc.getStringParam(request, "path");
    try runtime.session_lock.lock(runtime.io);
    defer runtime.session_lock.unlock(runtime.io);

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
    const target = getDiffTarget(request);
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

fn getDiffRenderModel(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const mode = getDiffOption(request, "mode") orelse "split";
    const context = getDiffOption(request, "context") orelse "diff";
    const diff_context: diff.DiffContextMode = if (std.mem.eql(u8, context, "full")) .full else .diff;

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);
    const target = getDiffTarget(request);
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

fn installTreeSitterGrammar(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const language = try json_rpc.getStringParam(request, "language");
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);

    const progress = InstallProgress{ .runtime = runtime, .language = language };
    var result = try diff.syntax.installGrammar(runtime.allocator, runtime.io, language, grammar_root, progress);
    defer result.deinit(runtime.allocator);

    try types.writeJson(writer, types.installTreeSitterGrammarResult(result));
}

fn uninstallTreeSitterGrammar(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const language = try json_rpc.getStringParam(request, "language");
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);

    try runtime.syntax_cache_lock.lock(runtime.io);
    defer runtime.syntax_cache_lock.unlock(runtime.io);
    runtime.syntax_cache.removeLanguage(language);

    var result = try diff.syntax.uninstallGrammar(runtime.allocator, runtime.io, language, grammar_root);
    defer result.deinit(runtime.allocator);

    try types.writeJson(writer, types.uninstallTreeSitterGrammarResult(result));
}

fn listTreeSitterGrammars(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);

    const grammars = try diff.syntax.listGrammars(runtime.allocator, runtime.io, grammar_root);
    defer {
        for (grammars) |*grammar| grammar.deinit(runtime.allocator);
        runtime.allocator.free(grammars);
    }

    var result: std.ArrayList(types.TreeSitterGrammar) = .empty;
    defer result.deinit(runtime.allocator);
    for (grammars) |grammar| try result.append(runtime.allocator, types.treeSitterGrammar(grammar));

    try types.writeJson(writer, result.items);
}

fn getSyntaxSpans(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const side_text = try json_rpc.getStringParam(request, "side");
    const start_line = try getU32Param(request, "startLine");
    const end_line = try getU32Param(request, "endLine");
    const context = getDiffOption(request, "context") orelse "diff";
    const diff_context: diff.DiffContextMode = if (std.mem.eql(u8, context, "full")) .full else .diff;
    const side: diff.SyntaxSide = if (std.mem.eql(u8, side_text, "old")) .old else .new;

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);
    const target = getDiffTarget(request);
    try runtime.syntax_cache_lock.lock(runtime.io);
    defer runtime.syntax_cache_lock.unlock(runtime.io);

    const spans = try diff.getSyntaxSpans(runtime.allocator, repo.io, &runtime.syntax_cache, repo.root, file_id, file_id, .{ .context = diff_context, .grammar_root = grammar_root, .target = target }, side, start_line, end_line);
    defer diff.freeSyntaxLineSpans(runtime.allocator, spans);

    var result: std.ArrayList(types.SyntaxLineSpans) = .empty;
    defer result.deinit(runtime.allocator);
    for (spans) |line| try result.append(runtime.allocator, types.syntaxLineSpans(line));
    try types.writeJson(writer, result.items);
}

const InstallProgress = struct {
    runtime: *Runtime,
    language: []const u8,

    pub fn emit(self: InstallProgress, step: []const u8) !void {
        var message = std.Io.Writer.Allocating.init(self.runtime.allocator);
        errdefer message.deinit();

        try message.writer.writeAll("{\"jsonrpc\":\"2.0\",\"method\":\"treeSitter/installProgress\",\"params\":{");
        try message.writer.writeAll("\"language\":");
        try types.writeJson(&message.writer, self.language);
        try message.writer.writeAll(",\"step\":");
        try types.writeJson(&message.writer, step);
        try message.writer.writeAll("}}\n");

        try self.runtime.enqueue(try message.toOwnedSlice());
    }
};

fn resolveGrammarRoot(allocator: std.mem.Allocator, environ_map: *const std.process.Environ.Map) !?[]u8 {
    if (environ_map.get("DIFFUSE_GRAMMARS_DIR")) |path| return try allocator.dupe(u8, path);
    const home = environ_map.get("HOME") orelse return null;
    return try std.fs.path.join(allocator, &.{ home, ".diffuse", "grammars" });
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

fn getDiffTarget(request: json_rpc.Request) repository.DiffTarget {
    const params = request.value.value.object.get("params") orelse return .{};
    const params_object = switch (params) {
        .object => |object| object,
        else => return .{},
    };
    const target = params_object.get("target") orelse return .{};
    const target_object = switch (target) {
        .object => |object| object,
        else => return .{},
    };

    return .{
        .base = getObjectString(target_object, "base"),
        .compare = getObjectString(target_object, "compare"),
        .include_staged = getObjectBool(target_object, "includeStaged") orelse true,
        .include_unstaged = getObjectBool(target_object, "includeUnstaged") orelse true,
    };
}

fn getObjectString(object: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .string => |text| if (text.len == 0) null else text,
        else => null,
    };
}

fn getObjectBool(object: std.json.ObjectMap, name: []const u8) ?bool {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .bool => |enabled| enabled,
        else => null,
    };
}

fn getU32Param(request: json_rpc.Request, name: []const u8) !u32 {
    const params = request.value.value.object.get("params") orelse return error.MissingParams;
    const params_object = switch (params) {
        .object => |object| object,
        else => return error.InvalidParams,
    };
    const value = params_object.get(name) orelse return error.MissingParam;
    return switch (value) {
        .integer => |number| @intCast(number),
        else => error.InvalidParam,
    };
}
