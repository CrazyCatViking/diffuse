const std = @import("std");

const diff = @import("diff.zig");
const repository = @import("repository.zig");
const types = @import("../protocol/types.zig");

pub const max_content_file_bytes = 2 * 1024 * 1024;

pub const SearchMode = enum {
    all,
    files,
    content,
    comments,
    symbols,

    pub fn includesFiles(self: SearchMode) bool {
        return self == .all or self == .files;
    }

    pub fn includesContent(self: SearchMode) bool {
        return self == .all or self == .content;
    }

    pub fn includesComments(self: SearchMode) bool {
        return self == .all or self == .comments;
    }
};

pub const SearchFilterKind = enum {
    unviewed,
    viewed,
    commented,
    unresolved,
    generated,
    tests,
    docs,
    renamed,
    deleted,
};

pub const ParsedFilter = struct {
    key: []const u8,
    value: []const u8,
    negated: bool,
};

pub const ParsedQuery = struct {
    raw: []const u8,
    terms: []const []const u8,
    phrases: []const []const u8,
    filters: []const ParsedFilter,

    pub fn deinit(self: *ParsedQuery, allocator: std.mem.Allocator) void {
        allocator.free(self.terms);
        allocator.free(self.phrases);
        allocator.free(self.filters);
    }

    pub fn hasText(self: ParsedQuery) bool {
        return self.terms.len + self.phrases.len > 0;
    }
};

pub const SearchMatchRange = struct {
    start: usize,
    end: usize,
};

pub const SearchFieldMatch = struct {
    field: []const u8,
    ranges: []SearchMatchRange,
    score: i64,

    pub fn deinit(self: SearchFieldMatch, allocator: std.mem.Allocator) void {
        allocator.free(self.ranges);
    }
};

pub const TextMatch = struct {
    matched: bool,
    score: i64,
    ranges: []SearchMatchRange,

    pub fn deinit(self: TextMatch, allocator: std.mem.Allocator) void {
        allocator.free(self.ranges);
    }
};

pub const FileSearchMetadata = struct {
    reviewed: bool,
    commentCount: u32,
    unresolvedCount: u32,
    generated: bool,
    is_test: bool,
    docs: bool,
};

pub const ThreadInfo = struct {
    id: []u8,
    file_id: []u8,
    status: []u8,
    body: []u8,
    anchor_side: []u8,
    anchor_start_line: u32,
    anchor_json: []u8,
    thread_json: []u8,

    pub fn deinit(self: *ThreadInfo, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.file_id);
        allocator.free(self.status);
        allocator.free(self.body);
        allocator.free(self.anchor_side);
        allocator.free(self.anchor_json);
        allocator.free(self.thread_json);
    }
};

pub const ReviewData = struct {
    reviewed: ?std.json.Parsed(std.json.Value),
    threads: []ThreadInfo,

    pub fn init(allocator: std.mem.Allocator, reviewed_json: ?[]const u8, threads_json: ?[]const u8) !ReviewData {
        var reviewed: ?std.json.Parsed(std.json.Value) = null;
        errdefer if (reviewed) |*parsed| parsed.deinit();

        if (reviewed_json) |json| {
            reviewed = try std.json.parseFromSlice(std.json.Value, allocator, json, .{ .allocate = .alloc_always });
        }

        const threads = try parseThreads(allocator, threads_json orelse "[]");
        errdefer freeThreads(allocator, threads);

        return .{ .reviewed = reviewed, .threads = threads };
    }

    pub fn deinit(self: *ReviewData, allocator: std.mem.Allocator) void {
        if (self.reviewed) |*parsed| parsed.deinit();
        freeThreads(allocator, self.threads);
    }

    pub fn isReviewed(self: ReviewData, file_id: []const u8) bool {
        const parsed = self.reviewed orelse return false;
        const root = switch (parsed.value) {
            .object => |object| object,
            else => return false,
        };
        const files = root.get("files") orelse return false;
        const files_object = switch (files) {
            .object => |object| object,
            else => return false,
        };
        return files_object.get(file_id) != null;
    }

    pub fn commentCount(self: ReviewData, file_id: []const u8) u32 {
        var count: u32 = 0;
        for (self.threads) |thread| {
            if (std.mem.eql(u8, thread.file_id, file_id)) count += 1;
        }
        return count;
    }

    pub fn unresolvedCount(self: ReviewData, file_id: []const u8) u32 {
        var count: u32 = 0;
        for (self.threads) |thread| {
            if (std.mem.eql(u8, thread.file_id, file_id) and std.mem.eql(u8, thread.status, "open")) count += 1;
        }
        return count;
    }
};

pub const ResultJson = struct {
    kind_order: u8,
    rank: i64,
    path: []u8,
    line: u32 = 0,
    json: []u8,

    pub fn deinit(self: *ResultJson, allocator: std.mem.Allocator) void {
        allocator.free(self.path);
        allocator.free(self.json);
    }
};

pub fn parseMode(text: []const u8) !SearchMode {
    if (std.mem.eql(u8, text, "all")) return .all;
    if (std.mem.eql(u8, text, "files")) return .files;
    if (std.mem.eql(u8, text, "content")) return .content;
    if (std.mem.eql(u8, text, "comments")) return .comments;
    if (std.mem.eql(u8, text, "symbols")) return .symbols;
    return error.InvalidParam;
}

pub fn parseFilterKind(text: []const u8) !SearchFilterKind {
    if (std.mem.eql(u8, text, "unviewed")) return .unviewed;
    if (std.mem.eql(u8, text, "viewed")) return .viewed;
    if (std.mem.eql(u8, text, "commented")) return .commented;
    if (std.mem.eql(u8, text, "unresolved")) return .unresolved;
    if (std.mem.eql(u8, text, "generated")) return .generated;
    if (std.mem.eql(u8, text, "test")) return .tests;
    if (std.mem.eql(u8, text, "docs")) return .docs;
    if (std.mem.eql(u8, text, "renamed")) return .renamed;
    if (std.mem.eql(u8, text, "deleted")) return .deleted;
    return error.InvalidParam;
}

pub fn parseQuery(allocator: std.mem.Allocator, raw: []const u8) !ParsedQuery {
    var terms: std.ArrayList([]const u8) = .empty;
    errdefer terms.deinit(allocator);
    var phrases: std.ArrayList([]const u8) = .empty;
    errdefer phrases.deinit(allocator);
    var filters: std.ArrayList(ParsedFilter) = .empty;
    errdefer filters.deinit(allocator);

    const trimmed = std.mem.trim(u8, raw, " \r\n\t");
    var index: usize = 0;
    var negate_next = false;
    while (index < trimmed.len) {
        while (index < trimmed.len and std.ascii.isWhitespace(trimmed[index])) index += 1;
        if (index >= trimmed.len) break;

        const token_start = index;
        var quoted = false;
        while (index < trimmed.len) : (index += 1) {
            const char = trimmed[index];
            if (char == '"') quoted = !quoted;
            if (!quoted and std.ascii.isWhitespace(char)) break;
        }
        const token = trimmed[token_start..index];
        if (token.len == 0) continue;

        if (std.ascii.eqlIgnoreCase(token, "NOT")) {
            negate_next = true;
            continue;
        }

        var negated = negate_next;
        negate_next = false;
        var value = token;
        if (std.mem.startsWith(u8, value, "-")) {
            negated = true;
            value = value[1..];
        }

        if (parseFilter(value, negated)) |filter| {
            try filters.append(allocator, filter);
            continue;
        }

        if (value.len > 1 and value[0] == '"' and value[value.len - 1] == '"') {
            try phrases.append(allocator, value[1 .. value.len - 1]);
            continue;
        }

        try terms.append(allocator, token);
    }

    return .{
        .raw = raw,
        .terms = try terms.toOwnedSlice(allocator),
        .phrases = try phrases.toOwnedSlice(allocator),
        .filters = try filters.toOwnedSlice(allocator),
    };
}

pub fn collectQueryTerms(allocator: std.mem.Allocator, query: ParsedQuery) ![]const []const u8 {
    var terms = try allocator.alloc([]const u8, query.terms.len + query.phrases.len);
    errdefer allocator.free(terms);
    var index: usize = 0;
    for (query.terms) |term| {
        terms[index] = term;
        index += 1;
    }
    for (query.phrases) |phrase| {
        terms[index] = phrase;
        index += 1;
    }
    return terms;
}

pub fn collectCommentTerms(allocator: std.mem.Allocator, query: ParsedQuery) ![]const []const u8 {
    var count = query.terms.len + query.phrases.len;
    for (query.filters) |filter| {
        if (std.ascii.eqlIgnoreCase(filter.key, "comment")) count += 1;
    }

    var terms = try allocator.alloc([]const u8, count);
    errdefer allocator.free(terms);
    var index: usize = 0;
    for (query.terms) |term| {
        terms[index] = term;
        index += 1;
    }
    for (query.phrases) |phrase| {
        terms[index] = phrase;
        index += 1;
    }
    for (query.filters) |filter| {
        if (!std.ascii.eqlIgnoreCase(filter.key, "comment")) continue;
        terms[index] = filter.value;
        index += 1;
    }
    return terms;
}

pub fn metadataForFile(file: repository.ChangedFile, review_data: ReviewData) FileSearchMetadata {
    const path = changedFilePath(file);
    const reviewed = review_data.isReviewed(file.id);
    const comment_count = review_data.commentCount(file.id);
    const unresolved_count = review_data.unresolvedCount(file.id);
    return classifyFile(file, path, reviewed, comment_count, unresolved_count);
}

pub fn changedFilePath(file: repository.ChangedFile) []const u8 {
    return file.new_path orelse file.old_path orelse file.id;
}

pub fn sourceSide(file: repository.ChangedFile) diff.SyntaxSide {
    return switch (file.status) {
        .deleted => .old,
        else => .new,
    };
}

pub fn sourcePath(file: repository.ChangedFile, side: diff.SyntaxSide) []const u8 {
    return switch (side) {
        .old => file.old_path orelse file.id,
        .new => file.new_path orelse file.id,
    };
}

pub fn buildFileResult(
    allocator: std.mem.Allocator,
    file: repository.ChangedFile,
    metadata: FileSearchMetadata,
    query: ParsedQuery,
    terms: []const []const u8,
    active_filters: []const SearchFilterKind,
    review_data: ReviewData,
) !?ResultJson {
    if (!try filePassesFilters(allocator, file, metadata, query.filters, active_filters, review_data, false)) return null;

    const path = changedFilePath(file);
    const name = fileNameForPath(path);
    var matches: std.ArrayList(SearchFieldMatch) = .empty;
    defer matches.deinit(allocator);
    defer deinitMatches(allocator, matches.items);

    if (try fieldMatch(allocator, "name", name, terms, 500)) |match| try matches.append(allocator, match);
    if (try fieldMatch(allocator, "path", path, terms, 160)) |match| try matches.append(allocator, match);
    if (terms.len > 0 and matches.items.len == 0) return null;

    const metadata_boost: i64 = if (metadata.unresolvedCount > 0) 140 else if (metadata.commentCount > 0) 80 else 0;
    const review_boost: i64 = if (metadata.reviewed) 0 else 45;
    const generated_penalty: i64 = if (metadata.generated and !hasGeneratedFilter(query.filters, active_filters)) 260 else 0;
    const rank = matchesRank(matches.items) + metadata_boost + review_boost - generated_penalty;

    var json = std.Io.Writer.Allocating.init(allocator);
    errdefer json.deinit();
    const id = try std.fmt.allocPrint(allocator, "file:{s}", .{file.id});
    defer allocator.free(id);

    try json.writer.writeByte('{');
    try writeJsonField(&json.writer, "id", id, true);
    try writeJsonField(&json.writer, "kind", "file", false);
    try writeJsonField(&json.writer, "fileId", file.id, false);
    try writeJsonField(&json.writer, "path", path, false);
    try writeJsonField(&json.writer, "title", name, false);
    try writeJsonField(&json.writer, "subtitle", path, false);
    try json.writer.print(",\"rank\":{}", .{rank});
    try json.writer.writeAll(",\"matches\":");
    try writeMatches(&json.writer, matches.items);
    try writeJsonField(&json.writer, "name", name, false);
    try json.writer.writeAll(",\"file\":");
    try writeChangedFile(&json.writer, file);
    try json.writer.writeAll(",\"metadata\":");
    try writeMetadata(&json.writer, metadata);
    try json.writer.writeByte('}');

    return .{
        .kind_order = 0,
        .rank = rank,
        .path = try allocator.dupe(u8, path),
        .json = try json.toOwnedSlice(),
    };
}

pub fn buildCommentResult(
    allocator: std.mem.Allocator,
    thread: ThreadInfo,
    file: repository.ChangedFile,
    metadata: FileSearchMetadata,
    query: ParsedQuery,
    comment_terms: []const []const u8,
    active_filters: []const SearchFilterKind,
    review_data: ReviewData,
) !?ResultJson {
    if (comment_terms.len == 0 and !hasActiveFilter(active_filters, .commented) and !hasActiveFilter(active_filters, .unresolved)) return null;
    if (!try filePassesFilters(allocator, file, metadata, query.filters, active_filters, review_data, true)) return null;

    const path = changedFilePath(file);
    const name = fileNameForPath(path);
    var matches: std.ArrayList(SearchFieldMatch) = .empty;
    defer matches.deinit(allocator);
    defer deinitMatches(allocator, matches.items);

    if (try fieldMatch(allocator, "body", thread.body, comment_terms, 320)) |match| try matches.append(allocator, match);
    if (try fieldMatch(allocator, "path", path, comment_terms, 100)) |match| try matches.append(allocator, match);
    if (comment_terms.len > 0 and matches.items.len == 0) return null;

    const rank = matchesRank(matches.items) + if (std.mem.eql(u8, thread.status, "open")) @as(i64, 220) else @as(i64, 80);
    const subtitle = if (thread.body.len > 0) thread.body else path;
    const id = try std.fmt.allocPrint(allocator, "comment:{s}", .{thread.id});
    defer allocator.free(id);

    var json = std.Io.Writer.Allocating.init(allocator);
    errdefer json.deinit();
    try json.writer.writeByte('{');
    try writeJsonField(&json.writer, "id", id, true);
    try writeJsonField(&json.writer, "kind", "comment", false);
    try writeJsonField(&json.writer, "fileId", file.id, false);
    try writeJsonField(&json.writer, "path", path, false);
    try writeJsonField(&json.writer, "title", name, false);
    try writeJsonField(&json.writer, "subtitle", subtitle, false);
    try json.writer.print(",\"rank\":{}", .{rank});
    try json.writer.writeAll(",\"matches\":");
    try writeMatches(&json.writer, matches.items);
    try writeJsonField(&json.writer, "threadId", thread.id, false);
    try writeJsonField(&json.writer, "status", thread.status, false);
    try json.writer.writeAll(",\"anchor\":");
    try json.writer.writeAll(thread.anchor_json);
    try writeJsonField(&json.writer, "body", thread.body, false);
    try json.writer.writeAll(",\"thread\":");
    try json.writer.writeAll(thread.thread_json);
    try json.writer.writeByte('}');

    return .{
        .kind_order = 2,
        .rank = rank,
        .path = try allocator.dupe(u8, path),
        .line = thread.anchor_start_line,
        .json = try json.toOwnedSlice(),
    };
}

pub fn buildContentResultsForFile(
    allocator: std.mem.Allocator,
    file: repository.ChangedFile,
    metadata: FileSearchMetadata,
    source: []const u8,
    side: diff.SyntaxSide,
    terms: []const []const u8,
) ![]ResultJson {
    if (terms.len == 0 or source.len == 0 or source.len > max_content_file_bytes or isBinary(source)) return try allocator.alloc(ResultJson, 0);

    var results: std.ArrayList(ResultJson) = .empty;
    errdefer freeResultList(allocator, &results);

    const path = changedFilePath(file);
    const name = fileNameForPath(path);
    const side_text = sideText(side);
    var line_number: u32 = 1;
    var line_start: usize = 0;
    var offset: usize = 0;
    while (offset <= source.len) : (offset += 1) {
        if (offset < source.len and source[offset] != '\n') continue;
        const raw_line = source[line_start..offset];
        const line = std.mem.trimEnd(u8, raw_line, "\r");
        if (try matchContentLine(allocator, line, terms)) |match| {
            defer allocator.free(match.ranges);
            var preview = try contentPreview(allocator, line, match.ranges);
            defer preview.deinit(allocator);
            const result_index = results.items.len;
            const id = try std.fmt.allocPrint(allocator, "content:{s}:{s}:{}:{}", .{ file.id, side_text, line_number, result_index });
            defer allocator.free(id);
            const subtitle = try std.fmt.allocPrint(allocator, "{s}:{}", .{ path, line_number });
            defer allocator.free(subtitle);
            const rank = match.score + if (metadata.reviewed) @as(i64, 0) else @as(i64, 20);

            var json = std.Io.Writer.Allocating.init(allocator);
            errdefer json.deinit();
            try json.writer.writeByte('{');
            try writeJsonField(&json.writer, "id", id, true);
            try writeJsonField(&json.writer, "kind", "content", false);
            try writeJsonField(&json.writer, "fileId", file.id, false);
            try writeJsonField(&json.writer, "path", path, false);
            try writeJsonField(&json.writer, "title", name, false);
            try writeJsonField(&json.writer, "subtitle", subtitle, false);
            try json.writer.print(",\"rank\":{}", .{rank});
            try json.writer.writeAll(",\"matches\":[{\"field\":\"body\",\"ranges\":");
            try writeRanges(&json.writer, preview.ranges);
            try json.writer.print(",\"score\":{}}}]", .{match.score});
            try writeJsonField(&json.writer, "side", side_text, false);
            try json.writer.print(",\"line\":{}", .{line_number});
            try writeJsonField(&json.writer, "preview", preview.text, false);
            try json.writer.writeByte('}');

            try results.append(allocator, .{
                .kind_order = 1,
                .rank = rank,
                .path = try allocator.dupe(u8, path),
                .line = line_number,
                .json = try json.toOwnedSlice(),
            });
        }
        line_number += 1;
        line_start = offset + 1;
    }

    return try results.toOwnedSlice(allocator);
}

pub fn filePassesFilters(
    allocator: std.mem.Allocator,
    file: repository.ChangedFile,
    metadata: FileSearchMetadata,
    query_filters: []const ParsedFilter,
    active_filters: []const SearchFilterKind,
    review_data: ReviewData,
    skip_comment_filter: bool,
) !bool {
    for (active_filters) |filter| {
        if (!filePassesFilterKind(file, metadata, filter)) return false;
    }

    for (query_filters) |filter| {
        if (skip_comment_filter and std.ascii.eqlIgnoreCase(filter.key, "comment")) continue;
        const passes = try filePassesQueryFilter(allocator, file, metadata, filter, review_data);
        if (filter.negated) {
            if (passes) return false;
        } else if (!passes) return false;
    }

    return true;
}

pub fn sortResults(results: []ResultJson) void {
    std.mem.sort(ResultJson, results, {}, struct {
        fn lessThan(_: void, left: ResultJson, right: ResultJson) bool {
            if (left.rank != right.rank) return left.rank > right.rank;
            const path_order = std.mem.order(u8, left.path, right.path);
            if (path_order != .eq) return path_order == .lt;
            return left.line < right.line;
        }
    }.lessThan);
}

pub fn freeResults(allocator: std.mem.Allocator, results: []ResultJson) void {
    for (results) |*result| result.deinit(allocator);
    allocator.free(results);
}

fn freeResultList(allocator: std.mem.Allocator, results: *std.ArrayList(ResultJson)) void {
    for (results.items) |*result| result.deinit(allocator);
    results.deinit(allocator);
}

pub fn writeRawResultArray(writer: *std.Io.Writer, results: []const ResultJson) !void {
    try writer.writeByte('[');
    for (results, 0..) |result, index| {
        if (index > 0) try writer.writeByte(',');
        try writer.writeAll(result.json);
    }
    try writer.writeByte(']');
}

fn parseFilter(token: []const u8, negated: bool) ?ParsedFilter {
    const separator = std.mem.indexOfScalar(u8, token, ':') orelse return null;
    if (separator == 0 or separator == token.len - 1) return null;
    if (!std.ascii.isAlphabetic(token[0])) return null;
    for (token[0..separator]) |char| {
        if (!std.ascii.isAlphanumeric(char) and char != '_' and char != '-') return null;
    }
    return .{ .key = token[0..separator], .value = token[separator + 1 ..], .negated = negated };
}

fn parseThreads(allocator: std.mem.Allocator, threads_json: []const u8) ![]ThreadInfo {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, threads_json, .{ .allocate = .alloc_always });
    defer parsed.deinit();

    const array = switch (parsed.value) {
        .array => |array| array,
        else => return try allocator.alloc(ThreadInfo, 0),
    };

    var threads: std.ArrayList(ThreadInfo) = .empty;
    errdefer freeThreadList(allocator, &threads);

    for (array.items) |thread_value| {
        const object = switch (thread_value) {
            .object => |object| object,
            else => continue,
        };
        const id = getString(object, "id") orelse continue;
        const file_id = getString(object, "fileId") orelse continue;
        const status = getString(object, "status") orelse "open";
        const anchor_value = object.get("anchor") orelse continue;
        const anchor = switch (anchor_value) {
            .object => |anchor| anchor,
            else => continue,
        };
        const anchor_side = getString(anchor, "side") orelse "new";
        const anchor_start_line = getU32(anchor, "startLine") orelse 0;
        const body = try threadBody(allocator, object);
        errdefer allocator.free(body);
        const anchor_json = try stringifyJsonValue(allocator, anchor_value);
        errdefer allocator.free(anchor_json);
        const thread_json = try stringifyJsonValue(allocator, thread_value);
        errdefer allocator.free(thread_json);

        try threads.append(allocator, .{
            .id = try allocator.dupe(u8, id),
            .file_id = try allocator.dupe(u8, file_id),
            .status = try allocator.dupe(u8, status),
            .body = body,
            .anchor_side = try allocator.dupe(u8, anchor_side),
            .anchor_start_line = anchor_start_line,
            .anchor_json = anchor_json,
            .thread_json = thread_json,
        });
    }

    return try threads.toOwnedSlice(allocator);
}

fn freeThreads(allocator: std.mem.Allocator, threads: []ThreadInfo) void {
    for (threads) |*thread| thread.deinit(allocator);
    allocator.free(threads);
}

fn freeThreadList(allocator: std.mem.Allocator, threads: *std.ArrayList(ThreadInfo)) void {
    for (threads.items) |*thread| thread.deinit(allocator);
    threads.deinit(allocator);
}

fn threadBody(allocator: std.mem.Allocator, thread: std.json.ObjectMap) ![]u8 {
    const messages_value = thread.get("messages") orelse return try allocator.dupe(u8, "");
    const messages = switch (messages_value) {
        .array => |array| array,
        else => return try allocator.dupe(u8, ""),
    };

    var body = std.Io.Writer.Allocating.init(allocator);
    errdefer body.deinit();
    for (messages.items, 0..) |message_value, index| {
        const message = switch (message_value) {
            .object => |object| object,
            else => continue,
        };
        const text = getString(message, "body") orelse continue;
        if (index > 0) try body.writer.writeByte(' ');
        try body.writer.writeAll(text);
    }
    return try body.toOwnedSlice();
}

fn getString(object: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .string => |text| text,
        else => null,
    };
}

fn getU32(object: std.json.ObjectMap, name: []const u8) ?u32 {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .integer => |number| if (number >= 0 and number <= std.math.maxInt(u32)) @intCast(number) else null,
        else => null,
    };
}

fn stringifyJsonValue(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    var buffer = std.Io.Writer.Allocating.init(allocator);
    errdefer buffer.deinit();
    try std.json.Stringify.value(value, .{ .emit_null_optional_fields = false }, &buffer.writer);
    return try buffer.toOwnedSlice();
}

fn classifyFile(file: repository.ChangedFile, path: []const u8, reviewed: bool, comment_count: u32, unresolved_count: u32) FileSearchMetadata {
    _ = file;
    const generated_path_segments = [_][]const u8{ "node_modules", "vendor", "dist", "build", "target", "coverage", ".next", ".nuxt" };
    const generated_file_names = [_][]const u8{ "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "Gopkg.lock", "Pipfile.lock" };
    const docs_file_names = [_][]const u8{ "readme", "changelog", "license", "contributing" };
    const test_segments = [_][]const u8{ "test", "tests", "__tests__", "spec", "specs" };

    const name = fileNameForPath(path);
    const extension = extensionForPath(path);

    const generated = pathHasAnySegment(path, &generated_path_segments) or
        stringInSet(name, &generated_file_names) or
        endsWithIgnoreCase(path, ".min.js") or
        endsWithIgnoreCase(path, ".min.css") or
        endsWithIgnoreCase(path, ".map") or
        endsWithIgnoreCase(path, ".generated.go") or
        endsWithIgnoreCase(path, ".pb.go");
    const docs = pathHasSegment(path, "docs") or
        std.ascii.eqlIgnoreCase(extension, "md") or
        std.ascii.eqlIgnoreCase(extension, "rst") or
        std.ascii.eqlIgnoreCase(extension, "adoc") or
        stringInSet(stripExtension(name), &docs_file_names);
    const is_test = pathHasAnySegment(path, &test_segments) or isTestFileName(name);

    return .{
        .reviewed = reviewed,
        .commentCount = comment_count,
        .unresolvedCount = unresolved_count,
        .generated = generated,
        .is_test = is_test,
        .docs = docs,
    };
}

fn fileNameForPath(path: []const u8) []const u8 {
    const index = std.mem.lastIndexOfScalar(u8, path, '/') orelse return path;
    return path[index + 1 ..];
}

fn extensionForPath(path: []const u8) []const u8 {
    const name = fileNameForPath(path);
    const index = std.mem.lastIndexOfScalar(u8, name, '.') orelse return "";
    if (index == 0) return "";
    return name[index + 1 ..];
}

fn stripExtension(name: []const u8) []const u8 {
    const index = std.mem.lastIndexOfScalar(u8, name, '.') orelse return name;
    return name[0..index];
}

fn pathHasAnySegment(path: []const u8, segments: []const []const u8) bool {
    for (segments) |segment| {
        if (pathHasSegment(path, segment)) return true;
    }
    return false;
}

fn pathHasSegment(path: []const u8, needle: []const u8) bool {
    var parts = std.mem.splitScalar(u8, path, '/');
    while (parts.next()) |part| {
        if (std.ascii.eqlIgnoreCase(part, needle)) return true;
    }
    return false;
}

fn stringInSet(value: []const u8, set: []const []const u8) bool {
    for (set) |item| {
        if (std.ascii.eqlIgnoreCase(value, item)) return true;
    }
    return false;
}

fn isTestFileName(name: []const u8) bool {
    return containsIgnoreCase(name, ".test.") or
        containsIgnoreCase(name, ".spec.") or
        containsIgnoreCase(name, "_test.") or
        containsIgnoreCase(name, "_spec.") or
        containsIgnoreCase(name, "-test.") or
        containsIgnoreCase(name, "-spec.");
}

fn endsWithIgnoreCase(value: []const u8, suffix: []const u8) bool {
    if (value.len < suffix.len) return false;
    return std.ascii.eqlIgnoreCase(value[value.len - suffix.len ..], suffix);
}

fn containsIgnoreCase(value: []const u8, needle: []const u8) bool {
    if (needle.len == 0) return true;
    if (value.len < needle.len) return false;
    var index: usize = 0;
    while (index + needle.len <= value.len) : (index += 1) {
        if (std.ascii.eqlIgnoreCase(value[index .. index + needle.len], needle)) return true;
    }
    return false;
}

fn filePassesFilterKind(file: repository.ChangedFile, metadata: FileSearchMetadata, filter: SearchFilterKind) bool {
    return switch (filter) {
        .unviewed => !metadata.reviewed,
        .viewed => metadata.reviewed,
        .commented => metadata.commentCount > 0,
        .unresolved => metadata.unresolvedCount > 0,
        .generated => metadata.generated,
        .tests => metadata.is_test,
        .docs => metadata.docs,
        .renamed => file.status == .renamed,
        .deleted => file.status == .deleted,
    };
}

fn filePassesQueryFilter(
    allocator: std.mem.Allocator,
    file: repository.ChangedFile,
    metadata: FileSearchMetadata,
    filter: ParsedFilter,
    review_data: ReviewData,
) !bool {
    if (std.ascii.eqlIgnoreCase(filter.key, "is")) return filePassesIsFilter(file, metadata, filter.value);
    if (std.ascii.eqlIgnoreCase(filter.key, "status")) return std.ascii.eqlIgnoreCase(file.statusString(), filter.value);
    if (std.ascii.eqlIgnoreCase(filter.key, "ext")) return extensionMatches(changedFilePath(file), filter.value);
    if (std.ascii.eqlIgnoreCase(filter.key, "lang")) return languageMatchesExtension(filter.value, extensionForPath(changedFilePath(file)));
    if (std.ascii.eqlIgnoreCase(filter.key, "path")) return containsNormalized(allocator, changedFilePath(file), filter.value);
    if (std.ascii.eqlIgnoreCase(filter.key, "file")) return containsNormalized(allocator, fileNameForPath(changedFilePath(file)), filter.value);
    if (std.ascii.eqlIgnoreCase(filter.key, "changes")) return compareNumber(file.additions + file.deletions, filter.value);
    if (std.ascii.eqlIgnoreCase(filter.key, "added")) return compareNumber(file.additions, filter.value);
    if (std.ascii.eqlIgnoreCase(filter.key, "deleted")) return compareNumber(file.deletions, filter.value);
    if (std.ascii.eqlIgnoreCase(filter.key, "comment")) return commentTextMatches(allocator, review_data, file.id, filter.value);
    return try containsNormalized(allocator, changedFilePath(file), filter.value) or std.ascii.eqlIgnoreCase(file.statusString(), filter.value);
}

fn filePassesIsFilter(file: repository.ChangedFile, metadata: FileSearchMetadata, value: []const u8) bool {
    if (std.ascii.eqlIgnoreCase(value, "unviewed") or std.ascii.eqlIgnoreCase(value, "unreviewed")) return !metadata.reviewed;
    if (std.ascii.eqlIgnoreCase(value, "viewed") or std.ascii.eqlIgnoreCase(value, "reviewed")) return metadata.reviewed;
    if (std.ascii.eqlIgnoreCase(value, "commented") or std.ascii.eqlIgnoreCase(value, "comments")) return metadata.commentCount > 0;
    if (std.ascii.eqlIgnoreCase(value, "unresolved")) return metadata.unresolvedCount > 0;
    if (std.ascii.eqlIgnoreCase(value, "generated")) return metadata.generated;
    if (std.ascii.eqlIgnoreCase(value, "test") or std.ascii.eqlIgnoreCase(value, "tests")) return metadata.is_test;
    if (std.ascii.eqlIgnoreCase(value, "doc") or std.ascii.eqlIgnoreCase(value, "docs")) return metadata.docs;
    if (std.ascii.eqlIgnoreCase(value, "renamed")) return file.status == .renamed;
    if (std.ascii.eqlIgnoreCase(value, "deleted")) return file.status == .deleted;
    if (std.ascii.eqlIgnoreCase(value, "added")) return file.status == .added;
    if (std.ascii.eqlIgnoreCase(value, "modified")) return file.status == .modified;
    return false;
}

fn extensionMatches(path: []const u8, value: []const u8) bool {
    const extension = extensionForPath(path);
    const needle = if (std.mem.startsWith(u8, value, ".")) value[1..] else value;
    return std.ascii.eqlIgnoreCase(extension, needle);
}

fn languageMatchesExtension(language: []const u8, extension: []const u8) bool {
    if (std.ascii.eqlIgnoreCase(language, "javascript")) return anyExtension(extension, &.{ "js", "jsx", "mjs", "cjs" });
    if (std.ascii.eqlIgnoreCase(language, "typescript")) return anyExtension(extension, &.{ "ts", "tsx" });
    if (std.ascii.eqlIgnoreCase(language, "vue")) return std.ascii.eqlIgnoreCase(extension, "vue");
    if (std.ascii.eqlIgnoreCase(language, "markdown")) return anyExtension(extension, &.{ "md", "markdown" });
    if (std.ascii.eqlIgnoreCase(language, "python")) return std.ascii.eqlIgnoreCase(extension, "py");
    if (std.ascii.eqlIgnoreCase(language, "rust")) return std.ascii.eqlIgnoreCase(extension, "rs");
    if (std.ascii.eqlIgnoreCase(language, "go")) return std.ascii.eqlIgnoreCase(extension, "go");
    if (std.ascii.eqlIgnoreCase(language, "zig")) return std.ascii.eqlIgnoreCase(extension, "zig");
    if (std.ascii.eqlIgnoreCase(language, "shell")) return anyExtension(extension, &.{ "sh", "bash", "zsh" });
    return std.ascii.eqlIgnoreCase(language, extension);
}

fn anyExtension(extension: []const u8, values: []const []const u8) bool {
    for (values) |value| {
        if (std.ascii.eqlIgnoreCase(extension, value)) return true;
    }
    return false;
}

fn compareNumber(actual: u32, expression: []const u8) bool {
    const trimmed = std.mem.trim(u8, expression, " \t");
    if (trimmed.len == 0) return false;

    var operator: enum { eq, gt, gte, lt, lte } = .eq;
    var number_start: usize = 0;
    if (std.mem.startsWith(u8, trimmed, ">=")) {
        operator = .gte;
        number_start = 2;
    } else if (std.mem.startsWith(u8, trimmed, "<=")) {
        operator = .lte;
        number_start = 2;
    } else if (std.mem.startsWith(u8, trimmed, ">")) {
        operator = .gt;
        number_start = 1;
    } else if (std.mem.startsWith(u8, trimmed, "<")) {
        operator = .lt;
        number_start = 1;
    }

    const expected = std.fmt.parseInt(u32, trimmed[number_start..], 10) catch return false;
    return switch (operator) {
        .eq => actual == expected,
        .gt => actual > expected,
        .gte => actual >= expected,
        .lt => actual < expected,
        .lte => actual <= expected,
    };
}

fn commentTextMatches(allocator: std.mem.Allocator, review_data: ReviewData, file_id: []const u8, value: []const u8) !bool {
    for (review_data.threads) |thread| {
        if (!std.mem.eql(u8, thread.file_id, file_id)) continue;
        const match = try matchText(allocator, thread.body, &.{value});
        defer match.deinit(allocator);
        if (match.matched) return true;
    }
    return false;
}

fn hasActiveFilter(filters: []const SearchFilterKind, needle: SearchFilterKind) bool {
    for (filters) |filter| {
        if (filter == needle) return true;
    }
    return false;
}

fn hasGeneratedFilter(filters: []const ParsedFilter, active_filters: []const SearchFilterKind) bool {
    if (hasActiveFilter(active_filters, .generated)) return true;
    for (filters) |filter| {
        if (std.ascii.eqlIgnoreCase(filter.key, "is") and std.ascii.eqlIgnoreCase(filter.value, "generated")) return true;
    }
    return false;
}

fn fieldMatch(allocator: std.mem.Allocator, field: []const u8, value: []const u8, terms: []const []const u8, boost: i64) !?SearchFieldMatch {
    const result = try matchText(allocator, value, terms);
    if (!result.matched) {
        result.deinit(allocator);
        return null;
    }
    return .{ .field = field, .ranges = result.ranges, .score = result.score + boost };
}

fn matchText(allocator: std.mem.Allocator, value: []const u8, terms: []const []const u8) !TextMatch {
    var score: i64 = 0;
    var ranges: std.ArrayList(SearchMatchRange) = .empty;
    errdefer ranges.deinit(allocator);

    var meaningful_terms: usize = 0;
    for (terms) |term| {
        const trimmed = std.mem.trim(u8, term, " \t\r\n");
        if (trimmed.len == 0) continue;
        meaningful_terms += 1;
        const result = try matchSingleTerm(allocator, value, trimmed);
        defer result.deinit(allocator);
        if (!result.matched) {
            return .{ .matched = false, .score = 0, .ranges = try allocator.alloc(SearchMatchRange, 0) };
        }
        score += result.score;
        try ranges.appendSlice(allocator, result.ranges);
    }

    if (meaningful_terms == 0) return .{ .matched = true, .score = 0, .ranges = try allocator.alloc(SearchMatchRange, 0) };
    const merged = try mergeRanges(allocator, ranges.items);
    ranges.deinit(allocator);
    return .{ .matched = true, .score = score, .ranges = merged };
}

fn matchSingleTerm(allocator: std.mem.Allocator, value: []const u8, term: []const u8) !TextMatch {
    if (term.len == 0) return .{ .matched = true, .score = 0, .ranges = try allocator.alloc(SearchMatchRange, 0) };

    const lower_value = try lowerAlloc(allocator, value);
    defer allocator.free(lower_value);
    const lower_term = try lowerAlloc(allocator, term);
    defer allocator.free(lower_term);

    if (std.mem.indexOf(u8, lower_value, lower_term)) |exact_index| {
        const prefix_boost: i64 = if (exact_index == 0) 800 else 0;
        const boundary_boost: i64 = if (exact_index > 0 and isBoundary(value[exact_index - 1])) 240 else 0;
        const ranges = try allocator.alloc(SearchMatchRange, 1);
        ranges[0] = .{ .start = exact_index, .end = exact_index + term.len };
        return .{ .matched = true, .score = 1600 + prefix_boost + boundary_boost - @as(i64, @intCast(exact_index)), .ranges = ranges };
    }

    if (try wordInitialRanges(allocator, value, lower_term)) |ranges| {
        return .{ .matched = true, .score = 980, .ranges = ranges };
    }

    return fuzzyMatch(allocator, value, lower_term);
}

fn fuzzyMatch(allocator: std.mem.Allocator, value: []const u8, lower_term: []const u8) !TextMatch {
    const lower_value = try lowerAlloc(allocator, value);
    defer allocator.free(lower_value);
    var ranges: std.ArrayList(SearchMatchRange) = .empty;
    errdefer ranges.deinit(allocator);
    var value_index: usize = 0;
    var last_match: ?usize = null;
    var gap_penalty: i64 = 0;

    for (lower_term) |char| {
        const relative = std.mem.indexOfScalar(u8, lower_value[value_index..], char) orelse {
            return .{ .matched = false, .score = 0, .ranges = try allocator.alloc(SearchMatchRange, 0) };
        };
        const found = value_index + relative;
        if (last_match) |last| gap_penalty += @intCast(found - last - 1);
        try ranges.append(allocator, .{ .start = found, .end = found + 1 });
        value_index = found + 1;
        last_match = found;
    }

    const merged = try mergeRanges(allocator, ranges.items);
    ranges.deinit(allocator);
    return .{ .matched = true, .score = @max(120, 620 - gap_penalty * 8), .ranges = merged };
}

fn wordInitialRanges(allocator: std.mem.Allocator, value: []const u8, lower_term: []const u8) !?[]SearchMatchRange {
    const lower_value = try lowerAlloc(allocator, value);
    defer allocator.free(lower_value);
    var ranges: std.ArrayList(SearchMatchRange) = .empty;
    errdefer ranges.deinit(allocator);
    var term_index: usize = 0;

    for (value, 0..) |_, index| {
        if (term_index >= lower_term.len) break;
        if (index > 0 and !isBoundary(value[index - 1])) continue;
        if (lower_value[index] != lower_term[term_index]) continue;
        try ranges.append(allocator, .{ .start = index, .end = index + 1 });
        term_index += 1;
    }

    if (term_index != lower_term.len) {
        ranges.deinit(allocator);
        return null;
    }
    return try ranges.toOwnedSlice(allocator);
}

fn matchContentLine(allocator: std.mem.Allocator, text: []const u8, terms: []const []const u8) !?struct { score: i64, ranges: []SearchMatchRange } {
    const lower_text = try lowerAlloc(allocator, text);
    defer allocator.free(lower_text);
    var ranges: std.ArrayList(SearchMatchRange) = .empty;
    errdefer ranges.deinit(allocator);
    var score: i64 = 0;
    var meaningful_terms: usize = 0;

    for (terms) |term| {
        const trimmed = std.mem.trim(u8, term, " \t\r\n");
        if (trimmed.len == 0) continue;
        meaningful_terms += 1;
        const lower_term = try lowerAlloc(allocator, trimmed);
        defer allocator.free(lower_term);
        const before_count = ranges.items.len;
        var search_from: usize = 0;
        while (search_from < lower_text.len) {
            const relative = std.mem.indexOf(u8, lower_text[search_from..], lower_term) orelse break;
            const found = search_from + relative;
            try ranges.append(allocator, .{ .start = found, .end = found + trimmed.len });
            search_from = found + trimmed.len;
        }
        if (ranges.items.len == before_count) return null;
        score += 1200 - @as(i64, @intCast(ranges.items[before_count].start)) + @as(i64, @intCast(@min(ranges.items.len - before_count, 8))) * 30;
    }

    if (meaningful_terms == 0) return null;
    const merged = try mergeRanges(allocator, ranges.items);
    ranges.deinit(allocator);
    return .{ .score = score, .ranges = merged };
}

const Preview = struct {
    text: []u8,
    ranges: []SearchMatchRange,

    fn deinit(self: *Preview, allocator: std.mem.Allocator) void {
        allocator.free(self.text);
        allocator.free(self.ranges);
    }
};

fn contentPreview(allocator: std.mem.Allocator, text: []const u8, ranges: []const SearchMatchRange) !Preview {
    const preview_length: usize = 150;
    const prefix_length: usize = 48;
    const first_start = if (ranges.len > 0) ranges[0].start else 0;
    const start = if (first_start > prefix_length) first_start - prefix_length else 0;
    const end = @min(text.len, start + preview_length);
    const prefix = if (start > 0) "..." else "";
    const suffix = if (end < text.len) "..." else "";
    const preview_text = try std.fmt.allocPrint(allocator, "{s}{s}{s}", .{ prefix, text[start..end], suffix });
    errdefer allocator.free(preview_text);
    const offset: isize = @as(isize, @intCast(prefix.len)) - @as(isize, @intCast(start));

    var preview_ranges: std.ArrayList(SearchMatchRange) = .empty;
    errdefer preview_ranges.deinit(allocator);
    for (ranges) |range| {
        const range_start = @max(start, range.start);
        const range_end = @min(end, range.end);
        if (range_end <= range_start) continue;
        try preview_ranges.append(allocator, .{
            .start = @intCast(@as(isize, @intCast(range_start)) + offset),
            .end = @intCast(@as(isize, @intCast(range_end)) + offset),
        });
    }

    return .{ .text = preview_text, .ranges = try preview_ranges.toOwnedSlice(allocator) };
}

fn mergeRanges(allocator: std.mem.Allocator, input: []const SearchMatchRange) ![]SearchMatchRange {
    if (input.len == 0) return try allocator.alloc(SearchMatchRange, 0);
    const sorted = try allocator.dupe(SearchMatchRange, input);
    defer allocator.free(sorted);
    std.mem.sort(SearchMatchRange, sorted, {}, struct {
        fn lessThan(_: void, left: SearchMatchRange, right: SearchMatchRange) bool {
            return left.start < right.start or (left.start == right.start and left.end < right.end);
        }
    }.lessThan);

    var merged: std.ArrayList(SearchMatchRange) = .empty;
    errdefer merged.deinit(allocator);
    for (sorted) |range| {
        if (merged.items.len == 0 or range.start > merged.items[merged.items.len - 1].end) {
            try merged.append(allocator, range);
            continue;
        }
        merged.items[merged.items.len - 1].end = @max(merged.items[merged.items.len - 1].end, range.end);
    }
    return try merged.toOwnedSlice(allocator);
}

fn lowerAlloc(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    const lower = try allocator.dupe(u8, value);
    for (lower) |*char| char.* = std.ascii.toLower(char.*);
    return lower;
}

fn containsNormalized(allocator: std.mem.Allocator, haystack: []const u8, needle: []const u8) !bool {
    const lower_haystack = try lowerAlloc(allocator, haystack);
    defer allocator.free(lower_haystack);
    const lower_needle = try lowerAlloc(allocator, needle);
    defer allocator.free(lower_needle);
    return std.mem.indexOf(u8, lower_haystack, lower_needle) != null;
}

fn isBoundary(char: u8) bool {
    return char == '/' or char == '-' or char == '_' or char == '.' or char == ' ';
}

fn matchesRank(matches: []const SearchFieldMatch) i64 {
    var rank: i64 = 0;
    for (matches) |match| rank += match.score;
    return rank;
}

fn deinitMatches(allocator: std.mem.Allocator, matches: []SearchFieldMatch) void {
    for (matches) |match| match.deinit(allocator);
}

fn isBinary(source: []const u8) bool {
    return std.mem.indexOfScalar(u8, source, 0) != null;
}

fn sideText(side: diff.SyntaxSide) []const u8 {
    return switch (side) {
        .old => "old",
        .new => "new",
    };
}

fn writeJsonField(writer: *std.Io.Writer, name: []const u8, value: []const u8, first: bool) !void {
    if (!first) try writer.writeByte(',');
    try types.writeJson(writer, name);
    try writer.writeByte(':');
    try types.writeJson(writer, value);
}

fn writeMatches(writer: *std.Io.Writer, matches: []const SearchFieldMatch) !void {
    try writer.writeByte('[');
    for (matches, 0..) |match, index| {
        if (index > 0) try writer.writeByte(',');
        try writer.writeAll("{\"field\":");
        try types.writeJson(writer, match.field);
        try writer.writeAll(",\"ranges\":");
        try writeRanges(writer, match.ranges);
        try writer.print(",\"score\":{}}}", .{match.score});
    }
    try writer.writeByte(']');
}

fn writeRanges(writer: *std.Io.Writer, ranges: []const SearchMatchRange) !void {
    try writer.writeByte('[');
    for (ranges, 0..) |range, index| {
        if (index > 0) try writer.writeByte(',');
        try writer.print("{{\"start\":{},\"end\":{}}}", .{ range.start, range.end });
    }
    try writer.writeByte(']');
}

fn writeChangedFile(writer: *std.Io.Writer, file: repository.ChangedFile) !void {
    try writer.writeByte('{');
    try writeJsonField(writer, "id", file.id, true);
    if (file.old_path) |path| try writeJsonField(writer, "oldPath", path, false);
    if (file.new_path) |path| try writeJsonField(writer, "newPath", path, false);
    try writeJsonField(writer, "status", file.statusString(), false);
    try writer.print(",\"additions\":{},\"deletions\":{}", .{ file.additions, file.deletions });
    try writeJsonField(writer, "signature", file.signature, false);
    try writer.writeByte('}');
}

fn writeMetadata(writer: *std.Io.Writer, metadata: FileSearchMetadata) !void {
    try writer.print(
        "{{\"reviewed\":{},\"commentCount\":{},\"unresolvedCount\":{},\"generated\":{},\"test\":{},\"docs\":{}}}",
        .{ metadata.reviewed, metadata.commentCount, metadata.unresolvedCount, metadata.generated, metadata.is_test, metadata.docs },
    );
}

test "search query parser handles phrases and negated filters" {
    var query = try parseQuery(std.testing.allocator, "button \"review agent\" -is:generated NOT path:vendor");
    defer query.deinit(std.testing.allocator);

    try std.testing.expectEqual(@as(usize, 1), query.terms.len);
    try std.testing.expectEqualStrings("button", query.terms[0]);
    try std.testing.expectEqual(@as(usize, 1), query.phrases.len);
    try std.testing.expectEqualStrings("review agent", query.phrases[0]);
    try std.testing.expectEqual(@as(usize, 2), query.filters.len);
    try std.testing.expect(query.filters[0].negated);
    try std.testing.expect(query.filters[1].negated);
}

test "search matcher supports fuzzy initials" {
    const result = try matchText(std.testing.allocator, "PullCommentRow", &.{"pcr"});
    defer result.deinit(std.testing.allocator);
    try std.testing.expect(result.matched);
}

test "file result cleanup frees matches before array storage" {
    var review_data = try ReviewData.init(std.testing.allocator, null, null);
    defer review_data.deinit(std.testing.allocator);
    var query = try parseQuery(std.testing.allocator, "foo");
    defer query.deinit(std.testing.allocator);
    const terms = try collectQueryTerms(std.testing.allocator, query);
    defer std.testing.allocator.free(terms);

    const file = repository.ChangedFile{
        .id = "src/foo.zig",
        .old_path = null,
        .new_path = "src/foo.zig",
        .status = .modified,
        .additions = 1,
        .deletions = 1,
        .signature = "sig",
    };
    const metadata = metadataForFile(file, review_data);
    var result = (try buildFileResult(std.testing.allocator, file, metadata, query, terms, &.{}, review_data)).?;
    defer result.deinit(std.testing.allocator);

    try std.testing.expect(std.mem.indexOf(u8, result.json, "\"id\":\"file:src/foo.zig\"") != null);
}
