const std = @import("std");
const repository = @import("repository.zig");
pub const syntax = @import("syntax.zig");

const max_structural_source_bytes = 2 * 1024 * 1024;

pub const DiffRowKind = enum {
    context,
    added,
    deleted,
    hunk,
};

pub const DiffTokenSpan = struct {
    startColumn: u32,
    endColumn: u32,
    kind: []const u8,
};

pub const DiffLinePair = struct {
    oldLine: u32,
    newLine: u32,
    oldRow: u32,
    newRow: u32,
    kind: []const u8,
    confidence: f32,
};

pub const DiffChangeGroup = struct {
    id: []const u8,
    kind: []const u8,
    oldStartLine: ?u32 = null,
    oldEndLine: ?u32 = null,
    newStartLine: ?u32 = null,
    newEndLine: ?u32 = null,
    confidence: f32,
    symbol: ?[]const u8 = null,
};

pub const DiffAnnotations = struct {
    column_unit: []const u8 = "utf16",
    line_pairs: std.ArrayList(DiffLinePair) = .empty,
    change_groups: std.ArrayList(DiffChangeGroup) = .empty,

    pub fn deinit(self: *DiffAnnotations, allocator: std.mem.Allocator) void {
        for (self.change_groups.items) |group| {
            allocator.free(group.id);
            if (group.symbol) |symbol| allocator.free(symbol);
        }
        self.line_pairs.deinit(allocator);
        self.change_groups.deinit(allocator);
    }
};

pub const DiffRow = struct {
    kind: DiffRowKind,
    old_line: ?u32 = null,
    new_line: ?u32 = null,
    old_text: ?[]const u8 = null,
    new_text: ?[]const u8 = null,
    text: ?[]const u8 = null,
    hunk_header: ?[]const u8 = null,
    old_syntax_spans: ?[]const syntax.SyntaxSpan = null,
    new_syntax_spans: ?[]const syntax.SyntaxSpan = null,
    old_diff_spans: ?[]const DiffTokenSpan = null,
    new_diff_spans: ?[]const DiffTokenSpan = null,
    change_group_id: ?[]const u8 = null,
    change_role: ?[]const u8 = null,
    change_confidence: ?f32 = null,
    symbol: ?[]const u8 = null,

    pub fn kindString(self: DiffRow) []const u8 {
        return switch (self.kind) {
            .context => "context",
            .added => "added",
            .deleted => "deleted",
            .hunk => "hunk",
        };
    }
};

pub const DiffRenderModel = struct {
    file_id: []const u8,
    syntax_status: syntax.SyntaxStatus,
    rows: std.ArrayList(DiffRow),
    annotations: DiffAnnotations = .{},

    pub fn deinit(self: *DiffRenderModel, allocator: std.mem.Allocator) void {
        allocator.free(self.file_id);
        self.syntax_status.deinit(allocator);
        for (self.rows.items) |row| deinitRow(allocator, row);
        self.rows.deinit(allocator);
        self.annotations.deinit(allocator);
    }
};

pub const SyntaxSide = enum { old, new };

pub const SyntaxLineSpans = syntax.SyntaxLineSpans;

pub const PreparedSyntaxSpans = struct {
    language: []u8,
    grammar_path: []u8,
    query_path: []u8,
    source: []u8,
    chunk: SourceChunk,
    start_line: u32,
    end_line: u32,
    context_before: u32,

    pub fn deinit(self: *PreparedSyntaxSpans, allocator: std.mem.Allocator) void {
        allocator.free(self.language);
        allocator.free(self.grammar_path);
        allocator.free(self.query_path);
        allocator.free(self.source);
        self.chunk.deinit(allocator);
    }
};

pub const DiffContextMode = enum {
    diff,
    full,
};

pub const DiffOptions = struct {
    context: DiffContextMode = .diff,
    grammar_root: ?[]const u8 = null,
    target: repository.DiffTarget = .{},
};

pub fn getDiffRenderModel(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, file_id: []const u8, path: []const u8, options: DiffOptions) !DiffRenderModel {
    var repo = repository.Repository{ .allocator = allocator, .io = io, .root = repo_root, .head = "" };
    const output = switch (options.context) {
        .diff => try repo.gitDiff(options.target, &.{}, path),
        .full => try repo.gitDiff(options.target, &.{"-U999999"}, path),
    };
    defer allocator.free(output);

    var model = DiffRenderModel{
        .file_id = try allocator.dupe(u8, file_id),
        .syntax_status = try syntax.detectStatus(allocator, io, path, options.grammar_root),
        .rows = .empty,
        .annotations = .{},
    };
    errdefer model.deinit(allocator);

    try parseUnifiedDiff(allocator, output, &model.rows);
    applyStructuralSymbols(allocator, io, repo_root, path, options, model.syntax_status, &model.rows) catch {};
    try enrichDiffRows(allocator, &model.rows, &model.annotations);
    return model;
}

pub fn getSyntaxSpans(allocator: std.mem.Allocator, io: std.Io, cache: ?*syntax.Cache, repo_root: []const u8, file_id: []const u8, path: []const u8, options: DiffOptions, side: SyntaxSide, start_line: u32, end_line: u32) ![]SyntaxLineSpans {
    var prepared = try prepareSyntaxSpans(allocator, io, repo_root, file_id, path, options, side, start_line, end_line) orelse return allocator.alloc(SyntaxLineSpans, 0);
    defer prepared.deinit(allocator);
    return highlightPreparedSyntaxSpans(allocator, io, cache, &prepared);
}

pub fn prepareSyntaxSpans(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, file_id: []const u8, path: []const u8, options: DiffOptions, side: SyntaxSide, start_line: u32, end_line: u32) !?PreparedSyntaxSpans {
    _ = file_id;
    var status = try syntax.detectStatus(allocator, io, path, options.grammar_root);
    defer status.deinit(allocator);
    if (!status.grammarInstalled) return null;
    const language = status.language orelse return null;
    const grammar_path = status.grammarPath orelse return null;
    const query_path = status.highlightsQueryPath orelse return null;

    const source = try sourceForSide(allocator, io, repo_root, path, side, options.target);
    errdefer allocator.free(source);

    const has_injections = syntax.hasInjections(allocator, io, language, options.grammar_root);
    const context_before: u32 = if (has_injections) 1024 else 0;
    const context_after: u32 = if (has_injections) 128 else 0;
    var chunk = try sourceLineChunk(allocator, source, start_line, end_line, context_before, context_after);
    errdefer chunk.deinit(allocator);
    const owned_language = try allocator.dupe(u8, language);
    errdefer allocator.free(owned_language);
    const owned_grammar_path = try allocator.dupe(u8, grammar_path);
    errdefer allocator.free(owned_grammar_path);
    const owned_query_path = try allocator.dupe(u8, query_path);
    errdefer allocator.free(owned_query_path);

    return .{
        .language = owned_language,
        .grammar_path = owned_grammar_path,
        .query_path = owned_query_path,
        .source = source,
        .chunk = chunk,
        .start_line = start_line,
        .end_line = end_line,
        .context_before = context_before,
    };
}

pub fn highlightPreparedSyntaxSpans(allocator: std.mem.Allocator, io: std.Io, cache: ?*syntax.Cache, prepared: *PreparedSyntaxSpans) ![]SyntaxLineSpans {
    const local_start = prepared.start_line - prepared.chunk.start_line + 1;
    const local_end = prepared.end_line - prepared.chunk.start_line + 1;
    const spans = try syntax.highlightTextRangeCached(allocator, io, cache, prepared.language, prepared.grammar_path, prepared.query_path, prepared.chunk.source, local_start, local_end);
    if (prepared.context_before > 0 and sparseSyntaxResult(allocator, prepared.source, spans, prepared.start_line, prepared.end_line)) {
        freeSyntaxLineSpans(allocator, spans);
        var fallback_chunk = try sourceLineChunk(allocator, prepared.source, prepared.start_line, prepared.end_line, prepared.context_before, 1024);
        defer fallback_chunk.deinit(allocator);
        const fallback_start = prepared.start_line - fallback_chunk.start_line + 1;
        const fallback_end = prepared.end_line - fallback_chunk.start_line + 1;
        const fallback_spans = try syntax.highlightTextRangeCached(allocator, io, cache, prepared.language, prepared.grammar_path, prepared.query_path, fallback_chunk.source, fallback_start, fallback_end);
        for (fallback_spans) |*line| line.line += fallback_chunk.start_line - 1;
        return fallback_spans;
    }
    for (spans) |*line| line.line += prepared.chunk.start_line - 1;
    return spans;
}

pub fn freeSyntaxLineSpans(allocator: std.mem.Allocator, values: []SyntaxLineSpans) void {
    for (values) |line| {
        for (line.spans) |span| allocator.free(span.scope);
        allocator.free(line.spans);
    }
    allocator.free(values);
}

pub fn sourceForSide(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, path: []const u8, side: SyntaxSide, target: repository.DiffTarget) ![]u8 {
    if (target.compare) |compare| {
        return switch (side) {
            .old => sourceFromRef(allocator, io, repo_root, target.base orelse "HEAD", path) catch allocator.dupe(u8, ""),
            .new => sourceFromRef(allocator, io, repo_root, compare, path) catch allocator.dupe(u8, ""),
        };
    }

    if (target.include_staged and !target.include_unstaged) {
        return switch (side) {
            .old => sourceFromRef(allocator, io, repo_root, target.base orelse "HEAD", path) catch allocator.dupe(u8, ""),
            .new => sourceFromIndex(allocator, io, repo_root, path) catch allocator.dupe(u8, ""),
        };
    }

    if (!target.include_staged and target.include_unstaged) {
        return switch (side) {
            .old => sourceFromIndex(allocator, io, repo_root, path) catch allocator.dupe(u8, ""),
            .new => sourceFromWorkingTree(allocator, io, repo_root, path) catch allocator.dupe(u8, ""),
        };
    }

    return switch (side) {
        .old => sourceFromRef(allocator, io, repo_root, target.base orelse "HEAD", path) catch allocator.dupe(u8, ""),
        .new => sourceFromWorkingTree(allocator, io, repo_root, path) catch allocator.dupe(u8, ""),
    };
}

fn sourceFromIndex(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, path: []const u8) ![]u8 {
    const index_path = try std.fmt.allocPrint(allocator, ":{s}", .{path});
    defer allocator.free(index_path);
    return repository.git(allocator, io, repo_root, &.{ "show", index_path });
}

fn sourceFromRef(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, ref: []const u8, path: []const u8) ![]u8 {
    const ref_path = try std.fmt.allocPrint(allocator, "{s}:{s}", .{ ref, path });
    defer allocator.free(ref_path);
    return repository.git(allocator, io, repo_root, &.{ "show", ref_path });
}

fn sourceFromWorkingTree(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, path: []const u8) ![]u8 {
    const full_path = try std.fs.path.join(allocator, &.{ repo_root, path });
    defer allocator.free(full_path);
    return std.Io.Dir.readFileAlloc(.cwd(), io, full_path, allocator, .limited(20 * 1024 * 1024));
}

fn sparseSyntaxResult(allocator: std.mem.Allocator, source: []const u8, spans: []const SyntaxLineSpans, start_line: u32, end_line: u32) bool {
    const requested = end_line - start_line + 1;
    if (requested < 16) return false;

    var highlighted = std.AutoHashMap(u32, void).init(allocator);
    defer highlighted.deinit();
    for (spans) |line| highlighted.put(line.line, {}) catch return false;

    var current_line: u32 = 1;
    var line_start: usize = 0;
    var missing_run: u32 = 0;
    var offset: usize = 0;
    while (offset <= source.len) : (offset += 1) {
        if (offset < source.len and source[offset] != '\n') continue;
        if (current_line >= start_line and current_line <= end_line) {
            const text = std.mem.trim(u8, source[line_start..offset], " \t\r");
            if (text.len > 0 and !highlighted.contains(current_line)) {
                missing_run += 1;
                if (missing_run >= 4) return true;
            } else {
                missing_run = 0;
            }
        }
        if (current_line > end_line) break;
        current_line += 1;
        line_start = offset + 1;
    }
    return spans.len * 4 < requested;
}

fn applyStructuralSymbols(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, path: []const u8, options: DiffOptions, status: syntax.SyntaxStatus, rows: *std.ArrayList(DiffRow)) !void {
    if (!status.grammarInstalled) return;
    const language = status.language orelse return;
    const grammar_path = status.grammarPath orelse return;

    const old_source = try sourceForSide(allocator, io, repo_root, path, .old, options.target);
    defer allocator.free(old_source);
    if (old_source.len > 0 and old_source.len <= max_structural_source_bytes) {
        const symbols = try syntax.structuralSymbols(allocator, language, grammar_path, old_source);
        defer syntax.freeStructuralSymbols(allocator, symbols);
        try attachStructuralSymbols(allocator, rows, .old, symbols);
    }

    const new_source = try sourceForSide(allocator, io, repo_root, path, .new, options.target);
    defer allocator.free(new_source);
    if (new_source.len > 0 and new_source.len <= max_structural_source_bytes) {
        const symbols = try syntax.structuralSymbols(allocator, language, grammar_path, new_source);
        defer syntax.freeStructuralSymbols(allocator, symbols);
        try attachStructuralSymbols(allocator, rows, .new, symbols);
    }
}

fn attachStructuralSymbols(allocator: std.mem.Allocator, rows: *std.ArrayList(DiffRow), side: SyntaxSide, symbols: []const syntax.StructuralSymbol) !void {
    if (symbols.len == 0) return;
    for (rows.items) |*row| {
        if (row.kind == .hunk) continue;
        const line = switch (side) {
            .old => row.old_line,
            .new => row.new_line,
        } orelse continue;
        const symbol = structuralSymbolForLine(symbols, line) orelse continue;
        const replacement = try allocator.dupe(u8, symbol.label);
        if (row.symbol) |existing| {
            if (std.mem.eql(u8, existing, symbol.label)) {
                allocator.free(replacement);
                continue;
            }
            allocator.free(existing);
        }
        row.symbol = replacement;
    }
}

fn structuralSymbolForLine(symbols: []const syntax.StructuralSymbol, line: u32) ?syntax.StructuralSymbol {
    var best: ?syntax.StructuralSymbol = null;
    var best_width: u32 = std.math.maxInt(u32);
    for (symbols) |symbol| {
        if (line < symbol.start_line or line > symbol.end_line) continue;
        const width = symbol.end_line - symbol.start_line;
        if (width <= best_width) {
            best = symbol;
            best_width = width;
        }
    }
    return best;
}

const SourceChunk = struct {
    source: []u8,
    start_line: u32,
    line_count: u32,

    fn deinit(self: *SourceChunk, allocator: std.mem.Allocator) void {
        allocator.free(self.source);
    }
};

fn sourceLineChunk(allocator: std.mem.Allocator, source: []const u8, start_line: u32, end_line: u32, context_before: u32, context_after: u32) !SourceChunk {
    if (source.len == 0 or end_line < start_line) return .{ .source = try allocator.dupe(u8, ""), .start_line = start_line, .line_count = 0 };
    const chunk_start_line = if (start_line > context_before) start_line - context_before else 1;
    const chunk_end_line = end_line + context_after;

    var offset: usize = 0;
    var line: u32 = 1;
    var chunk_start: usize = 0;
    var chunk_end: usize = source.len;
    var found_start = chunk_start_line <= 1;
    var found_end = false;

    while (offset < source.len) : (offset += 1) {
        if (!found_start and line == chunk_start_line) {
            chunk_start = offset;
            found_start = true;
        }
        if (source[offset] != '\n') continue;
        if (line == chunk_end_line) {
            chunk_end = offset;
            found_end = true;
            break;
        }
        line += 1;
    }

    if (!found_start) return .{ .source = try allocator.dupe(u8, ""), .start_line = chunk_start_line, .line_count = 0 };
    if (!found_end and chunk_end_line < line) chunk_end = source.len;

    return .{
        .source = try allocator.dupe(u8, source[chunk_start..chunk_end]),
        .start_line = chunk_start_line,
        .line_count = chunk_end_line - chunk_start_line + 1,
    };
}

fn parseUnifiedDiff(allocator: std.mem.Allocator, input: []const u8, rows: *std.ArrayList(DiffRow)) !void {
    var old_line: u32 = 0;
    var new_line: u32 = 0;
    var current_symbol: ?[]const u8 = null;

    var lines = std.mem.splitScalar(u8, input, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trimEnd(u8, raw_line, "\r");
        if (std.mem.startsWith(u8, line, "diff --git") or
            std.mem.startsWith(u8, line, "index ") or
            std.mem.startsWith(u8, line, "--- ") or
            std.mem.startsWith(u8, line, "+++ "))
        {
            continue;
        }

        if (std.mem.startsWith(u8, line, "@@")) {
            const parsed = parseHunkHeader(line);
            old_line = parsed.old_start;
            new_line = parsed.new_start;
            current_symbol = hunkSymbol(line);
            try rows.append(allocator, .{
                .kind = .hunk,
                .text = try allocator.dupe(u8, line),
                .hunk_header = try allocator.dupe(u8, line),
                .symbol = if (current_symbol) |symbol| try allocator.dupe(u8, symbol) else null,
            });
            continue;
        }

        if (line.len == 0) continue;
        const prefix = line[0];
        const text = if (line.len > 1) line[1..] else "";

        switch (prefix) {
            ' ' => {
                try rows.append(allocator, .{
                    .kind = .context,
                    .old_line = old_line,
                    .new_line = new_line,
                    .old_text = try allocator.dupe(u8, text),
                    .new_text = try allocator.dupe(u8, text),
                    .symbol = if (current_symbol) |symbol| try allocator.dupe(u8, symbol) else null,
                });
                old_line += 1;
                new_line += 1;
            },
            '-' => {
                try rows.append(allocator, .{
                    .kind = .deleted,
                    .old_line = old_line,
                    .old_text = try allocator.dupe(u8, text),
                    .symbol = if (current_symbol) |symbol| try allocator.dupe(u8, symbol) else null,
                });
                old_line += 1;
            },
            '+' => {
                try rows.append(allocator, .{
                    .kind = .added,
                    .new_line = new_line,
                    .new_text = try allocator.dupe(u8, text),
                    .symbol = if (current_symbol) |symbol| try allocator.dupe(u8, symbol) else null,
                });
                new_line += 1;
            },
            else => {},
        }
    }
}

const TokenClass = enum { whitespace, word, punctuation };

const Token = struct {
    byte_start: u32,
    byte_end: u32,
    column_start: u32,
    column_end: u32,
    class: TokenClass,
};

const TokenMatch = struct {
    old_index: usize,
    new_index: usize,
};

const ChangeBlock = struct {
    deleted_start: usize,
    deleted_end: usize,
    added_start: usize,
    added_end: usize,
};

fn enrichDiffRows(allocator: std.mem.Allocator, rows: *std.ArrayList(DiffRow), annotations: *DiffAnnotations) !void {
    try addLinePairsAndTokenSpans(allocator, rows, annotations);
    try addMovedGroups(allocator, rows, annotations);
    try addSymbolGroups(allocator, rows, annotations);
}

fn addLinePairsAndTokenSpans(allocator: std.mem.Allocator, rows: *std.ArrayList(DiffRow), annotations: *DiffAnnotations) !void {
    var index: usize = 0;
    while (index < rows.items.len) {
        if (rows.items[index].kind == .deleted) {
            const deleted_start = index;
            while (index < rows.items.len and rows.items[index].kind == .deleted) : (index += 1) {}
            const deleted_end = index;
            const added_start = index;
            while (index < rows.items.len and rows.items[index].kind == .added) : (index += 1) {}
            const added_end = index;
            try annotateChangeBlock(allocator, rows, annotations, .{
                .deleted_start = deleted_start,
                .deleted_end = deleted_end,
                .added_start = added_start,
                .added_end = added_end,
            });
            continue;
        }

        if (rows.items[index].kind == .added) {
            const added_start = index;
            while (index < rows.items.len and rows.items[index].kind == .added) : (index += 1) {}
            try annotateChangeBlock(allocator, rows, annotations, .{
                .deleted_start = added_start,
                .deleted_end = added_start,
                .added_start = added_start,
                .added_end = index,
            });
            continue;
        }

        index += 1;
    }
}

fn annotateChangeBlock(allocator: std.mem.Allocator, rows: *std.ArrayList(DiffRow), annotations: *DiffAnnotations, block: ChangeBlock) !void {
    const deleted_count = block.deleted_end - block.deleted_start;
    const added_count = block.added_end - block.added_start;
    const pair_count = @min(deleted_count, added_count);

    var offset: usize = 0;
    while (offset < pair_count) : (offset += 1) {
        const old_index = block.deleted_start + offset;
        const new_index = block.added_start + offset;
        const old_text = rows.items[old_index].old_text orelse "";
        const new_text = rows.items[new_index].new_text orelse "";
        var old_spans: std.ArrayList(DiffTokenSpan) = .empty;
        defer old_spans.deinit(allocator);
        var new_spans: std.ArrayList(DiffTokenSpan) = .empty;
        defer new_spans.deinit(allocator);

        try diffTokenSpans(allocator, old_text, new_text, &old_spans, &new_spans);
        rows.items[old_index].old_diff_spans = try ownedSpansOrNull(allocator, &old_spans);
        rows.items[new_index].new_diff_spans = try ownedSpansOrNull(allocator, &new_spans);

        if (rows.items[old_index].old_line) |old_line| {
            if (rows.items[new_index].new_line) |new_line| {
                try annotations.line_pairs.append(allocator, .{
                    .oldLine = old_line,
                    .newLine = new_line,
                    .oldRow = @intCast(old_index),
                    .newRow = @intCast(new_index),
                    .kind = "replacement",
                    .confidence = linePairConfidence(old_text, new_text),
                });
            }
        }
    }

    while (offset < deleted_count) : (offset += 1) {
        const row_index = block.deleted_start + offset;
        rows.items[row_index].old_diff_spans = try fullLineSpan(allocator, rows.items[row_index].old_text orelse "", "deleted-token");
    }

    offset = pair_count;
    while (offset < added_count) : (offset += 1) {
        const row_index = block.added_start + offset;
        rows.items[row_index].new_diff_spans = try fullLineSpan(allocator, rows.items[row_index].new_text orelse "", "inserted-token");
    }
}

fn diffTokenSpans(allocator: std.mem.Allocator, old_text: []const u8, new_text: []const u8, old_spans: *std.ArrayList(DiffTokenSpan), new_spans: *std.ArrayList(DiffTokenSpan)) !void {
    if (std.mem.eql(u8, old_text, new_text)) return;

    const old_tokens = try tokenizeLine(allocator, old_text);
    defer allocator.free(old_tokens);
    const new_tokens = try tokenizeLine(allocator, new_text);
    defer allocator.free(new_tokens);

    if (old_tokens.len == 0 and new_tokens.len == 0) return;
    if (old_tokens.len == 0) {
        if (new_text.len > 0) try new_spans.append(allocator, .{ .startColumn = 0, .endColumn = utf16ColumnForEndByte(new_text, new_text.len), .kind = "inserted-token" });
        return;
    }
    if (new_tokens.len == 0) {
        if (old_text.len > 0) try old_spans.append(allocator, .{ .startColumn = 0, .endColumn = utf16ColumnForEndByte(old_text, old_text.len), .kind = "deleted-token" });
        return;
    }

    if (old_tokens.len * new_tokens.len > 4096) {
        try fallbackByteSpans(allocator, old_text, new_text, old_spans, new_spans);
        return;
    }

    const whitespace_only = equalIgnoringAsciiWhitespace(old_text, new_text);
    const span_kind = if (whitespace_only) "whitespace" else "replaced-token";
    const width = new_tokens.len + 1;
    var table = try allocator.alloc(u32, (old_tokens.len + 1) * (new_tokens.len + 1));
    defer allocator.free(table);
    @memset(table, 0);

    var old_index: usize = 1;
    while (old_index <= old_tokens.len) : (old_index += 1) {
        var new_index: usize = 1;
        while (new_index <= new_tokens.len) : (new_index += 1) {
            const cell = old_index * width + new_index;
            if (tokensEqual(old_text, old_tokens[old_index - 1], new_text, new_tokens[new_index - 1])) {
                table[cell] = table[(old_index - 1) * width + (new_index - 1)] + 1;
            } else {
                table[cell] = @max(table[(old_index - 1) * width + new_index], table[old_index * width + (new_index - 1)]);
            }
        }
    }

    var matches: std.ArrayList(TokenMatch) = .empty;
    defer matches.deinit(allocator);
    var i = old_tokens.len;
    var j = new_tokens.len;
    while (i > 0 and j > 0) {
        if (tokensEqual(old_text, old_tokens[i - 1], new_text, new_tokens[j - 1])) {
            try matches.append(allocator, .{ .old_index = i - 1, .new_index = j - 1 });
            i -= 1;
            j -= 1;
        } else if (table[(i - 1) * width + j] >= table[i * width + (j - 1)]) {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    std.mem.reverse(TokenMatch, matches.items);

    var old_cursor: usize = 0;
    var new_cursor: usize = 0;
    for (matches.items) |match| {
        try appendChangedTokenRun(allocator, old_tokens, old_cursor, match.old_index, old_spans, if (new_cursor < match.new_index) span_kind else "deleted-token");
        try appendChangedTokenRun(allocator, new_tokens, new_cursor, match.new_index, new_spans, if (old_cursor < match.old_index) span_kind else "inserted-token");
        old_cursor = match.old_index + 1;
        new_cursor = match.new_index + 1;
    }
    try appendChangedTokenRun(allocator, old_tokens, old_cursor, old_tokens.len, old_spans, if (new_cursor < new_tokens.len) span_kind else "deleted-token");
    try appendChangedTokenRun(allocator, new_tokens, new_cursor, new_tokens.len, new_spans, if (old_cursor < old_tokens.len) span_kind else "inserted-token");
}

fn tokenizeLine(allocator: std.mem.Allocator, text: []const u8) ![]Token {
    var tokens: std.ArrayList(Token) = .empty;
    errdefer tokens.deinit(allocator);

    var index: usize = 0;
    while (index < text.len) {
        const class = tokenClass(text[index]);
        const start = index;
        if (class == .punctuation) {
            index += 1;
        } else {
            while (index < text.len and tokenClass(text[index]) == class) : (index += 1) {}
        }
        try tokens.append(allocator, .{
            .byte_start = @intCast(start),
            .byte_end = @intCast(index),
            .column_start = utf16ColumnForStartByte(text, start),
            .column_end = utf16ColumnForEndByte(text, index),
            .class = class,
        });
    }

    return tokens.toOwnedSlice(allocator);
}

fn tokenClass(byte: u8) TokenClass {
    if (std.ascii.isWhitespace(byte)) return .whitespace;
    if (std.ascii.isAlphanumeric(byte) or byte == '_' or byte >= 0x80) return .word;
    return .punctuation;
}

fn tokensEqual(old_text: []const u8, old_token: Token, new_text: []const u8, new_token: Token) bool {
    if (old_token.class != new_token.class) return false;
    return std.mem.eql(u8, old_text[old_token.byte_start..old_token.byte_end], new_text[new_token.byte_start..new_token.byte_end]);
}

fn appendChangedTokenRun(allocator: std.mem.Allocator, tokens: []const Token, start: usize, end: usize, spans: *std.ArrayList(DiffTokenSpan), kind: []const u8) !void {
    if (end <= start) return;
    try spans.append(allocator, .{
        .startColumn = tokens[start].column_start,
        .endColumn = tokens[end - 1].column_end,
        .kind = kind,
    });
}

fn fallbackByteSpans(allocator: std.mem.Allocator, old_text: []const u8, new_text: []const u8, old_spans: *std.ArrayList(DiffTokenSpan), new_spans: *std.ArrayList(DiffTokenSpan)) !void {
    var prefix: usize = 0;
    while (prefix < old_text.len and prefix < new_text.len and old_text[prefix] == new_text[prefix]) : (prefix += 1) {}
    var old_suffix = old_text.len;
    var new_suffix = new_text.len;
    while (old_suffix > prefix and new_suffix > prefix and old_text[old_suffix - 1] == new_text[new_suffix - 1]) {
        old_suffix -= 1;
        new_suffix -= 1;
    }
    const whitespace_only = equalIgnoringAsciiWhitespace(old_text, new_text);
    const replacement = old_suffix > prefix and new_suffix > prefix;
    if (old_suffix > prefix) try appendByteRangeSpan(allocator, old_text, prefix, old_suffix, old_spans, if (whitespace_only) "whitespace" else if (replacement) "replaced-token" else "deleted-token");
    if (new_suffix > prefix) try appendByteRangeSpan(allocator, new_text, prefix, new_suffix, new_spans, if (whitespace_only) "whitespace" else if (replacement) "replaced-token" else "inserted-token");
}

fn appendByteRangeSpan(allocator: std.mem.Allocator, text: []const u8, start_byte: usize, end_byte: usize, spans: *std.ArrayList(DiffTokenSpan), kind: []const u8) !void {
    const start_column = utf16ColumnForStartByte(text, start_byte);
    const end_column = utf16ColumnForEndByte(text, end_byte);
    if (end_column <= start_column) return;
    try spans.append(allocator, .{ .startColumn = start_column, .endColumn = end_column, .kind = kind });
}

fn ownedSpansOrNull(allocator: std.mem.Allocator, spans: *std.ArrayList(DiffTokenSpan)) !?[]const DiffTokenSpan {
    if (spans.items.len == 0) return null;
    return try spans.toOwnedSlice(allocator);
}

fn fullLineSpan(allocator: std.mem.Allocator, text: []const u8, kind: []const u8) !?[]const DiffTokenSpan {
    if (text.len == 0) return null;
    const spans = try allocator.alloc(DiffTokenSpan, 1);
    spans[0] = .{ .startColumn = 0, .endColumn = utf16ColumnForEndByte(text, text.len), .kind = kind };
    return spans;
}

fn utf16ColumnForStartByte(text: []const u8, byte_offset: usize) u32 {
    return utf16ColumnForByte(text, byte_offset, false);
}

fn utf16ColumnForEndByte(text: []const u8, byte_offset: usize) u32 {
    return utf16ColumnForByte(text, byte_offset, true);
}

fn utf16ColumnForByte(text: []const u8, byte_offset: usize, include_crossing_scalar: bool) u32 {
    const limit = @min(byte_offset, text.len);
    var index: usize = 0;
    var column: u32 = 0;
    while (index < limit) {
        const sequence_len = utf8SequenceLength(text[index], text[index..]);
        if (!include_crossing_scalar and index + sequence_len > limit) break;
        column += if (sequence_len == 4) 2 else 1;
        index += sequence_len;
    }
    return column;
}

fn utf8SequenceLength(first: u8, remaining: []const u8) usize {
    const expected: usize = if (first < 0x80)
        1
    else if (first & 0xE0 == 0xC0)
        2
    else if (first & 0xF0 == 0xE0)
        3
    else if (first & 0xF8 == 0xF0)
        4
    else
        1;
    if (expected > remaining.len) return 1;
    var index: usize = 1;
    while (index < expected) : (index += 1) {
        if (remaining[index] & 0xC0 != 0x80) return 1;
    }
    return expected;
}

fn linePairConfidence(old_text: []const u8, new_text: []const u8) f32 {
    if (equalIgnoringAsciiWhitespace(old_text, new_text)) return 0.96;
    const old_len: f32 = @floatFromInt(@max(old_text.len, 1));
    const new_len: f32 = @floatFromInt(@max(new_text.len, 1));
    const ratio = @min(old_len, new_len) / @max(old_len, new_len);
    return @max(0.55, @min(0.92, ratio));
}

fn equalIgnoringAsciiWhitespace(left: []const u8, right: []const u8) bool {
    var left_index: usize = 0;
    var right_index: usize = 0;
    while (true) {
        while (left_index < left.len and std.ascii.isWhitespace(left[left_index])) : (left_index += 1) {}
        while (right_index < right.len and std.ascii.isWhitespace(right[right_index])) : (right_index += 1) {}
        if (left_index >= left.len or right_index >= right.len) return left_index >= left.len and right_index >= right.len;
        if (left[left_index] != right[right_index]) return false;
        left_index += 1;
        right_index += 1;
    }
}

fn addMovedGroups(allocator: std.mem.Allocator, rows: *std.ArrayList(DiffRow), annotations: *DiffAnnotations) !void {
    var group_index: u32 = 1;
    var old_index: usize = 0;
    while (old_index < rows.items.len) : (old_index += 1) {
        if (rows.items[old_index].kind != .deleted or rows.items[old_index].change_group_id != null) continue;

        var new_index: usize = 0;
        while (new_index < rows.items.len) : (new_index += 1) {
            if (rows.items[new_index].kind != .added or rows.items[new_index].change_group_id != null) continue;
            if (nearbyRows(old_index, new_index)) continue;
            if (!significantNormalizedEqual(rows.items[old_index].old_text orelse "", rows.items[new_index].new_text orelse "")) continue;

            const count = movedRunLength(rows.items, old_index, new_index);
            if (count == 0) continue;
            try markMovedRun(allocator, rows, annotations, old_index, new_index, count, group_index);
            group_index += 1;
            break;
        }
    }
}

fn nearbyRows(left: usize, right: usize) bool {
    return if (left > right) left - right <= 4 else right - left <= 4;
}

fn movedRunLength(rows: []const DiffRow, old_start: usize, new_start: usize) usize {
    var count: usize = 0;
    while (old_start + count < rows.len and new_start + count < rows.len) : (count += 1) {
        const old_row = rows[old_start + count];
        const new_row = rows[new_start + count];
        if (old_row.kind != .deleted or new_row.kind != .added) break;
        if (old_row.change_group_id != null or new_row.change_group_id != null) break;
        if (!significantNormalizedEqual(old_row.old_text orelse "", new_row.new_text orelse "")) break;
    }
    return count;
}

fn markMovedRun(allocator: std.mem.Allocator, rows: *std.ArrayList(DiffRow), annotations: *DiffAnnotations, old_start: usize, new_start: usize, count: usize, group_index: u32) !void {
    const group_id = try std.fmt.allocPrint(allocator, "move-{d}", .{group_index});
    defer allocator.free(group_id);
    const confidence: f32 = if (count > 1) 0.94 else 0.82;

    var offset: usize = 0;
    while (offset < count) : (offset += 1) {
        rows.items[old_start + offset].change_group_id = try allocator.dupe(u8, group_id);
        rows.items[old_start + offset].change_role = "moved-from";
        rows.items[old_start + offset].change_confidence = confidence;
        rows.items[new_start + offset].change_group_id = try allocator.dupe(u8, group_id);
        rows.items[new_start + offset].change_role = "moved-to";
        rows.items[new_start + offset].change_confidence = confidence;
    }

    const old_start_line = rows.items[old_start].old_line;
    const old_end_line = rows.items[old_start + count - 1].old_line;
    const new_start_line = rows.items[new_start].new_line;
    const new_end_line = rows.items[new_start + count - 1].new_line;
    const symbol = commonSymbol(rows.items[old_start].symbol, rows.items[new_start].symbol);
    try annotations.change_groups.append(allocator, .{
        .id = try allocator.dupe(u8, group_id),
        .kind = "moved-block",
        .oldStartLine = old_start_line,
        .oldEndLine = old_end_line,
        .newStartLine = new_start_line,
        .newEndLine = new_end_line,
        .confidence = confidence,
        .symbol = if (symbol) |value| try allocator.dupe(u8, value) else null,
    });
}

fn significantNormalizedEqual(left: []const u8, right: []const u8) bool {
    var left_index: usize = 0;
    var right_index: usize = 0;
    var significant: u32 = 0;
    var alnum: u32 = 0;

    while (true) {
        while (left_index < left.len and std.ascii.isWhitespace(left[left_index])) : (left_index += 1) {}
        while (right_index < right.len and std.ascii.isWhitespace(right[right_index])) : (right_index += 1) {}
        if (left_index >= left.len or right_index >= right.len) break;
        if (left[left_index] != right[right_index]) return false;
        significant += 1;
        if (std.ascii.isAlphanumeric(left[left_index]) or left[left_index] == '_') alnum += 1;
        left_index += 1;
        right_index += 1;
    }

    while (left_index < left.len and std.ascii.isWhitespace(left[left_index])) : (left_index += 1) {}
    while (right_index < right.len and std.ascii.isWhitespace(right[right_index])) : (right_index += 1) {}
    return left_index >= left.len and right_index >= right.len and significant >= 12 and alnum >= 6;
}

fn addSymbolGroups(allocator: std.mem.Allocator, rows: *std.ArrayList(DiffRow), annotations: *DiffAnnotations) !void {
    var group_index: u32 = 1;
    var index: usize = 0;
    while (index < rows.items.len) {
        const symbol = rows.items[index].symbol orelse {
            index += 1;
            continue;
        };
        if (rows.items[index].kind == .hunk) {
            index += 1;
            continue;
        }

        const start = index;
        var old_start_line: ?u32 = null;
        var old_end_line: ?u32 = null;
        var new_start_line: ?u32 = null;
        var new_end_line: ?u32 = null;
        var changed = false;
        while (index < rows.items.len and sameOptionalText(rows.items[index].symbol, symbol) and rows.items[index].kind != .hunk) : (index += 1) {
            if (rows.items[index].old_line) |line| {
                if (old_start_line == null) old_start_line = line;
                old_end_line = line;
            }
            if (rows.items[index].new_line) |line| {
                if (new_start_line == null) new_start_line = line;
                new_end_line = line;
            }
            if (rows.items[index].kind == .added or rows.items[index].kind == .deleted) changed = true;
        }
        if (!changed) continue;

        const group_id = try std.fmt.allocPrint(allocator, "symbol-{d}", .{group_index});
        defer allocator.free(group_id);
        group_index += 1;
        var row_index = start;
        while (row_index < index) : (row_index += 1) {
            if (rows.items[row_index].change_group_id == null and (rows.items[row_index].kind == .added or rows.items[row_index].kind == .deleted)) {
                rows.items[row_index].change_group_id = try allocator.dupe(u8, group_id);
                rows.items[row_index].change_confidence = 0.72;
            }
        }

        try annotations.change_groups.append(allocator, .{
            .id = try allocator.dupe(u8, group_id),
            .kind = "symbol-change",
            .oldStartLine = old_start_line,
            .oldEndLine = old_end_line,
            .newStartLine = new_start_line,
            .newEndLine = new_end_line,
            .confidence = 0.72,
            .symbol = try allocator.dupe(u8, symbol),
        });
    }
}

fn commonSymbol(left: ?[]const u8, right: ?[]const u8) ?[]const u8 {
    if (left) |left_value| {
        if (right) |right_value| {
            if (std.mem.eql(u8, left_value, right_value)) return left_value;
        }
    }
    return null;
}

fn sameOptionalText(value: ?[]const u8, expected: []const u8) bool {
    return if (value) |text| std.mem.eql(u8, text, expected) else false;
}

fn hunkSymbol(line: []const u8) ?[]const u8 {
    const first = std.mem.indexOf(u8, line, "@@") orelse return null;
    const second = std.mem.indexOfPos(u8, line, first + 2, "@@") orelse return null;
    const context = std.mem.trim(u8, line[second + 2 ..], " \t");
    return if (context.len == 0) null else context;
}

const HunkStart = struct { old_start: u32, new_start: u32 };

fn parseHunkHeader(line: []const u8) HunkStart {
    var old_start: u32 = 0;
    var new_start: u32 = 0;

    var parts = std.mem.splitScalar(u8, line, ' ');
    _ = parts.next();
    if (parts.next()) |old_part| old_start = parseStart(old_part[1..]);
    if (parts.next()) |new_part| new_start = parseStart(new_part[1..]);

    return .{ .old_start = old_start, .new_start = new_start };
}

fn parseStart(value: []const u8) u32 {
    const end = std.mem.indexOfScalar(u8, value, ',') orelse value.len;
    return std.fmt.parseInt(u32, value[0..end], 10) catch 0;
}

fn deinitRow(allocator: std.mem.Allocator, row: DiffRow) void {
    if (row.old_text) |text| allocator.free(text);
    if (row.new_text) |text| allocator.free(text);
    if (row.text) |text| allocator.free(text);
    if (row.hunk_header) |text| allocator.free(text);
    if (row.old_syntax_spans) |spans| {
        for (spans) |span| allocator.free(span.scope);
        allocator.free(spans);
    }
    if (row.new_syntax_spans) |spans| {
        for (spans) |span| allocator.free(span.scope);
        allocator.free(spans);
    }
    if (row.old_diff_spans) |spans| allocator.free(spans);
    if (row.new_diff_spans) |spans| allocator.free(spans);
    if (row.change_group_id) |group_id| allocator.free(group_id);
    if (row.symbol) |value| allocator.free(value);
}

test "diff token spans isolate replaced identifiers" {
    const allocator = std.testing.allocator;
    var old_spans: std.ArrayList(DiffTokenSpan) = .empty;
    defer old_spans.deinit(allocator);
    var new_spans: std.ArrayList(DiffTokenSpan) = .empty;
    defer new_spans.deinit(allocator);

    try diffTokenSpans(allocator, "const oldName = value;", "const newName = value;", &old_spans, &new_spans);

    try std.testing.expectEqual(@as(usize, 1), old_spans.items.len);
    try std.testing.expectEqual(@as(usize, 1), new_spans.items.len);
    try std.testing.expectEqualStrings("replaced-token", old_spans.items[0].kind);
    try std.testing.expectEqualStrings("replaced-token", new_spans.items[0].kind);
    try std.testing.expectEqualStrings("oldName", "const oldName = value;"[old_spans.items[0].startColumn..old_spans.items[0].endColumn]);
    try std.testing.expectEqualStrings("newName", "const newName = value;"[new_spans.items[0].startColumn..new_spans.items[0].endColumn]);
}

test "diff enrichment pairs adjacent replacements" {
    const allocator = std.testing.allocator;
    const input =
        \\diff --git a/demo.zig b/demo.zig
        \\--- a/demo.zig
        \\+++ b/demo.zig
        \\@@ -1 +1 @@ fn rename()
        \\-const oldName = value;
        \\+const newName = value;
        \\
    ;

    var rows: std.ArrayList(DiffRow) = .empty;
    defer {
        for (rows.items) |row| deinitRow(allocator, row);
        rows.deinit(allocator);
    }
    var annotations: DiffAnnotations = .{};
    defer annotations.deinit(allocator);

    try parseUnifiedDiff(allocator, input, &rows);
    try enrichDiffRows(allocator, &rows, &annotations);

    try std.testing.expectEqual(@as(usize, 1), annotations.line_pairs.items.len);
    try std.testing.expect(rows.items[1].old_diff_spans != null);
    try std.testing.expect(rows.items[2].new_diff_spans != null);
    try std.testing.expectEqualStrings("fn rename()", rows.items[1].symbol.?);
}

test "diff token spans use utf16 columns for non-ascii text" {
    const allocator = std.testing.allocator;
    var old_spans: std.ArrayList(DiffTokenSpan) = .empty;
    defer old_spans.deinit(allocator);
    var new_spans: std.ArrayList(DiffTokenSpan) = .empty;
    defer new_spans.deinit(allocator);

    try diffTokenSpans(allocator, "const label = \"😀\";", "const label = \"😃\";", &old_spans, &new_spans);

    try std.testing.expectEqual(@as(usize, 1), old_spans.items.len);
    try std.testing.expectEqual(@as(usize, 1), new_spans.items.len);
    try std.testing.expectEqual(@as(u32, 15), old_spans.items[0].startColumn);
    try std.testing.expectEqual(@as(u32, 17), old_spans.items[0].endColumn);
    try std.testing.expectEqual(@as(u32, 15), new_spans.items[0].startColumn);
    try std.testing.expectEqual(@as(u32, 17), new_spans.items[0].endColumn);
}

test "full line spans use utf16 columns" {
    const allocator = std.testing.allocator;
    const spans = (try fullLineSpan(allocator, "😀x", "deleted-token")).?;
    defer allocator.free(spans);

    try std.testing.expectEqual(@as(u32, 0), spans[0].startColumn);
    try std.testing.expectEqual(@as(u32, 3), spans[0].endColumn);
}

test "structural symbols replace hunk context symbols" {
    const allocator = std.testing.allocator;
    const input =
        \\diff --git a/demo.zig b/demo.zig
        \\--- a/demo.zig
        \\+++ b/demo.zig
        \\@@ -2 +2 @@ fn fallback()
        \\-const oldName = value;
        \\+const newName = value;
        \\
    ;

    var rows: std.ArrayList(DiffRow) = .empty;
    defer {
        for (rows.items) |row| deinitRow(allocator, row);
        rows.deinit(allocator);
    }

    try parseUnifiedDiff(allocator, input, &rows);
    try attachStructuralSymbols(allocator, &rows, .old, &.{.{ .label = "function structural", .start_line = 1, .end_line = 4 }});
    try attachStructuralSymbols(allocator, &rows, .new, &.{.{ .label = "function structural", .start_line = 1, .end_line = 4 }});

    try std.testing.expectEqualStrings("function structural", rows.items[1].symbol.?);
    try std.testing.expectEqualStrings("function structural", rows.items[2].symbol.?);
}

test "diff intelligence benchmark fixtures parse and enrich" {
    const allocator = std.testing.allocator;
    const cases = [_]struct {
        input: []const u8,
        expected_group_kind: ?[]const u8 = null,
    }{
        .{ .input = @embedFile("../testdata/diff-intelligence/renamed-identifier.diff") },
        .{ .input = @embedFile("../testdata/diff-intelligence/moved-block.diff"), .expected_group_kind = "moved-block" },
        .{ .input = @embedFile("../testdata/diff-intelligence/moved-and-edited-block.diff") },
        .{ .input = @embedFile("../testdata/diff-intelligence/formatter-only.diff") },
        .{ .input = @embedFile("../testdata/diff-intelligence/wrapper-added.diff") },
        .{ .input = @embedFile("../testdata/diff-intelligence/import-reorder.diff") },
        .{ .input = @embedFile("../testdata/diff-intelligence/non-ascii.diff") },
        .{ .input = @embedFile("../testdata/diff-intelligence/large-rewrite.diff") },
    };

    for (cases) |case| {
        var rows: std.ArrayList(DiffRow) = .empty;
        defer {
            for (rows.items) |row| deinitRow(allocator, row);
            rows.deinit(allocator);
        }
        var annotations: DiffAnnotations = .{};
        defer annotations.deinit(allocator);

        try parseUnifiedDiff(allocator, case.input, &rows);
        try enrichDiffRows(allocator, &rows, &annotations);

        try std.testing.expect(rows.items.len > 0);
        if (case.expected_group_kind) |kind| try std.testing.expect(hasChangeGroupKind(annotations.change_groups.items, kind));
    }
}

fn hasChangeGroupKind(groups: []const DiffChangeGroup, kind: []const u8) bool {
    for (groups) |group| {
        if (std.mem.eql(u8, group.kind, kind)) return true;
    }
    return false;
}

test "diff enrichment detects moved blocks" {
    const allocator = std.testing.allocator;
    const input =
        \\diff --git a/demo.zig b/demo.zig
        \\--- a/demo.zig
        \\+++ b/demo.zig
        \\@@ -1,2 +1,1 @@ fn source()
        \\-const movedValue = compute(input);
        \\ const keep = true;
        \\@@ -10,2 +9,3 @@ fn destination()
        \\ const other = true;
        \\ const gap = true;
        \\+const movedValue = compute(input);
        \\
    ;

    var rows: std.ArrayList(DiffRow) = .empty;
    defer {
        for (rows.items) |row| deinitRow(allocator, row);
        rows.deinit(allocator);
    }
    var annotations: DiffAnnotations = .{};
    defer annotations.deinit(allocator);

    try parseUnifiedDiff(allocator, input, &rows);
    try enrichDiffRows(allocator, &rows, &annotations);

    try std.testing.expectEqual(@as(usize, 3), annotations.change_groups.items.len);
    try std.testing.expectEqualStrings("moved-block", annotations.change_groups.items[0].kind);
    try std.testing.expectEqualStrings("moved-from", rows.items[1].change_role.?);
    try std.testing.expectEqualStrings("moved-to", rows.items[6].change_role.?);
}
