const std = @import("std");
const builtin = @import("builtin");
const ts = @import("tree-sitter");

const registry_json = @embedFile("tree_sitter_registry.json");
const bash_highlights = @embedFile("tree_sitter_queries/bash/highlights.scm");
const c_highlights = @embedFile("tree_sitter_queries/c/highlights.scm");
const cpp_highlights = @embedFile("tree_sitter_queries/cpp/highlights.scm");
const css_highlights = @embedFile("tree_sitter_queries/css/highlights.scm");
const dockerfile_highlights = @embedFile("tree_sitter_queries/dockerfile/highlights.scm");
const ecma_highlights = @embedFile("tree_sitter_queries/ecma/highlights.scm");
const go_highlights = @embedFile("tree_sitter_queries/go/highlights.scm");
const html_highlights = @embedFile("tree_sitter_queries/html/highlights.scm");
const html_tags_highlights = @embedFile("tree_sitter_queries/html_tags/highlights.scm");
const java_highlights = @embedFile("tree_sitter_queries/java/highlights.scm");
const javascript_highlights = @embedFile("tree_sitter_queries/javascript/highlights.scm");
const json_highlights = @embedFile("tree_sitter_queries/json/highlights.scm");
const jsx_highlights = @embedFile("tree_sitter_queries/jsx/highlights.scm");
const make_highlights = @embedFile("tree_sitter_queries/make/highlights.scm");
const markdown_highlights = @embedFile("tree_sitter_queries/markdown/highlights.scm");
const markdown_inline_highlights = @embedFile("tree_sitter_queries/markdown_inline/highlights.scm");
const python_highlights = @embedFile("tree_sitter_queries/python/highlights.scm");
const rust_highlights = @embedFile("tree_sitter_queries/rust/highlights.scm");
const scss_highlights = @embedFile("tree_sitter_queries/scss/highlights.scm");
const tsx_highlights = @embedFile("tree_sitter_queries/tsx/highlights.scm");
const typescript_highlights = @embedFile("tree_sitter_queries/typescript/highlights.scm");
const vue_highlights = @embedFile("tree_sitter_queries/vue/highlights.scm");
const yaml_highlights = @embedFile("tree_sitter_queries/yaml/highlights.scm");
const zig_highlights = @embedFile("tree_sitter_queries/zig/highlights.scm");
const html_tags_injections = @embedFile("tree_sitter_queries/html_tags/injections.scm");
const vue_injections = @embedFile("tree_sitter_queries/vue/injections.scm");
const enable_direct_highlighter = true;
var temp_file_counter: usize = 0;

const Registry = struct {
    source: []const u8,
    sourceLicense: []const u8,
    snapshotDate: []const u8,
    languages: []const RegistryLanguage,
};

const RegistryLanguage = struct {
    id: []const u8,
    url: ?[]const u8 = null,
    revision: ?[]const u8 = null,
    location: ?[]const u8 = null,
    queryOnly: bool = false,
    generate: bool = false,
    requires: ?[]const []const u8 = null,
};

const OwnedRegistryLanguage = struct {
    id: []const u8,
    url: ?[]const u8 = null,
    revision: ?[]const u8 = null,
    location: ?[]const u8 = null,
    requires: []const []const u8 = &.{},
    queryOnly: bool = false,
    generate: bool = false,

    fn deinit(self: *OwnedRegistryLanguage, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        if (self.url) |value| allocator.free(value);
        if (self.revision) |value| allocator.free(value);
        if (self.location) |value| allocator.free(value);
        for (self.requires) |value| allocator.free(value);
        allocator.free(self.requires);
    }
};

pub const InstallResult = struct {
    language: []const u8,
    installed: bool,
    grammarPath: ?[]const u8 = null,
    highlightsQueryPath: ?[]const u8 = null,
    message: ?[]const u8 = null,

    pub fn deinit(self: *InstallResult, allocator: std.mem.Allocator) void {
        allocator.free(self.language);
        if (self.grammarPath) |value| allocator.free(value);
        if (self.highlightsQueryPath) |value| allocator.free(value);
        if (self.message) |value| allocator.free(value);
    }
};

pub const UninstallResult = struct {
    language: []const u8,
    uninstalled: bool,
    message: ?[]const u8 = null,

    pub fn deinit(self: *UninstallResult, allocator: std.mem.Allocator) void {
        allocator.free(self.language);
        if (self.message) |value| allocator.free(value);
    }
};

pub const GrammarInfo = struct {
    id: []const u8,
    url: ?[]const u8 = null,
    revision: ?[]const u8 = null,
    requires: []const []const u8 = &.{},
    installed: bool,
    grammarPath: ?[]const u8 = null,
    highlightsQueryPath: ?[]const u8 = null,

    pub fn deinit(self: *GrammarInfo, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        if (self.url) |value| allocator.free(value);
        if (self.revision) |value| allocator.free(value);
        for (self.requires) |value| allocator.free(value);
        allocator.free(self.requires);
        if (self.grammarPath) |value| allocator.free(value);
        if (self.highlightsQueryPath) |value| allocator.free(value);
    }
};

pub const SyntaxStatus = struct {
    language: ?[]const u8 = null,
    grammarInstalled: bool = false,
    grammarPath: ?[]const u8 = null,
    highlightsQueryPath: ?[]const u8 = null,
    missingReason: ?[]const u8 = null,

    pub fn deinit(self: *SyntaxStatus, allocator: std.mem.Allocator) void {
        if (self.language) |value| allocator.free(value);
        if (self.grammarPath) |value| allocator.free(value);
        if (self.highlightsQueryPath) |value| allocator.free(value);
        if (self.missingReason) |value| allocator.free(value);
    }
};

pub const SyntaxSpan = struct {
    startColumn: u32,
    endColumn: u32,
    scope: []const u8,
};

pub const Side = enum { old, new };

const LineSpan = struct {
    line: u32,
    span: SyntaxSpan,
};

const Capture = struct {
    pattern: u32,
    scope: []const u8,
    start_row: u32,
    start_column: u32,
    end_row: u32,
    end_column: u32,

    fn deinit(self: *Capture, allocator: std.mem.Allocator) void {
        allocator.free(self.scope);
    }
};

const InjectionRange = struct {
    language: []const u8,
    start_row: u32,
    start_column: u32,
    end_row: u32,
    end_column: u32,

    fn deinit(self: *InjectionRange, allocator: std.mem.Allocator) void {
        allocator.free(self.language);
    }
};

const InjectionSegment = struct {
    range: InjectionRange,
    start_line: u32,
    line_count: u32,

    fn deinit(self: *InjectionSegment, allocator: std.mem.Allocator) void {
        self.range.deinit(allocator);
    }
};

const PredicateResult = struct {
    matches: bool = true,
    injection_language: ?[]const u8 = null,
};

pub const Cache = struct {
    allocator: std.mem.Allocator,
    entries: std.ArrayList(CacheEntry),

    pub fn init(allocator: std.mem.Allocator) Cache {
        return .{ .allocator = allocator, .entries = .empty };
    }

    pub fn deinit(self: *Cache) void {
        for (self.entries.items) |*entry| entry.deinit(self.allocator);
        self.entries.deinit(self.allocator);
    }

    pub fn removeLanguage(self: *Cache, language: []const u8) void {
        var index: usize = 0;
        while (index < self.entries.items.len) {
            if (std.mem.eql(u8, self.entries.items[index].language, language)) {
                self.entries.items[index].deinit(self.allocator);
                _ = self.entries.orderedRemove(index);
            } else {
                index += 1;
            }
        }
    }
};

const CacheEntry = struct {
    language: []const u8,
    grammar_path: []const u8,
    library: std.DynLib,
    ts_language: *const ts.Language,
    highlights_query: ?*ts.Query = null,
    injections_query: ?*ts.Query = null,

    fn deinit(self: *CacheEntry, allocator: std.mem.Allocator) void {
        if (self.highlights_query) |query| query.destroy();
        if (self.injections_query) |query| query.destroy();
        self.library.close();
        allocator.free(self.language);
        allocator.free(self.grammar_path);
    }
};

const DirectQuery = struct {
    ts_language: *const ts.Language,
    query: *ts.Query,
};

const QueryKind = enum { highlights, injections };

const SourceMap = struct {
    source: []u8,
    line_lengths: []u32,

    fn deinit(self: *SourceMap, allocator: std.mem.Allocator) void {
        allocator.free(self.source);
        allocator.free(self.line_lengths);
    }
};

pub fn highlightRows(allocator: std.mem.Allocator, io: std.Io, rows: anytype, status: SyntaxStatus) !void {
    const language = status.language orelse return;
    const grammar_path = status.grammarPath orelse return;
    const query_path = status.highlightsQueryPath orelse return;
    var old_source = try buildSourceMap(allocator, rows.items, .old);
    defer old_source.deinit(allocator);
    var new_source = try buildSourceMap(allocator, rows.items, .new);
    defer new_source.deinit(allocator);

    if (old_source.source.len > 0) {
        const spans = highlightSource(allocator, io, language, grammar_path, query_path, old_source) catch null;
        if (spans) |values| {
            defer freeLineSpans(allocator, values);
            try attachSpans(allocator, rows, .old, values);
        }
    }

    if (new_source.source.len > 0) {
        const spans = highlightSource(allocator, io, language, grammar_path, query_path, new_source) catch null;
        if (spans) |values| {
            defer freeLineSpans(allocator, values);
            try attachSpans(allocator, rows, .new, values);
        }
    }
}

pub const SyntaxLineSpans = struct {
    line: u32,
    spans: []const SyntaxSpan,
};

pub fn highlightRowsRange(allocator: std.mem.Allocator, io: std.Io, rows: anytype, status: SyntaxStatus, side: Side, start_line: u32, end_line: u32) ![]SyntaxLineSpans {
    const language = status.language orelse return allocator.alloc(SyntaxLineSpans, 0);
    const grammar_path = status.grammarPath orelse return allocator.alloc(SyntaxLineSpans, 0);
    const query_path = status.highlightsQueryPath orelse return allocator.alloc(SyntaxLineSpans, 0);
    if (end_line < start_line) return allocator.alloc(SyntaxLineSpans, 0);

    var source = try buildSourceMap(allocator, rows, side);
    defer source.deinit(allocator);
    if (source.source.len == 0) return allocator.alloc(SyntaxLineSpans, 0);

    const spans = highlightSourceRange(allocator, io, language, grammar_path, query_path, source, start_line, end_line) catch return allocator.alloc(SyntaxLineSpans, 0);
    defer freeLineSpans(allocator, spans);
    return groupLineSpans(allocator, spans, start_line, end_line);
}

pub fn highlightTextRange(allocator: std.mem.Allocator, io: std.Io, language: []const u8, grammar_path: []const u8, query_path: []const u8, source_text: []const u8, start_line: u32, end_line: u32) ![]SyntaxLineSpans {
    return highlightTextRangeCached(allocator, io, null, language, grammar_path, query_path, source_text, start_line, end_line);
}

pub fn highlightTextRangeCached(allocator: std.mem.Allocator, io: std.Io, cache: ?*Cache, language: []const u8, grammar_path: []const u8, query_path: []const u8, source_text: []const u8, start_line: u32, end_line: u32) ![]SyntaxLineSpans {
    if (source_text.len == 0 or end_line < start_line) return allocator.alloc(SyntaxLineSpans, 0);
    var source = SourceMap{
        .source = try allocator.dupe(u8, source_text),
        .line_lengths = try lineLengths(allocator, source_text),
    };
    defer source.deinit(allocator);

    const spans = highlightSourceRange(allocator, io, cache, language, grammar_path, query_path, source, start_line, end_line) catch return allocator.alloc(SyntaxLineSpans, 0);
    defer freeLineSpans(allocator, spans);
    return groupLineSpans(allocator, spans, start_line, end_line);
}

pub fn hasInjections(language: []const u8) bool {
    return vendoredInjectionsQuery(language) != null;
}

pub fn installGrammar(allocator: std.mem.Allocator, io: std.Io, language: []const u8, configured_grammar_root: ?[]const u8, progress: anytype) !InstallResult {
    try progress.emit("Resolving grammar metadata");
    var entry = try registryEntry(allocator, language) orelse {
        return .{
            .language = try allocator.dupe(u8, language),
            .installed = false,
            .message = try allocator.dupe(u8, "language-not-in-registry"),
        };
    };
    defer entry.deinit(allocator);

    if (entry.queryOnly) {
        return .{
            .language = try allocator.dupe(u8, language),
            .installed = false,
            .message = try allocator.dupe(u8, "query-only-language"),
        };
    }

    const grammar_root = try grammarRoot(allocator, configured_grammar_root);
    defer allocator.free(grammar_root);
    const install_dir = try std.fs.path.join(allocator, &.{ grammar_root, language });
    defer allocator.free(install_dir);
    const sources_root = try sourcesRoot(allocator, grammar_root);
    defer allocator.free(sources_root);
    const source_dir = try std.fs.path.join(allocator, &.{ sources_root, language });
    defer allocator.free(source_dir);
    const parser_dir = if (entry.location) |location| try std.fs.path.join(allocator, &.{ source_dir, location }) else try allocator.dupe(u8, source_dir);
    defer allocator.free(parser_dir);
    const parser_path = try std.fs.path.join(allocator, &.{ install_dir, parserFileName(language) });
    errdefer allocator.free(parser_path);
    const query_path = try std.fs.path.join(allocator, &.{ install_dir, "highlights.scm" });
    errdefer allocator.free(query_path);
    const injections_query_path = try std.fs.path.join(allocator, &.{ install_dir, "injections.scm" });
    defer allocator.free(injections_query_path);

    try progress.emit("Preparing grammar directories");
    try std.Io.Dir.createDirPath(.cwd(), io, grammar_root);
    try std.Io.Dir.createDirPath(.cwd(), io, sources_root);
    if (fileExists(io, source_dir)) try std.Io.Dir.deleteTree(.cwd(), io, source_dir);

    try progress.emit("Cloning grammar repository");
    if (try run(allocator, io, "clone grammar repository", &.{ "git", "clone", entry.url.?, source_dir })) |message| {
        allocator.free(parser_path);
        allocator.free(query_path);
        return failedInstall(allocator, language, message);
    }
    try progress.emit("Checking out grammar revision");
    if (try run(allocator, io, "checkout grammar revision", &.{ "git", "-C", source_dir, "checkout", "--detach", entry.revision.? })) |message| {
        allocator.free(parser_path);
        allocator.free(query_path);
        return failedInstall(allocator, language, message);
    }

    if (entry.generate) {
        try progress.emit("Generating parser source");
        if (try run(allocator, io, "generate parser source", &.{ "tree-sitter", "generate", parser_dir })) |message| {
            allocator.free(parser_path);
            allocator.free(query_path);
            return failedInstall(allocator, language, message);
        }
    }

    try progress.emit("Building parser library");
    try std.Io.Dir.createDirPath(.cwd(), io, install_dir);
    if (try run(allocator, io, "build parser", &.{ "tree-sitter", "build", "-o", parser_path, parser_dir })) |message| {
        allocator.free(parser_path);
        allocator.free(query_path);
        return failedInstall(allocator, language, message);
    }
    try progress.emit("Installing highlight query");
    installHighlightsQuery(io, allocator, source_dir, parser_dir, language, query_path) catch |err| {
        allocator.free(parser_path);
        allocator.free(query_path);
        return failedInstallFmt(allocator, language, "install highlights query failed: {s}", .{@errorName(err)});
    };
    try progress.emit("Installing injection query");
    try installInjectionsQuery(io, allocator, language, injections_query_path);
    try progress.emit("Grammar installed");

    return .{
        .language = try allocator.dupe(u8, language),
        .installed = true,
        .grammarPath = parser_path,
        .highlightsQueryPath = query_path,
        .message = try allocator.dupe(u8, "installed"),
    };
}

pub fn uninstallGrammar(allocator: std.mem.Allocator, io: std.Io, language: []const u8, configured_grammar_root: ?[]const u8) !UninstallResult {
    var entry = try registryEntry(allocator, language) orelse {
        return .{
            .language = try allocator.dupe(u8, language),
            .uninstalled = false,
            .message = try allocator.dupe(u8, "language-not-in-registry"),
        };
    };
    defer entry.deinit(allocator);

    if (entry.queryOnly) {
        return .{
            .language = try allocator.dupe(u8, language),
            .uninstalled = false,
            .message = try allocator.dupe(u8, "query-only-language"),
        };
    }

    const root = try grammarRoot(allocator, configured_grammar_root);
    defer allocator.free(root);
    const install_dir = try std.fs.path.join(allocator, &.{ root, language });
    defer allocator.free(install_dir);

    if (!fileExists(io, install_dir)) {
        return .{
            .language = try allocator.dupe(u8, language),
            .uninstalled = true,
            .message = try allocator.dupe(u8, "not-installed"),
        };
    }

    try std.Io.Dir.deleteTree(.cwd(), io, install_dir);
    return .{
        .language = try allocator.dupe(u8, language),
        .uninstalled = true,
        .message = try allocator.dupe(u8, "uninstalled"),
    };
}

pub fn listGrammars(allocator: std.mem.Allocator, io: std.Io, configured_grammar_root: ?[]const u8) ![]GrammarInfo {
    var parsed = try std.json.parseFromSlice(Registry, allocator, registry_json, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    const root = try grammarRoot(allocator, configured_grammar_root);
    defer allocator.free(root);

    var result = std.ArrayList(GrammarInfo).empty;
    errdefer {
        for (result.items) |*grammar| grammar.deinit(allocator);
        result.deinit(allocator);
    }

    for (parsed.value.languages) |entry| {
        if (entry.queryOnly) continue;

        var grammar = GrammarInfo{
            .id = try allocator.dupe(u8, entry.id),
            .url = if (entry.url) |value| try allocator.dupe(u8, value) else null,
            .revision = if (entry.revision) |value| try allocator.dupe(u8, value) else null,
            .requires = try dupeStringSlice(allocator, entry.requires orelse &.{}),
            .installed = false,
        };
        errdefer grammar.deinit(allocator);

        const language_dir = try std.fs.path.join(allocator, &.{ root, entry.id });
        defer allocator.free(language_dir);
        var parser_path: ?[]u8 = try std.fs.path.join(allocator, &.{ language_dir, parserFileName(entry.id) });
        errdefer if (parser_path) |path| allocator.free(path);
        var query_path: ?[]u8 = try std.fs.path.join(allocator, &.{ language_dir, "highlights.scm" });
        errdefer if (query_path) |path| allocator.free(path);

        if (fileExists(io, parser_path.?) and fileExists(io, query_path.?)) {
            grammar.installed = true;
            grammar.grammarPath = parser_path.?;
            grammar.highlightsQueryPath = query_path.?;
            parser_path = null;
            query_path = null;
        } else {
            allocator.free(parser_path.?);
            allocator.free(query_path.?);
            parser_path = null;
            query_path = null;
        }

        try result.append(allocator, grammar);
    }

    return result.toOwnedSlice(allocator);
}

fn buildSourceMap(allocator: std.mem.Allocator, rows: anytype, side: Side) !SourceMap {
    var max_line: u32 = 0;
    for (rows) |row| {
        const line = switch (side) {
            .old => row.old_line,
            .new => row.new_line,
        } orelse continue;
        max_line = @max(max_line, line);
    }

    if (max_line == 0) {
        return .{
            .source = try allocator.dupe(u8, ""),
            .line_lengths = try allocator.alloc(u32, 0),
        };
    }

    var line_texts = try allocator.alloc(?[]const u8, max_line);
    defer allocator.free(line_texts);
    @memset(line_texts, null);

    for (rows) |row| {
        const line = switch (side) {
            .old => row.old_line,
            .new => row.new_line,
        } orelse continue;
        const text = switch (side) {
            .old => row.old_text,
            .new => row.new_text,
        } orelse "";
        line_texts[line - 1] = text;
    }

    var source: std.ArrayList(u8) = .empty;
    errdefer source.deinit(allocator);
    var line_lengths = try allocator.alloc(u32, max_line);
    errdefer allocator.free(line_lengths);

    for (line_texts, 0..) |maybe_text, index| {
        const text = maybe_text orelse "";
        try source.appendSlice(allocator, text);
        line_lengths[index] = @intCast(text.len);
        if (index + 1 < line_texts.len) try source.append(allocator, '\n');
    }

    return .{
        .source = try source.toOwnedSlice(allocator),
        .line_lengths = line_lengths,
    };
}

fn highlightSource(allocator: std.mem.Allocator, io: std.Io, language: []const u8, grammar_path: []const u8, query_path: []const u8, source_map: SourceMap) ![]LineSpan {
    return highlightSourceDepth(allocator, io, language, grammar_path, query_path, source_map, 0, null);
}

fn highlightSourceRange(allocator: std.mem.Allocator, io: std.Io, cache: ?*Cache, language: []const u8, grammar_path: []const u8, query_path: []const u8, source_map: SourceMap, start_line: u32, end_line: u32) ![]LineSpan {
    return highlightSourceDepthCached(allocator, io, cache, language, grammar_path, query_path, source_map, 0, .{ .start = start_line, .end = end_line });
}

const HighlightLineRange = struct { start: u32, end: u32 };

fn highlightSourceDepth(allocator: std.mem.Allocator, io: std.Io, language: []const u8, grammar_path: []const u8, query_path: []const u8, source_map: SourceMap, depth: u8, range: ?HighlightLineRange) anyerror![]LineSpan {
    return highlightSourceDepthCached(allocator, io, null, language, grammar_path, query_path, source_map, depth, range);
}

fn highlightSourceDepthCached(allocator: std.mem.Allocator, io: std.Io, cache: ?*Cache, language: []const u8, grammar_path: []const u8, query_path: []const u8, source_map: SourceMap, depth: u8, range: ?HighlightLineRange) anyerror![]LineSpan {
    if (enable_direct_highlighter) {
        return highlightSourceDirect(allocator, io, cache, language, grammar_path, query_path, source_map, depth, range) catch
            highlightSourceCli(allocator, io, language, grammar_path, query_path, source_map, depth);
    }
    return highlightSourceCli(allocator, io, language, grammar_path, query_path, source_map, depth);
}

fn highlightSourceDirect(allocator: std.mem.Allocator, io: std.Io, cache: ?*Cache, language: []const u8, grammar_path: []const u8, query_path: []const u8, source_map: SourceMap, depth: u8, range: ?HighlightLineRange) ![]LineSpan {
    const cached = try directQuery(allocator, io, cache, language, grammar_path, query_path, .highlights);
    const ts_language = cached.ts_language;

    const parser = ts.Parser.create();
    defer parser.destroy();
    try parser.setLanguage(ts_language);

    const tree = parser.parseString(source_map.source, null) orelse return error.ParseFailed;
    defer tree.destroy();

    const query = cached.query;
    defer if (cache == null) query.destroy();

    const cursor = ts.QueryCursor.create();
    defer cursor.destroy();
    if (range) |line_range| {
        try cursor.setPointRange(.{ .row = if (line_range.start > 0) line_range.start - 1 else 0, .column = 0 }, .{ .row = line_range.end, .column = 0xFFFFFFFF });
    }
    cursor.exec(query, tree.rootNode());

    var result = std.ArrayList(LineSpan).empty;
    errdefer freeLineSpans(allocator, result.items);

    while (cursor.nextMatch()) |match| {
        const predicate_result = try evaluatePredicates(allocator, query, match, source_map.source);
        if (!predicate_result.matches) continue;
        for (match.captures) |capture| {
            const scope = query.captureNameForId(capture.index) orelse continue;
            if (!isVisibleCapture(scope)) continue;
            const start = capture.node.startPoint();
            const end = capture.node.endPoint();
            if (start.row != end.row or start.row >= source_map.line_lengths.len) continue;

            const line_length = source_map.line_lengths[start.row];
            const bounded_start = @min(start.column, line_length);
            const bounded_end = @min(end.column, line_length);
            if (bounded_end <= bounded_start) continue;

            try result.append(allocator, .{
                .line = start.row + 1,
                .span = .{
                    .startColumn = bounded_start,
                    .endColumn = bounded_end,
                    .scope = try allocator.dupe(u8, scope),
                },
            });
        }
    }

    if (depth < 4) {
        const injected = highlightInjectionsDirect(allocator, io, cache, language, grammar_path, ts_language, tree.rootNode(), source_map, depth) catch null;
        if (injected) |values| {
            defer freeLineSpans(allocator, values);
            for (values) |span| {
                try result.append(allocator, .{
                    .line = span.line,
                    .span = .{
                        .startColumn = span.span.startColumn,
                        .endColumn = span.span.endColumn,
                        .scope = try allocator.dupe(u8, span.span.scope),
                    },
                });
            }
        }
    }

    dedupeLineSpans(allocator, &result);
    return result.toOwnedSlice(allocator);
}

fn highlightSourceCli(allocator: std.mem.Allocator, io: std.Io, language: []const u8, grammar_path: []const u8, query_path: []const u8, source_map: SourceMap, depth: u8) anyerror![]LineSpan {
    temp_file_counter += 1;
    const temp_path = try std.fmt.allocPrint(allocator, "/tmp/diffuse-highlight-{d}.txt", .{temp_file_counter});
    defer allocator.free(temp_path);
    defer std.Io.Dir.deleteFile(.cwd(), io, temp_path) catch {};
    try std.Io.Dir.writeFile(.cwd(), io, .{ .sub_path = temp_path, .data = source_map.source });

    var runtime_query_path: ?[]u8 = null;
    defer if (runtime_query_path) |path| {
        std.Io.Dir.deleteFile(.cwd(), io, path) catch {};
        allocator.free(path);
    };
    const active_query_path = if (vendoredHighlightsQuery(language) != null) path: {
        temp_file_counter += 1;
        const path = try std.fmt.allocPrint(allocator, "/tmp/diffuse-highlight-query-{d}.scm", .{temp_file_counter});
        var query = std.ArrayList(u8).empty;
        defer query.deinit(allocator);
        try appendVendoredQuery(&query, allocator, language, 0);
        try std.Io.Dir.writeFile(.cwd(), io, .{ .sub_path = path, .data = query.items });
        runtime_query_path = path;
        break :path path;
    } else query_path;

    const output = try runOutput(allocator, io, &.{ "tree-sitter", "query", "--captures", "--lib-path", grammar_path, "--lang-name", language, active_query_path, temp_path });
    defer allocator.free(output);
    var result: std.ArrayList(LineSpan) = .empty;
    errdefer result.deinit(allocator);

    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |line| {
        if (parseCaptureLine(allocator, line, source_map.line_lengths) catch null) |span| {
            try result.append(allocator, span);
        }
    }

    if (depth < 4) {
        const injected = highlightInjections(allocator, io, language, grammar_path, source_map, temp_path, depth) catch null;
        if (injected) |values| {
            defer freeLineSpans(allocator, values);
            for (values) |span| {
                try result.append(allocator, .{
                    .line = span.line,
                    .span = .{
                        .startColumn = span.span.startColumn,
                        .endColumn = span.span.endColumn,
                        .scope = try allocator.dupe(u8, span.span.scope),
                    },
                });
            }
        }
    }

    dedupeLineSpans(allocator, &result);
    return result.toOwnedSlice(allocator);
}

fn highlightInjectionsDirect(allocator: std.mem.Allocator, io: std.Io, cache: ?*Cache, parent_language: []const u8, grammar_path: []const u8, ts_language: *const ts.Language, root_node: ts.Node, source_map: SourceMap, depth: u8) ![]LineSpan {
    _ = ts_language;
    const cached = try directQuery(allocator, io, cache, parent_language, grammar_path, "", .injections);
    const query = cached.query;
    defer if (cache == null) query.destroy();

    const cursor = ts.QueryCursor.create();
    defer cursor.destroy();
    cursor.exec(query, root_node);

    var ranges = try injectionRangesFromMatches(allocator, query, cursor, parent_language, source_map);
    defer {
        for (ranges.items) |*injection_range| injection_range.deinit(allocator);
        ranges.deinit(allocator);
    }

    const grammar_root = try grammarRootFromParserPath(allocator, grammar_path);
    defer allocator.free(grammar_root);

    var result = std.ArrayList(LineSpan).empty;
    errdefer result.deinit(allocator);
    for (ranges.items) |injection_range| {
        const injected_parser_path = try std.fs.path.join(allocator, &.{ grammar_root, injection_range.language, parserFileName(injection_range.language) });
        defer allocator.free(injected_parser_path);
        const injected_query_path = try std.fs.path.join(allocator, &.{ grammar_root, injection_range.language, "highlights.scm" });
        defer allocator.free(injected_query_path);
        if (!fileExists(io, injected_parser_path) or !fileExists(io, injected_query_path)) continue;

        var injected_source = try sourceMapRange(allocator, source_map, injection_range);
        defer injected_source.deinit(allocator);
        const spans = highlightSourceDepthCached(allocator, io, cache, injection_range.language, injected_parser_path, injected_query_path, injected_source, depth + 1, null) catch continue;
        defer freeLineSpans(allocator, spans);
        for (spans) |span| {
            try result.append(allocator, .{
                .line = injection_range.start_row + span.line,
                .span = .{
                    .startColumn = if (span.line == 1) injection_range.start_column + span.span.startColumn else span.span.startColumn,
                    .endColumn = if (span.line == 1) injection_range.start_column + span.span.endColumn else span.span.endColumn,
                    .scope = try allocator.dupe(u8, span.span.scope),
                },
            });
        }
    }
    return result.toOwnedSlice(allocator);
}

fn directQuery(allocator: std.mem.Allocator, io: std.Io, cache: ?*Cache, language: []const u8, grammar_path: []const u8, query_path: []const u8, kind: QueryKind) !DirectQuery {
    if (cache) |syntax_cache| return cachedDirectQuery(allocator, io, syntax_cache, language, grammar_path, query_path, kind);
    return error.SyntaxCacheRequired;
}

fn cachedDirectQuery(allocator: std.mem.Allocator, io: std.Io, cache: *Cache, language: []const u8, grammar_path: []const u8, query_path: []const u8, kind: QueryKind) !DirectQuery {
    const entry = try cacheEntry(allocator, cache, language, grammar_path);
    const slot = switch (kind) {
        .highlights => &entry.highlights_query,
        .injections => &entry.injections_query,
    };
    if (slot.* == null) {
        const query_source = try resolvedRuntimeQuery(allocator, io, language, query_path, kind);
        defer allocator.free(query_source);
        if (query_source.len == 0) return error.QueryNotFound;
        var error_offset: u32 = 0;
        slot.* = try ts.Query.create(entry.ts_language, query_source, &error_offset);
    }
    return .{ .ts_language = entry.ts_language, .query = slot.*.? };
}

fn cacheEntry(allocator: std.mem.Allocator, cache: *Cache, language: []const u8, grammar_path: []const u8) !*CacheEntry {
    for (cache.entries.items) |*entry| {
        if (std.mem.eql(u8, entry.language, language) and std.mem.eql(u8, entry.grammar_path, grammar_path)) return entry;
    }

    var library = try std.DynLib.open(grammar_path);
    errdefer library.close();
    const ts_language = try loadTreeSitterLanguage(allocator, &library, language);
    try cache.entries.append(cache.allocator, .{
        .language = try cache.allocator.dupe(u8, language),
        .grammar_path = try cache.allocator.dupe(u8, grammar_path),
        .library = library,
        .ts_language = ts_language,
    });
    return &cache.entries.items[cache.entries.items.len - 1];
}

fn loadTreeSitterLanguage(allocator: std.mem.Allocator, library: *std.DynLib, language: []const u8) !*const ts.Language {
    const LanguageFn = *const fn () callconv(.c) *const ts.Language;
    const symbol = try treeSitterSymbolName(allocator, language);
    defer allocator.free(symbol);
    const language_fn = library.lookup(LanguageFn, symbol) orelse return error.LanguageSymbolNotFound;
    return language_fn();
}

fn injectionRangesFromMatches(allocator: std.mem.Allocator, query: *const ts.Query, cursor: *ts.QueryCursor, parent_language: []const u8, source_map: SourceMap) !std.ArrayList(InjectionRange) {
    var result = std.ArrayList(InjectionRange).empty;
    errdefer {
        for (result.items) |*range| range.deinit(allocator);
        result.deinit(allocator);
    }

    while (cursor.nextMatch()) |match| {
        const predicate_result = try evaluatePredicates(allocator, query, match, source_map.source);
        if (!predicate_result.matches) continue;

        var language: ?[]const u8 = predicate_result.injection_language;
        for (match.captures) |capture| {
            const scope = query.captureNameForId(capture.index) orelse continue;
            if (!injectionLanguageCapture(scope)) continue;
            const text = nodeText(source_map.source, capture.node);
            if (normalizeInjectedLanguage(text)) |normalized| {
                language = normalized;
                break;
            }
        }

        for (match.captures) |capture| {
            const scope = query.captureNameForId(capture.index) orelse continue;
            if (!std.mem.eql(u8, scope, "injection.content")) continue;
            const start = capture.node.startPoint();
            const end = capture.node.endPoint();
            const injected_language = language orelse
                try htmlInjectedLanguage(allocator, source_map, start.row, start.column) orelse
                defaultInjectedLanguage(parent_language) orelse continue;
            try result.append(allocator, .{
                .language = try allocator.dupe(u8, injected_language),
                .start_row = start.row,
                .start_column = start.column,
                .end_row = end.row,
                .end_column = end.column,
            });
        }
    }

    return result;
}

fn evaluatePredicates(allocator: std.mem.Allocator, query: *const ts.Query, match: ts.Query.Match, source: []const u8) !PredicateResult {
    _ = allocator;
    var result = PredicateResult{};
    const steps = query.predicatesForPattern(match.pattern_index);
    var index: usize = 0;
    while (index < steps.len) {
        const start = index;
        while (index < steps.len and steps[index].type != .done) : (index += 1) {}
        const predicate = steps[start..index];
        if (index < steps.len) index += 1;
        if (predicate.len == 0) continue;
        if (predicate[0].type != .string) return .{ .matches = false };
        const op = query.stringValueForId(predicate[0].value_id) orelse return .{ .matches = false };

        if (std.mem.eql(u8, op, "set!")) {
            if (predicate.len >= 3 and predicate[1].type == .string and predicate[2].type == .string) {
                const key = query.stringValueForId(predicate[1].value_id) orelse continue;
                if (std.mem.eql(u8, key, "injection.language")) result.injection_language = query.stringValueForId(predicate[2].value_id);
            }
            continue;
        }
        if (std.mem.eql(u8, op, "is?") or std.mem.eql(u8, op, "is-not?")) continue;

        const predicate_matches = try evaluatePredicate(query, match, source, op, predicate[1..]);
        if (!predicate_matches) result.matches = false;
    }
    return result;
}

fn evaluatePredicate(query: *const ts.Query, match: ts.Query.Match, source: []const u8, op: []const u8, args: []const ts.Query.PredicateStep) !bool {
    if (args.len < 2 or args[0].type != .capture) return false;
    const capture_id = args[0].value_id;
    if (std.mem.eql(u8, op, "eq?") or std.mem.eql(u8, op, "not-eq?")) {
        if (args[1].type != .string) return false;
        const expected = query.stringValueForId(args[1].value_id) orelse return false;
        const matched = captureAnyTextEquals(match, source, capture_id, expected);
        return if (std.mem.eql(u8, op, "not-eq?")) !matched else matched;
    }
    if (std.mem.eql(u8, op, "any-of?") or std.mem.eql(u8, op, "not-any-of?")) {
        const matched = captureAnyTextIn(query, match, source, capture_id, args[1..]);
        return if (std.mem.eql(u8, op, "not-any-of?")) !matched else matched;
    }
    if (std.mem.eql(u8, op, "contains?") or std.mem.eql(u8, op, "any-contains?")) {
        if (args[1].type != .string) return false;
        const needle = query.stringValueForId(args[1].value_id) orelse return false;
        return captureAnyTextContains(match, source, capture_id, needle);
    }
    if (std.mem.eql(u8, op, "match?") or std.mem.eql(u8, op, "any-match?") or std.mem.eql(u8, op, "lua-match?")) {
        if (args[1].type != .string) return false;
        const pattern = query.stringValueForId(args[1].value_id) orelse return false;
        return captureAnyTextMatches(match, source, capture_id, pattern);
    }
    return false;
}

fn captureAnyTextEquals(match: ts.Query.Match, source: []const u8, capture_id: u32, expected: []const u8) bool {
    for (match.captures) |capture| {
        if (capture.index == capture_id and std.mem.eql(u8, nodeText(source, capture.node), expected)) return true;
    }
    return false;
}

fn captureAnyTextIn(query: *const ts.Query, match: ts.Query.Match, source: []const u8, capture_id: u32, args: []const ts.Query.PredicateStep) bool {
    for (args) |arg| {
        if (arg.type != .string) continue;
        const expected = query.stringValueForId(arg.value_id) orelse continue;
        if (captureAnyTextEquals(match, source, capture_id, expected)) return true;
    }
    return false;
}

fn captureAnyTextContains(match: ts.Query.Match, source: []const u8, capture_id: u32, needle: []const u8) bool {
    for (match.captures) |capture| {
        if (capture.index == capture_id and std.mem.indexOf(u8, nodeText(source, capture.node), needle) != null) return true;
    }
    return false;
}

fn captureAnyTextMatches(match: ts.Query.Match, source: []const u8, capture_id: u32, pattern: []const u8) bool {
    for (match.captures) |capture| {
        if (capture.index == capture_id and simplePatternMatches(nodeText(source, capture.node), pattern)) return true;
    }
    return false;
}

fn nodeText(source: []const u8, node: ts.Node) []const u8 {
    const start = @min(node.startByte(), source.len);
    const end = @min(node.endByte(), source.len);
    return if (end >= start) source[start..end] else "";
}

fn simplePatternMatches(text: []const u8, pattern: []const u8) bool {
    if (pattern.len == 0) return true;
    if (std.mem.startsWith(u8, pattern, "^")) {
        const body = pattern[1..];
        if (std.mem.eql(u8, body, "[A-Z]") or std.mem.startsWith(u8, body, "[A-Z]")) return text.len > 0 and asciiIsUpper(text[0]);
        if (std.mem.startsWith(u8, body, "[A-Z_]")) return text.len > 0 and (asciiIsUpper(text[0]) or text[0] == '_');
        if (std.mem.startsWith(u8, body, "[a-zA-Z]")) return text.len > 0 and std.ascii.isAlphabetic(text[0]);
        if (std.mem.startsWith(u8, body, "[a-z]+")) return text.len > 0 and std.ascii.isLower(text[0]);
        if (std.mem.startsWith(u8, body, "[*/]")) return text.len > 0 and (text[0] == '*' or text[0] == '/');
        const literal = trimPatternLiteral(body);
        return std.mem.startsWith(u8, text, literal);
    }
    const literal = trimPatternLiteral(pattern);
    return std.mem.indexOf(u8, text, literal) != null;
}

fn trimPatternLiteral(pattern: []const u8) []const u8 {
    var start: usize = 0;
    var end = pattern.len;
    if (end > start and pattern[end - 1] == '$') end -= 1;
    while (start < end and pattern[start] == '%') start += 1;
    return pattern[start..end];
}

fn asciiIsUpper(char: u8) bool {
    return char >= 'A' and char <= 'Z';
}

fn highlightInjections(allocator: std.mem.Allocator, io: std.Io, language: []const u8, grammar_path: []const u8, source_map: SourceMap, source_path: []const u8, depth: u8) anyerror![]LineSpan {
    if (vendoredInjectionsQuery(language) == null) return allocator.alloc(LineSpan, 0);
    const grammar_root = try grammarRootFromParserPath(allocator, grammar_path);
    defer allocator.free(grammar_root);

    temp_file_counter += 1;
    const query_path = try std.fmt.allocPrint(allocator, "/tmp/diffuse-injections-{d}.scm", .{temp_file_counter});
    defer allocator.free(query_path);
    defer std.Io.Dir.deleteFile(.cwd(), io, query_path) catch {};

    var resolved_query = std.ArrayList(u8).empty;
    defer resolved_query.deinit(allocator);
    try appendVendoredInjectionQuery(&resolved_query, allocator, language, 0);
    try std.Io.Dir.writeFile(.cwd(), io, .{ .sub_path = query_path, .data = resolved_query.items });

    const output = try runOutput(allocator, io, &.{ "tree-sitter", "query", "--captures", "--lib-path", grammar_path, "--lang-name", language, query_path, source_path });
    defer allocator.free(output);

    var ranges = try parseInjectionRanges(allocator, output, language, source_map);
    defer {
        for (ranges.items) |*range| range.deinit(allocator);
        ranges.deinit(allocator);
    }

    var result = std.ArrayList(LineSpan).empty;
    errdefer result.deinit(allocator);

    try highlightInjectionRangesBatched(allocator, io, grammar_root, source_map, ranges.items, depth, &result);

    return result.toOwnedSlice(allocator);
}

fn highlightInjectionRangesBatched(allocator: std.mem.Allocator, io: std.Io, grammar_root: []const u8, source_map: SourceMap, ranges: []InjectionRange, depth: u8, result: *std.ArrayList(LineSpan)) !void {
    var highlighted_languages = std.ArrayList([]const u8).empty;
    defer highlighted_languages.deinit(allocator);

    for (ranges) |range| {
        if (containsString(highlighted_languages.items, range.language)) continue;
        try highlighted_languages.append(allocator, range.language);
        try highlightInjectionLanguageRanges(allocator, io, grammar_root, source_map, ranges, range.language, depth, result);
    }
}

fn highlightInjectionLanguageRanges(allocator: std.mem.Allocator, io: std.Io, grammar_root: []const u8, source_map: SourceMap, ranges: []InjectionRange, language: []const u8, depth: u8, result: *std.ArrayList(LineSpan)) !void {
    const injected_parser_path = try std.fs.path.join(allocator, &.{ grammar_root, language, parserFileName(language) });
    defer allocator.free(injected_parser_path);
    const injected_query_path = try std.fs.path.join(allocator, &.{ grammar_root, language, "highlights.scm" });
    defer allocator.free(injected_query_path);
    if (!fileExists(io, injected_parser_path) or !fileExists(io, injected_query_path)) return;

    var combined = std.ArrayList(u8).empty;
    defer combined.deinit(allocator);
    var combined_line_lengths = std.ArrayList(u32).empty;
    defer combined_line_lengths.deinit(allocator);
    var segments = std.ArrayList(InjectionSegment).empty;
    defer {
        for (segments.items) |*segment| segment.deinit(allocator);
        segments.deinit(allocator);
    }

    for (ranges) |range| {
        if (!std.mem.eql(u8, range.language, language)) continue;
        var injected_source = try sourceMapRange(allocator, source_map, range);
        defer injected_source.deinit(allocator);
        if (injected_source.source.len == 0) continue;

        if (combined.items.len > 0) {
            try combined.append(allocator, '\n');
        }
        const start_line: u32 = @intCast(combined_line_lengths.items.len + 1);
        try combined.appendSlice(allocator, injected_source.source);
        try combined_line_lengths.appendSlice(allocator, injected_source.line_lengths);
        try segments.append(allocator, .{
            .range = .{
                .language = try allocator.dupe(u8, range.language),
                .start_row = range.start_row,
                .start_column = range.start_column,
                .end_row = range.end_row,
                .end_column = range.end_column,
            },
            .start_line = start_line,
            .line_count = @intCast(injected_source.line_lengths.len),
        });
    }

    if (combined.items.len == 0) return;
    var combined_source = SourceMap{
        .source = try combined.toOwnedSlice(allocator),
        .line_lengths = try combined_line_lengths.toOwnedSlice(allocator),
    };
    defer combined_source.deinit(allocator);

        const spans = highlightSourceDepth(allocator, io, language, injected_parser_path, injected_query_path, combined_source, depth + 1, null) catch return;
    defer freeLineSpans(allocator, spans);
    for (spans) |span| {
        const segment = injectionSegmentForLine(segments.items, span.line) orelse continue;
        const local_line = span.line - segment.start_line + 1;
        try result.append(allocator, .{
            .line = segment.range.start_row + local_line,
            .span = .{
                .startColumn = if (local_line == 1) segment.range.start_column + span.span.startColumn else span.span.startColumn,
                .endColumn = if (local_line == 1) segment.range.start_column + span.span.endColumn else span.span.endColumn,
                .scope = try allocator.dupe(u8, span.span.scope),
            },
        });
    }
}

fn injectionSegmentForLine(segments: []InjectionSegment, line: u32) ?InjectionSegment {
    for (segments) |segment| {
        if (line >= segment.start_line and line < segment.start_line + segment.line_count) return segment;
    }
    return null;
}

fn containsString(values: []const []const u8, needle: []const u8) bool {
    for (values) |value| if (std.mem.eql(u8, value, needle)) return true;
    return false;
}

fn parseCaptureLine(allocator: std.mem.Allocator, line: []const u8, line_lengths: []const u32) !?LineSpan {
    const capture = try parseCapture(allocator, line) orelse return null;
    defer {
        var mutable = capture;
        mutable.deinit(allocator);
    }
    if (capture.start_row != capture.end_row or capture.start_row >= line_lengths.len) return null;

    const line_length = line_lengths[capture.start_row];
    const bounded_start = @min(capture.start_column, line_length);
    const bounded_end = @min(capture.end_column, line_length);
    if (bounded_end <= bounded_start) return null;

    return .{
        .line = capture.start_row + 1,
        .span = .{
            .startColumn = bounded_start,
            .endColumn = bounded_end,
            .scope = try allocator.dupe(u8, capture.scope),
        },
    };
}

fn parseCapture(allocator: std.mem.Allocator, line: []const u8) !?Capture {
    const pattern_marker = "pattern:";
    const pattern_start = (std.mem.indexOf(u8, line, pattern_marker) orelse return null) + pattern_marker.len;
    const pattern_comma = std.mem.indexOfPos(u8, line, pattern_start, ",") orelse return null;
    const pattern_text = std.mem.trim(u8, line[pattern_start..pattern_comma], " ");
    const scope_start_marker = " - ";
    const scope_start = (std.mem.indexOf(u8, line, scope_start_marker) orelse return null) + scope_start_marker.len;
    const scope_end = std.mem.indexOfPos(u8, line, scope_start, ", start:") orelse return null;
    const start_marker = "start: (";
    const start_pos = (std.mem.indexOfPos(u8, line, scope_end, start_marker) orelse return null) + start_marker.len;
    const start_comma = std.mem.indexOfPos(u8, line, start_pos, ", ") orelse return null;
    const start_close = std.mem.indexOfPos(u8, line, start_comma, ")") orelse return null;
    const end_marker = "end: (";
    const end_pos = (std.mem.indexOfPos(u8, line, start_close, end_marker) orelse return null) + end_marker.len;
    const end_comma = std.mem.indexOfPos(u8, line, end_pos, ", ") orelse return null;
    const end_close = std.mem.indexOfPos(u8, line, end_comma, ")") orelse return null;

    return .{
        .pattern = try std.fmt.parseInt(u32, pattern_text, 10),
        .scope = try allocator.dupe(u8, line[scope_start..scope_end]),
        .start_row = try std.fmt.parseInt(u32, line[start_pos..start_comma], 10),
        .start_column = try std.fmt.parseInt(u32, line[start_comma + 2 .. start_close], 10),
        .end_row = try std.fmt.parseInt(u32, line[end_pos..end_comma], 10),
        .end_column = try std.fmt.parseInt(u32, line[end_comma + 2 .. end_close], 10),
    };
}

fn parseInjectionRanges(allocator: std.mem.Allocator, output: []const u8, parent_language: []const u8, source_map: SourceMap) !std.ArrayList(InjectionRange) {
    var result = std.ArrayList(InjectionRange).empty;
    errdefer {
        for (result.items) |*range| range.deinit(allocator);
        result.deinit(allocator);
    }

    var language_by_pattern = std.AutoHashMap(u32, []const u8).init(allocator);
    defer {
        var iter = language_by_pattern.valueIterator();
        while (iter.next()) |value| allocator.free(value.*);
        language_by_pattern.deinit();
    }

    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |line| {
        var capture = try parseCapture(allocator, line) orelse continue;
        defer capture.deinit(allocator);

        if (injectionLanguageCapture(capture.scope)) {
            const raw_language = try sourceText(allocator, source_map, capture.start_row, capture.start_column, capture.end_row, capture.end_column);
            defer allocator.free(raw_language);
            if (normalizeInjectedLanguage(raw_language)) |normalized| {
                if (language_by_pattern.fetchRemove(capture.pattern)) |old| allocator.free(old.value);
                try language_by_pattern.put(capture.pattern, try allocator.dupe(u8, normalized));
            }
        }

        if (std.mem.eql(u8, capture.scope, "injection.content")) {
            const injected_language = language_by_pattern.get(capture.pattern) orelse
                try htmlInjectedLanguage(allocator, source_map, capture.start_row, capture.start_column) orelse
                defaultInjectedLanguage(parent_language) orelse continue;
            try result.append(allocator, .{
                .language = try allocator.dupe(u8, injected_language),
                .start_row = capture.start_row,
                .start_column = capture.start_column,
                .end_row = capture.end_row,
                .end_column = capture.end_column,
            });
        }
    }

    return result;
}

fn injectionLanguageCapture(scope: []const u8) bool {
    return std.mem.eql(u8, scope, "injection.language") or
        std.mem.eql(u8, scope, "_js") or
        std.mem.eql(u8, scope, "_ts") or
        std.mem.eql(u8, scope, "_scss");
}

fn defaultInjectedLanguage(parent_language: []const u8) ?[]const u8 {
    // Vue interpolation and directive expressions use TypeScript-compatible expressions.
    if (std.mem.eql(u8, parent_language, "vue")) return "typescript";
    return null;
}

fn htmlInjectedLanguage(allocator: std.mem.Allocator, source_map: SourceMap, row: u32, column: u32) !?[]const u8 {
    const content_start = try sourceOffset(source_map, row, column);
    if (content_start == 0) return null;

    var scan = content_start;
    while (scan > 0) {
        scan -= 1;
        if (source_map.source[scan] != '<') continue;
        if (std.mem.startsWith(u8, source_map.source[scan..], "<script")) {
            const tag = try htmlStartTag(allocator, source_map.source[scan..content_start]);
            defer allocator.free(tag);
            return htmlScriptLanguage(tag);
        }
        if (std.mem.startsWith(u8, source_map.source[scan..], "<style")) {
            const tag = try htmlStartTag(allocator, source_map.source[scan..content_start]);
            defer allocator.free(tag);
            return htmlStyleLanguage(tag);
        }
        if (content_start - scan > 512) break;
    }

    return null;
}

fn htmlStartTag(allocator: std.mem.Allocator, source: []const u8) ![]u8 {
    const end = std.mem.indexOfScalar(u8, source, '>') orelse source.len;
    return allocator.dupe(u8, source[0..end]);
}

fn htmlScriptLanguage(tag: []const u8) ?[]const u8 {
    if (tagAttributeValue(tag, "lang")) |lang| {
        if (normalizeInjectedLanguage(lang)) |language| return language;
    }
    if (tagAttributeValue(tag, "type")) |value| {
        if (std.mem.eql(u8, value, "module")) return "javascript";
        if (std.mem.eql(u8, value, "importmap")) return "json";
        if (std.mem.indexOfScalar(u8, value, '/')) |slash| return normalizeInjectedLanguage(value[slash + 1 ..]);
    }
    return "javascript";
}

fn htmlStyleLanguage(tag: []const u8) ?[]const u8 {
    if (tagAttributeValue(tag, "lang")) |lang| {
        if (normalizeInjectedLanguage(lang)) |language| return language;
    }
    if (tagAttributeValue(tag, "type")) |value| {
        if (std.mem.eql(u8, value, "text/css")) return "css";
    }
    return "css";
}

fn tagAttributeValue(tag: []const u8, name: []const u8) ?[]const u8 {
    var index: usize = 0;
    while (std.mem.indexOfPos(u8, tag, index, name)) |name_start| {
        const after_name = name_start + name.len;
        if (after_name >= tag.len or tag[after_name] != '=') {
            index = after_name;
            continue;
        }
        const value_start = after_name + 1;
        if (value_start >= tag.len) return null;
        const quote = tag[value_start];
        if (quote == '"' or quote == '\'') {
            const content_start = value_start + 1;
            const content_end = std.mem.indexOfScalarPos(u8, tag, content_start, quote) orelse return null;
            return tag[content_start..content_end];
        }
        const value_end = std.mem.indexOfAnyPos(u8, tag, value_start, " \t\r\n>") orelse tag.len;
        return tag[value_start..value_end];
    }
    return null;
}

fn normalizeInjectedLanguage(raw_language: []const u8) ?[]const u8 {
    const language = std.mem.trim(u8, raw_language, " \t\r\n\"'");
    if (std.mem.eql(u8, language, "js")) return "javascript";
    if (std.mem.eql(u8, language, "ts")) return "typescript";
    if (std.mem.eql(u8, language, "css")) return "css";
    if (std.mem.eql(u8, language, "scss") or std.mem.eql(u8, language, "sass") or std.mem.eql(u8, language, "less") or std.mem.eql(u8, language, "postcss")) return "scss";
    if (std.mem.eql(u8, language, "tsx")) return "tsx";
    if (std.mem.eql(u8, language, "jsx")) return "javascript";
    return null;
}

fn sourceMapRange(allocator: std.mem.Allocator, source_map: SourceMap, range: InjectionRange) !SourceMap {
    const start = try sourceOffset(source_map, range.start_row, range.start_column);
    const end = try sourceOffset(source_map, range.end_row, range.end_column);
    if (end <= start) {
        return .{ .source = try allocator.dupe(u8, ""), .line_lengths = try allocator.alloc(u32, 0) };
    }

    const source = try allocator.dupe(u8, source_map.source[start..end]);
    errdefer allocator.free(source);
    const line_lengths = try lineLengths(allocator, source);
    return .{ .source = source, .line_lengths = line_lengths };
}

fn sourceText(allocator: std.mem.Allocator, source_map: SourceMap, start_row: u32, start_column: u32, end_row: u32, end_column: u32) ![]u8 {
    const start = try sourceOffset(source_map, start_row, start_column);
    const end = try sourceOffset(source_map, end_row, end_column);
    if (end <= start) return allocator.dupe(u8, "");
    return allocator.dupe(u8, source_map.source[start..end]);
}

fn sourceOffset(source_map: SourceMap, row: u32, column: u32) !usize {
    if (row > source_map.line_lengths.len) return error.InvalidSourceRange;
    var offset: usize = 0;
    var index: usize = 0;
    while (index < row) : (index += 1) offset += source_map.line_lengths[index] + 1;
    if (row == source_map.line_lengths.len) return offset;
    return offset + @min(column, source_map.line_lengths[row]);
}

fn lineLengths(allocator: std.mem.Allocator, source: []const u8) ![]u32 {
    var lengths = std.ArrayList(u32).empty;
    errdefer lengths.deinit(allocator);
    var start: usize = 0;
    var index: usize = 0;
    while (index < source.len) : (index += 1) {
        if (source[index] == '\n') {
            try lengths.append(allocator, @intCast(index - start));
            start = index + 1;
        }
    }
    try lengths.append(allocator, @intCast(source.len - start));
    return lengths.toOwnedSlice(allocator);
}

fn attachSpans(allocator: std.mem.Allocator, rows: anytype, side: Side, spans: []LineSpan) !void {
    for (rows.items) |*row| {
        const line = switch (side) {
            .old => row.old_line,
            .new => row.new_line,
        } orelse continue;

        var count: usize = 0;
        for (spans) |line_span| {
            if (line_span.line == line) count += 1;
        }
        if (count == 0) continue;

        var row_spans = try allocator.alloc(SyntaxSpan, count);
        var index: usize = 0;
        for (spans) |line_span| {
            if (line_span.line != line) continue;
            row_spans[index] = .{
                .startColumn = line_span.span.startColumn,
                .endColumn = line_span.span.endColumn,
                .scope = try allocator.dupe(u8, line_span.span.scope),
            };
            index += 1;
        }

        switch (side) {
            .old => row.old_syntax_spans = row_spans,
            .new => row.new_syntax_spans = row_spans,
        }
    }
}

fn groupLineSpans(allocator: std.mem.Allocator, spans: []LineSpan, start_line: u32, end_line: u32) ![]SyntaxLineSpans {
    var result = std.ArrayList(SyntaxLineSpans).empty;
    errdefer {
        for (result.items) |line| {
            for (line.spans) |span| allocator.free(span.scope);
            allocator.free(line.spans);
        }
        result.deinit(allocator);
    }

    var line = start_line;
    while (line <= end_line) : (line += 1) {
        var count: usize = 0;
        for (spans) |span| {
            if (span.line == line) count += 1;
        }
        if (count == 0) continue;

        const line_spans = try allocator.alloc(SyntaxSpan, count);
        errdefer allocator.free(line_spans);
        var index: usize = 0;
        for (spans) |span| {
            if (span.line != line) continue;
            line_spans[index] = .{
                .startColumn = span.span.startColumn,
                .endColumn = span.span.endColumn,
                .scope = try allocator.dupe(u8, span.span.scope),
            };
            index += 1;
        }
        try result.append(allocator, .{ .line = line, .spans = line_spans });
    }

    return result.toOwnedSlice(allocator);
}

fn freeLineSpans(allocator: std.mem.Allocator, spans: []LineSpan) void {
    for (spans) |span| allocator.free(span.span.scope);
    allocator.free(spans);
}

fn dedupeLineSpans(allocator: std.mem.Allocator, spans: *std.ArrayList(LineSpan)) void {
    var index: usize = 0;
    while (index < spans.items.len) {
        if (hasEarlierLineSpan(spans.items, index)) {
            allocator.free(spans.items[index].span.scope);
            _ = spans.orderedRemove(index);
            continue;
        }
        index += 1;
    }
}

fn hasEarlierLineSpan(spans: []const LineSpan, index: usize) bool {
    const current = spans[index];
    for (spans[0..index]) |span| {
        if (span.line == current.line and
            span.span.startColumn == current.span.startColumn and
            span.span.endColumn == current.span.endColumn and
            std.mem.eql(u8, span.span.scope, current.span.scope)) return true;
    }
    return false;
}

fn failedInstall(allocator: std.mem.Allocator, language: []const u8, message: []u8) !InstallResult {
    return .{
        .language = try allocator.dupe(u8, language),
        .installed = false,
        .message = message,
    };
}

fn failedInstallFmt(allocator: std.mem.Allocator, language: []const u8, comptime format: []const u8, args: anytype) !InstallResult {
    return failedInstall(allocator, language, try std.fmt.allocPrint(allocator, format, args));
}

pub fn detectStatus(allocator: std.mem.Allocator, io: std.Io, path: []const u8, configured_grammar_root: ?[]const u8) !SyntaxStatus {
    const language = detectLanguage(path) orelse {
        return .{ .missingReason = try allocator.dupe(u8, "unsupported-language") };
    };

    var status = SyntaxStatus{ .language = try allocator.dupe(u8, language) };
    errdefer status.deinit(allocator);

    const grammar_root = try grammarRoot(allocator, configured_grammar_root);
    defer allocator.free(grammar_root);

    const language_dir = try std.fs.path.join(allocator, &.{ grammar_root, language });
    defer allocator.free(language_dir);

    const parser_path = try std.fs.path.join(allocator, &.{ language_dir, parserFileName(language) });
    errdefer allocator.free(parser_path);
    const query_path = try std.fs.path.join(allocator, &.{ language_dir, "highlights.scm" });
    errdefer allocator.free(query_path);

    if (!fileExists(io, parser_path)) {
        allocator.free(parser_path);
        allocator.free(query_path);
        status.missingReason = try allocator.dupe(u8, "grammar-not-installed");
        return status;
    }

    if (!fileExists(io, query_path)) {
        allocator.free(parser_path);
        allocator.free(query_path);
        status.missingReason = try allocator.dupe(u8, "highlights-query-not-installed");
        return status;
    }

    status.grammarInstalled = true;
    status.grammarPath = parser_path;
    status.highlightsQueryPath = query_path;
    return status;
}

fn detectLanguage(path: []const u8) ?[]const u8 {
    const basename = std.fs.path.basename(path);
    if (std.mem.eql(u8, basename, "Dockerfile")) return "dockerfile";
    if (std.mem.eql(u8, basename, "Makefile")) return "make";

    const ext = std.fs.path.extension(path);
    if (ext.len == 0) return null;

    if (std.mem.eql(u8, ext, ".bash") or std.mem.eql(u8, ext, ".sh")) return "bash";
    if (std.mem.eql(u8, ext, ".c")) return "c";
    if (std.mem.eql(u8, ext, ".cc") or std.mem.eql(u8, ext, ".cpp") or std.mem.eql(u8, ext, ".cxx") or std.mem.eql(u8, ext, ".hpp")) return "cpp";
    if (std.mem.eql(u8, ext, ".css")) return "css";
    if (std.mem.eql(u8, ext, ".go")) return "go";
    if (std.mem.eql(u8, ext, ".html")) return "html";
    if (std.mem.eql(u8, ext, ".java")) return "java";
    if (std.mem.eql(u8, ext, ".js") or std.mem.eql(u8, ext, ".jsx") or std.mem.eql(u8, ext, ".mjs") or std.mem.eql(u8, ext, ".cjs")) return "javascript";
    if (std.mem.eql(u8, ext, ".json")) return "json";
    if (std.mem.eql(u8, ext, ".md") or std.mem.eql(u8, ext, ".markdown")) return "markdown";
    if (std.mem.eql(u8, ext, ".py")) return "python";
    if (std.mem.eql(u8, ext, ".rs")) return "rust";
    if (std.mem.eql(u8, ext, ".scss")) return "scss";
    if (std.mem.eql(u8, ext, ".ts")) return "typescript";
    if (std.mem.eql(u8, ext, ".tsx")) return "tsx";
    if (std.mem.eql(u8, ext, ".vue")) return "vue";
    if (std.mem.eql(u8, ext, ".yaml") or std.mem.eql(u8, ext, ".yml")) return "yaml";
    if (std.mem.eql(u8, ext, ".zig")) return "zig";

    return null;
}

fn grammarRoot(allocator: std.mem.Allocator, configured_grammar_root: ?[]const u8) ![]u8 {
    const root = configured_grammar_root orelse ".diffuse/grammars";
    return allocator.dupe(u8, root);
}

fn parserFileName(language: []const u8) []const u8 {
    _ = language;
    return switch (builtin.os.tag) {
        .windows => "parser.dll",
        .macos => "parser.dylib",
        else => "parser.so",
    };
}

fn sourcesRoot(allocator: std.mem.Allocator, grammar_root: []const u8) ![]u8 {
    const parent = std.fs.path.dirname(grammar_root) orelse grammar_root;
    return std.fs.path.join(allocator, &.{ parent, "sources" });
}

fn registryEntry(allocator: std.mem.Allocator, language: []const u8) !?OwnedRegistryLanguage {
    var parsed = try std.json.parseFromSlice(Registry, allocator, registry_json, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    for (parsed.value.languages) |entry| {
        if (std.mem.eql(u8, entry.id, language)) {
            return .{
                .id = try allocator.dupe(u8, entry.id),
                .url = if (entry.url) |value| try allocator.dupe(u8, value) else null,
                .revision = if (entry.revision) |value| try allocator.dupe(u8, value) else null,
                .location = if (entry.location) |value| try allocator.dupe(u8, value) else null,
                .requires = try dupeStringSlice(allocator, entry.requires orelse &.{}),
                .queryOnly = entry.queryOnly,
                .generate = entry.generate,
            };
        }
    }
    return null;
}

fn installHighlightsQuery(io: std.Io, allocator: std.mem.Allocator, source_dir: []const u8, parser_dir: []const u8, language: []const u8, dest_path: []const u8) !void {
    var query = std.ArrayList(u8).empty;
    defer query.deinit(allocator);

    if (vendoredHighlightsQuery(language) != null) {
        try appendVendoredQuery(&query, allocator, language, 0);
    } else {
        const language_query = try readSourceQuery(allocator, io, source_dir, parser_dir, language) orelse return error.HighlightsQueryNotFound;
        defer allocator.free(language_query);
        try appendQuery(&query, allocator, language, language_query);
    }

    try std.Io.Dir.writeFile(.cwd(), io, .{ .sub_path = dest_path, .data = query.items });
}

fn installInjectionsQuery(io: std.Io, allocator: std.mem.Allocator, language: []const u8, dest_path: []const u8) !void {
    if (vendoredInjectionsQuery(language) == null) return;
    var query = std.ArrayList(u8).empty;
    defer query.deinit(allocator);
    try appendVendoredInjectionQuery(&query, allocator, language, 0);
    try std.Io.Dir.writeFile(.cwd(), io, .{ .sub_path = dest_path, .data = query.items });
}

fn readSourceQuery(allocator: std.mem.Allocator, io: std.Io, source_dir: []const u8, parser_dir: []const u8, language: []const u8) !?[]u8 {
    const candidates = [_][]const []const u8{
        &.{ parser_dir, "queries", "highlights.scm" },
        &.{ parser_dir, "queries", language, "highlights.scm" },
        &.{ source_dir, "queries", "highlights.scm" },
        &.{ source_dir, "queries", language, "highlights.scm" },
    };

    for (candidates) |candidate| {
        const path = try std.fs.path.join(allocator, candidate);
        defer allocator.free(path);
        if (fileExists(io, path)) return try std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(1024 * 1024));
    }

    return null;
}

fn appendQuery(query: *std.ArrayList(u8), allocator: std.mem.Allocator, name: []const u8, source: []const u8) !void {
    try query.appendSlice(allocator, "; diffuse query: ");
    try query.appendSlice(allocator, name);
    try query.appendSlice(allocator, "\n");
    try appendSanitizedQuerySource(query, allocator, source);
    if (source.len == 0 or source[source.len - 1] != '\n') try query.append(allocator, '\n');
    try query.append(allocator, '\n');
}

fn appendSanitizedQuerySource(query: *std.ArrayList(u8), allocator: std.mem.Allocator, source: []const u8) !void {
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |line| {
        if (unsupportedQueryLine(line)) {
            try appendPreservedClosingParens(query, allocator, line);
            continue;
        }
        try query.appendSlice(allocator, line);
        try query.append(allocator, '\n');
    }
}

fn appendPreservedClosingParens(query: *std.ArrayList(u8), allocator: std.mem.Allocator, line: []const u8) !void {
    var close_count: usize = 0;
    var index = line.len;
    while (index > 0) {
        index -= 1;
        if (line[index] == ')') close_count += 1 else break;
    }
    if (close_count <= 1) return;
    var remaining = close_count - 1;
    while (remaining > 0) : (remaining -= 1) try query.append(allocator, ')');
    try query.append(allocator, '\n');
}

fn unsupportedQueryLine(line: []const u8) bool {
    // These nvim-treesitter directives are editor metadata/transforms. The standalone
    // tree-sitter CLI rejects some forms, and Diffuse does not need them for coloring.
    return std.mem.indexOf(u8, line, "(#set! @") != null or
        std.mem.indexOf(u8, line, "(#offset!") != null or
        std.mem.indexOf(u8, line, "(#gsub!") != null or
        std.mem.indexOf(u8, line, "(#strip!") != null;
}

fn appendVendoredQuery(query: *std.ArrayList(u8), allocator: std.mem.Allocator, language: []const u8, depth: u8) !void {
    if (depth > 16) return error.QueryInheritanceTooDeep;
    const source = vendoredHighlightsQuery(language) orelse return error.HighlightsQueryNotFound;

    var inherits = try queryInherits(allocator, source);
    defer inherits.deinit(allocator);
    for (inherits.items) |dependency| {
        defer allocator.free(dependency);
        try appendVendoredQuery(query, allocator, dependency, depth + 1);
    }

    try appendQuery(query, allocator, language, source);
}

fn queryInherits(allocator: std.mem.Allocator, source: []const u8) !std.ArrayList([]const u8) {
    var result = std.ArrayList([]const u8).empty;
    errdefer {
        for (result.items) |value| allocator.free(value);
        result.deinit(allocator);
    }

    const first_line_end = std.mem.indexOfScalar(u8, source, '\n') orelse source.len;
    const first_line = std.mem.trim(u8, source[0..first_line_end], " \t\r");
    const marker = "; inherits:";
    if (!std.mem.startsWith(u8, first_line, marker)) return result;

    var iter = std.mem.splitScalar(u8, first_line[marker.len..], ',');
    while (iter.next()) |part| {
        const name = std.mem.trim(u8, part, " \t\r");
        if (name.len > 0) try result.append(allocator, try allocator.dupe(u8, name));
    }
    return result;
}

fn vendoredHighlightsQuery(language: []const u8) ?[]const u8 {
    if (std.mem.eql(u8, language, "bash")) return bash_highlights;
    if (std.mem.eql(u8, language, "c")) return c_highlights;
    if (std.mem.eql(u8, language, "cpp")) return cpp_highlights;
    if (std.mem.eql(u8, language, "css")) return css_highlights;
    if (std.mem.eql(u8, language, "dockerfile")) return dockerfile_highlights;
    if (std.mem.eql(u8, language, "ecma")) return ecma_highlights;
    if (std.mem.eql(u8, language, "go")) return go_highlights;
    if (std.mem.eql(u8, language, "html")) return html_highlights;
    if (std.mem.eql(u8, language, "html_tags")) return html_tags_highlights;
    if (std.mem.eql(u8, language, "java")) return java_highlights;
    if (std.mem.eql(u8, language, "javascript")) return javascript_highlights;
    if (std.mem.eql(u8, language, "json")) return json_highlights;
    if (std.mem.eql(u8, language, "jsx")) return jsx_highlights;
    if (std.mem.eql(u8, language, "make")) return make_highlights;
    if (std.mem.eql(u8, language, "markdown")) return markdown_highlights;
    if (std.mem.eql(u8, language, "markdown_inline")) return markdown_inline_highlights;
    if (std.mem.eql(u8, language, "python")) return python_highlights;
    if (std.mem.eql(u8, language, "rust")) return rust_highlights;
    if (std.mem.eql(u8, language, "scss")) return scss_highlights;
    if (std.mem.eql(u8, language, "tsx")) return tsx_highlights;
    if (std.mem.eql(u8, language, "typescript")) return typescript_highlights;
    if (std.mem.eql(u8, language, "vue")) return vue_highlights;
    if (std.mem.eql(u8, language, "yaml")) return yaml_highlights;
    if (std.mem.eql(u8, language, "zig")) return zig_highlights;
    return null;
}

fn appendVendoredInjectionQuery(query: *std.ArrayList(u8), allocator: std.mem.Allocator, language: []const u8, depth: u8) !void {
    if (depth > 16) return error.QueryInheritanceTooDeep;
    const source = vendoredInjectionsQuery(language) orelse return error.InjectionsQueryNotFound;

    var inherits = try queryInherits(allocator, source);
    defer inherits.deinit(allocator);
    for (inherits.items) |dependency| {
        defer allocator.free(dependency);
        if (vendoredInjectionsQuery(dependency) != null) try appendVendoredInjectionQuery(query, allocator, dependency, depth + 1);
    }

    try appendQuery(query, allocator, language, source);
}

fn vendoredInjectionsQuery(language: []const u8) ?[]const u8 {
    if (std.mem.eql(u8, language, "html_tags")) return html_tags_injections;
    if (std.mem.eql(u8, language, "vue")) return vue_injections;
    return null;
}

fn resolvedRuntimeQuery(allocator: std.mem.Allocator, io: std.Io, language: []const u8, query_path: []const u8, kind: QueryKind) ![]u8 {
    var query = std.ArrayList(u8).empty;
    errdefer query.deinit(allocator);
    switch (kind) {
        .highlights => if (vendoredHighlightsQuery(language) != null) {
            try appendVendoredQuery(&query, allocator, language, 0);
        } else if (query_path.len > 0) {
            const source = try std.Io.Dir.readFileAlloc(.cwd(), io, query_path, allocator, .limited(1024 * 1024));
            defer allocator.free(source);
            try appendSanitizedQuerySource(&query, allocator, source);
        },
        .injections => if (vendoredInjectionsQuery(language) != null) {
            try appendVendoredInjectionQuery(&query, allocator, language, 0);
        },
    }
    return query.toOwnedSlice(allocator);
}

fn treeSitterSymbolName(allocator: std.mem.Allocator, language: []const u8) ![:0]u8 {
    var result = std.ArrayList(u8).empty;
    errdefer result.deinit(allocator);
    try result.appendSlice(allocator, "tree_sitter_");
    for (language) |char| try result.append(allocator, if (char == '-') '_' else char);
    return result.toOwnedSliceSentinel(allocator, 0);
}

fn isVisibleCapture(scope: []const u8) bool {
    return !std.mem.eql(u8, scope, "none") and !std.mem.eql(u8, scope, "nospell") and !std.mem.startsWith(u8, scope, "_");
}

fn grammarRootFromParserPath(allocator: std.mem.Allocator, parser_path: []const u8) ![]u8 {
    const language_dir = std.fs.path.dirname(parser_path) orelse return error.InvalidParserPath;
    const grammar_root_path = std.fs.path.dirname(language_dir) orelse return error.InvalidParserPath;
    return allocator.dupe(u8, grammar_root_path);
}

fn dupeStringSlice(allocator: std.mem.Allocator, values: []const []const u8) ![]const []const u8 {
    const result = try allocator.alloc([]const u8, values.len);
    errdefer allocator.free(result);
    for (values, 0..) |value, index| result[index] = try allocator.dupe(u8, value);
    return result;
}

fn run(allocator: std.mem.Allocator, io: std.Io, step: []const u8, argv: []const []const u8) !?[]u8 {
    const result = try std.process.run(allocator, io, .{
        .argv = argv,
        .stdout_limit = .limited(1024 * 1024),
        .stderr_limit = .limited(1024 * 1024),
    });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);

    switch (result.term) {
        .exited => |code| if (code == 0) return null,
        else => {},
    }

    return try std.fmt.allocPrint(allocator, "{s} failed: {s}{s}", .{ step, result.stderr, result.stdout });
}

fn runOutput(allocator: std.mem.Allocator, io: std.Io, argv: []const []const u8) ![]u8 {
    const result = try std.process.run(allocator, io, .{
        .argv = argv,
        .stdout_limit = .limited(20 * 1024 * 1024),
        .stderr_limit = .limited(1024 * 1024),
    });
    defer allocator.free(result.stderr);

    switch (result.term) {
        .exited => |code| if (code == 0) return result.stdout,
        else => {},
    }

    allocator.free(result.stdout);
    return error.CommandFailed;
}

fn fileExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.accessAbsolute(io, path, .{}) catch return false;
    return true;
}
