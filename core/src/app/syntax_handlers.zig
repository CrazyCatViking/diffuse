const std = @import("std");

const diff = @import("../core/diff.zig");
const json_rpc = @import("../protocol/json_rpc.zig");
const runtime_mod = @import("rpc_runtime.zig");
const types = @import("../protocol/types.zig");
const events = @import("rpc_events.zig");
const params = @import("rpc_params.zig");
const repo_snapshot = @import("rpc_repo.zig");

const Runtime = runtime_mod.Runtime;

pub fn register(server: anytype) !void {
    try server.handle("getSyntaxSpans", getSyntaxSpans);
    try server.handle("listTreeSitterGrammars", listTreeSitterGrammars);
    try server.handle("syncTreeSitterRegistry", syncTreeSitterRegistry);
    try server.handle("installTreeSitterGrammar", installTreeSitterGrammar);
    try server.handle("uninstallTreeSitterGrammar", uninstallTreeSitterGrammar);
}

fn installTreeSitterGrammar(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const language = try json_rpc.getStringParam(request, "language");
    const grammar_root = try params.resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);

    const progress = events.TreeSitterInstallProgress{ .runtime = runtime, .language = language };
    var result = try diff.syntax.installGrammar(runtime.allocator, runtime.io, language, grammar_root, progress);
    defer result.deinit(runtime.allocator);

    try types.writeJson(writer, types.installTreeSitterGrammarResult(result));
}

fn uninstallTreeSitterGrammar(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const language = try json_rpc.getStringParam(request, "language");
    const grammar_root = try params.resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);

    try runtime.syntax_cache_lock.lock(runtime.io);
    defer runtime.syntax_cache_lock.unlock(runtime.io);
    runtime.syntax_cache.removeLanguage(language);

    var result = try diff.syntax.uninstallGrammar(runtime.allocator, runtime.io, language, grammar_root);
    defer result.deinit(runtime.allocator);

    try types.writeJson(writer, types.uninstallTreeSitterGrammarResult(result));
}

fn listTreeSitterGrammars(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    const grammar_root = try params.resolveGrammarRoot(runtime.allocator, runtime.environ_map);
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

fn syncTreeSitterRegistry(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const git_url = (try params.getOptionalStringParam(request, "gitUrl")) orelse runtime.environ_map.get("DIFFUSE_TREE_SITTER_REGISTRY_GIT_URL") orelse "https://github.com/CrazyCatViking/diffuse-tree-sitter.git";
    const grammar_root = try params.resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);

    var result = try diff.syntax.syncRegistry(runtime.allocator, runtime.io, grammar_root, git_url);
    defer result.deinit(runtime.allocator);

    try types.writeJson(writer, types.syncTreeSitterRegistryResult(result));
}

fn getSyntaxSpans(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const start_line = try params.getU32Param(request, "startLine");
    const end_line = try params.getU32Param(request, "endLine");
    const diff_context = try params.getDiffContextMode(request);
    const side = try params.getSyntaxSideParam(request, "side");

    const grammar_root = try params.resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);
    const target = try params.getDiffTarget(request);
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();
    const repo = snapshot.toRepository();

    var prepared = try diff.prepareSyntaxSpans(runtime.allocator, repo.io, repo.root, file_id, file_id, .{ .context = diff_context, .grammar_root = grammar_root, .target = target }, side, start_line, end_line);
    defer if (prepared) |*value| value.deinit(runtime.allocator);

    const spans = if (prepared) |*value| spans: {
        try runtime.syntax_cache_lock.lock(runtime.io);
        defer runtime.syntax_cache_lock.unlock(runtime.io);
        break :spans try diff.highlightPreparedSyntaxSpans(runtime.allocator, repo.io, &runtime.syntax_cache, value);
    } else try runtime.allocator.alloc(diff.SyntaxLineSpans, 0);
    defer diff.freeSyntaxLineSpans(runtime.allocator, spans);

    var result: std.ArrayList(types.SyntaxLineSpans) = .empty;
    defer result.deinit(runtime.allocator);
    for (spans) |line| try result.append(runtime.allocator, types.syntaxLineSpans(line));
    try types.writeJson(writer, result.items);
}
