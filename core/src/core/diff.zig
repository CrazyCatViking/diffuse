const std = @import("std");
const repository = @import("repository.zig");
pub const syntax = @import("syntax.zig");

pub const DiffRowKind = enum {
    context,
    added,
    deleted,
    hunk,
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

    pub fn deinit(self: *DiffRenderModel, allocator: std.mem.Allocator) void {
        allocator.free(self.file_id);
        self.syntax_status.deinit(allocator);
        for (self.rows.items) |row| {
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
        }
        self.rows.deinit(allocator);
    }
};

pub const SyntaxSide = enum { old, new };

pub const SyntaxLineSpans = syntax.SyntaxLineSpans;

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
    };
    errdefer model.deinit(allocator);

    try parseUnifiedDiff(allocator, output, &model.rows);
    return model;
}

pub fn getSyntaxSpans(allocator: std.mem.Allocator, io: std.Io, cache: ?*syntax.Cache, repo_root: []const u8, file_id: []const u8, path: []const u8, options: DiffOptions, side: SyntaxSide, start_line: u32, end_line: u32) ![]SyntaxLineSpans {
    _ = file_id;
    var status = try syntax.detectStatus(allocator, io, path, options.grammar_root);
    defer status.deinit(allocator);
    if (!status.grammarInstalled) return allocator.alloc(SyntaxLineSpans, 0);
    const language = status.language orelse return allocator.alloc(SyntaxLineSpans, 0);
    const grammar_path = status.grammarPath orelse return allocator.alloc(SyntaxLineSpans, 0);
    const query_path = status.highlightsQueryPath orelse return allocator.alloc(SyntaxLineSpans, 0);

    const source = try sourceForSide(allocator, io, repo_root, path, side, options.target);
    defer allocator.free(source);

    const has_injections = syntax.hasInjections(language);
    const context_before: u32 = if (has_injections) 1024 else 0;
    const context_after: u32 = if (has_injections) 128 else 0;
    var chunk = try sourceLineChunk(allocator, source, start_line, end_line, context_before, context_after);
    defer chunk.deinit(allocator);

    const local_start = start_line - chunk.start_line + 1;
    const local_end = end_line - chunk.start_line + 1;
    const spans = try syntax.highlightTextRangeCached(allocator, io, cache, language, grammar_path, query_path, chunk.source, local_start, local_end);
    if (has_injections and sparseSyntaxResult(allocator, source, spans, start_line, end_line)) {
        freeSyntaxLineSpans(allocator, spans);
        var fallback_chunk = try sourceLineChunk(allocator, source, start_line, end_line, context_before, 1024);
        defer fallback_chunk.deinit(allocator);
        const fallback_start = start_line - fallback_chunk.start_line + 1;
        const fallback_end = end_line - fallback_chunk.start_line + 1;
        const fallback_spans = try syntax.highlightTextRangeCached(allocator, io, cache, language, grammar_path, query_path, fallback_chunk.source, fallback_start, fallback_end);
        for (fallback_spans) |*line| line.line += fallback_chunk.start_line - 1;
        return fallback_spans;
    }
    for (spans) |*line| line.line += chunk.start_line - 1;
    return spans;
}

pub fn freeSyntaxLineSpans(allocator: std.mem.Allocator, values: []SyntaxLineSpans) void {
    for (values) |line| {
        for (line.spans) |span| allocator.free(span.scope);
        allocator.free(line.spans);
    }
    allocator.free(values);
}

fn sourceForSide(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, path: []const u8, side: SyntaxSide, target: repository.DiffTarget) ![]u8 {
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
            try rows.append(allocator, .{
                .kind = .hunk,
                .text = try allocator.dupe(u8, line),
                .hunk_header = try allocator.dupe(u8, line),
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
                });
                old_line += 1;
                new_line += 1;
            },
            '-' => {
                try rows.append(allocator, .{
                    .kind = .deleted,
                    .old_line = old_line,
                    .old_text = try allocator.dupe(u8, text),
                });
                old_line += 1;
            },
            '+' => {
                try rows.append(allocator, .{
                    .kind = .added,
                    .new_line = new_line,
                    .new_text = try allocator.dupe(u8, text),
                });
                new_line += 1;
            },
            else => {},
        }
    }
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
