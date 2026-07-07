const std = @import("std");
const builtin = @import("builtin");

const diff = @import("diff.zig");
const repository = @import("repository.zig");
const types = @import("../protocol/types.zig");

pub const analysis_version: u32 = 1;
const cache_namespace = "diff-analysis";
const max_analysis_bytes = 32 * 1024 * 1024;

pub const Summary = struct {
    tokenChanges: u32 = 0,
    changeGroups: u32 = 0,
    movedBlocks: u32 = 0,
    semanticGroups: u32 = 0,
    crossFileLinks: u32 = 0,
    formatterOnlyGroups: u32 = 0,
    highImpactGroups: u32 = 0,
};

pub const AnalysisRow = struct {
    kind: []const u8,
    oldLine: ?u32 = null,
    newLine: ?u32 = null,
    oldDiffSpans: ?[]const diff.DiffTokenSpan = null,
    newDiffSpans: ?[]const diff.DiffTokenSpan = null,
    changeGroupId: ?[]const u8 = null,
    changeRole: ?[]const u8 = null,
    changeConfidence: ?f32 = null,
    symbol: ?[]const u8 = null,
    semanticSummary: ?[]const u8 = null,
};

pub const Analysis = struct {
    version: u32,
    fileId: []const u8,
    signature: []const u8,
    targetKey: []const u8,
    generatedAtMs: i64,
    summary: Summary,
    annotations: types.DiffAnnotations,
    rows: []const AnalysisRow,
};

pub const StatusRecord = struct {
    fileId: []const u8,
    signature: []const u8,
    status: []const u8,
    updatedAtMs: i64,
    message: ?[]const u8 = null,
};

pub fn targetKey(allocator: std.mem.Allocator, target: repository.DiffTarget, context: diff.DiffContextMode, head: []const u8) ![]u8 {
    var writer = std.Io.Writer.Allocating.init(allocator);
    errdefer writer.deinit();

    try writer.writer.print("v{}|head={s}|context={s}|staged={}|unstaged={}", .{
        analysis_version,
        head,
        if (context == .full) "full" else "diff",
        target.include_staged,
        target.include_unstaged,
    });
    try writer.writer.writeAll("|base=");
    if (target.base) |base| try writer.writer.writeAll(base);
    try writer.writer.writeAll("|compare=");
    if (target.compare) |compare| try writer.writer.writeAll(compare);

    const text = try writer.toOwnedSlice();
    defer allocator.free(text);
    return hashText(allocator, text);
}

pub fn writeAnalysis(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
    repo_root: []const u8,
    target_key: []const u8,
    file_id: []const u8,
    signature: []const u8,
    model: *const diff.DiffRenderModel,
) !void {
    var rows: std.ArrayList(AnalysisRow) = .empty;
    defer rows.deinit(allocator);
    for (model.rows.items) |row| {
        try rows.append(allocator, .{
            .kind = row.kindString(),
            .oldLine = row.old_line,
            .newLine = row.new_line,
            .oldDiffSpans = row.old_diff_spans,
            .newDiffSpans = row.new_diff_spans,
            .changeGroupId = row.change_group_id,
            .changeRole = row.change_role,
            .changeConfidence = row.change_confidence,
            .symbol = row.symbol,
            .semanticSummary = row.semantic_summary,
        });
    }

    var json = std.Io.Writer.Allocating.init(allocator);
    errdefer json.deinit();
    try types.writeJson(&json.writer, Analysis{
        .version = analysis_version,
        .fileId = file_id,
        .signature = signature,
        .targetKey = target_key,
        .generatedAtMs = nowMs(io),
        .summary = summaryForModel(model),
        .annotations = types.diffAnnotations(model.annotations),
        .rows = rows.items,
    });

    const contents = try json.toOwnedSlice();
    defer allocator.free(contents);
    const path = try cacheFilePath(allocator, environ_map, repo_root, target_key, file_id);
    defer allocator.free(path);
    try writeFileAtomic(allocator, io, path, contents);
}

pub fn readAnalysisIfFresh(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
    repo_root: []const u8,
    target_key: []const u8,
    file_id: []const u8,
    signature: []const u8,
) !?[]u8 {
    const raw = try readAnalysisRaw(allocator, io, environ_map, repo_root, target_key, file_id) orelse return null;
    errdefer allocator.free(raw);
    if (!rawMatchesSignature(allocator, raw, signature)) {
        allocator.free(raw);
        return null;
    }
    return raw;
}

pub fn cachedStatus(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
    repo_root: []const u8,
    target_key: []const u8,
    file_id: []const u8,
    signature: []const u8,
) ![]const u8 {
    const raw = try readAnalysisRaw(allocator, io, environ_map, repo_root, target_key, file_id) orelse return "missing";
    defer allocator.free(raw);
    return if (rawMatchesSignature(allocator, raw, signature)) "ready" else "stale";
}

fn readAnalysisRaw(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
    repo_root: []const u8,
    target_key: []const u8,
    file_id: []const u8,
) !?[]u8 {
    const path = try cacheFilePath(allocator, environ_map, repo_root, target_key, file_id);
    defer allocator.free(path);
    return std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(max_analysis_bytes)) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
}

fn rawMatchesSignature(allocator: std.mem.Allocator, raw: []const u8, signature: []const u8) bool {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{ .allocate = .alloc_always }) catch return false;
    defer parsed.deinit();
    const object = switch (parsed.value) {
        .object => |object| object,
        else => return false,
    };
    const version = switch (object.get("version") orelse return false) {
        .integer => |value| value,
        else => return false,
    };
    if (version != analysis_version) return false;
    const cached_signature = switch (object.get("signature") orelse return false) {
        .string => |value| value,
        else => return false,
    };
    return std.mem.eql(u8, cached_signature, signature);
}

fn summaryForModel(model: *const diff.DiffRenderModel) Summary {
    var summary: Summary = .{};
    for (model.rows.items) |row| {
        if ((row.old_diff_spans != null and row.old_diff_spans.?.len > 0) or (row.new_diff_spans != null and row.new_diff_spans.?.len > 0)) {
            summary.tokenChanges += 1;
        }
    }
    summary.changeGroups = @intCast(model.annotations.change_groups.items.len);
    for (model.annotations.change_groups.items) |group| {
        if (std.mem.eql(u8, group.kind, "moved-block") or std.mem.eql(u8, group.kind, "moved-and-edited-block")) {
            summary.movedBlocks += 1;
        } else if (std.mem.eql(u8, group.kind, "cross-file-move")) {
            summary.crossFileLinks += 1;
        } else if (std.mem.eql(u8, group.kind, "formatter-only")) {
            summary.formatterOnlyGroups += 1;
        } else {
            summary.semanticGroups += 1;
        }

        if (isHighImpactKind(group.kind)) summary.highImpactGroups += 1;
    }
    return summary;
}

fn isHighImpactKind(kind: []const u8) bool {
    return std.mem.eql(u8, kind, "condition-change") or
        std.mem.eql(u8, kind, "condition-inverted") or
        std.mem.eql(u8, kind, "control-flow-change") or
        std.mem.eql(u8, kind, "return-value-change") or
        std.mem.eql(u8, kind, "assignment-change") or
        std.mem.eql(u8, kind, "call-site-update");
}

fn cacheFilePath(allocator: std.mem.Allocator, environ_map: *const std.process.Environ.Map, repo_root: []const u8, target_key: []const u8, file_id: []const u8) ![]u8 {
    const root = try cacheRoot(allocator, environ_map);
    defer allocator.free(root);
    const repo_key = try hashText(allocator, repo_root);
    defer allocator.free(repo_key);
    const file_key = try hashText(allocator, file_id);
    defer allocator.free(file_key);
    const file_name = try std.fmt.allocPrint(allocator, "{s}.json", .{file_key});
    defer allocator.free(file_name);
    return std.fs.path.join(allocator, &.{ root, cache_namespace, "v1", repo_key, target_key, file_name });
}

fn cacheRoot(allocator: std.mem.Allocator, environ_map: *const std.process.Environ.Map) ![]u8 {
    if (builtin.os.tag == .windows) {
        if (environ_map.get("LOCALAPPDATA")) |local| return try std.fs.path.join(allocator, &.{ local, "Diffuse" });
        if (environ_map.get("USERPROFILE")) |home| return try std.fs.path.join(allocator, &.{ home, ".diffuse", "cache" });
    }

    if (environ_map.get("XDG_CACHE_HOME")) |cache_home| return try std.fs.path.join(allocator, &.{ cache_home, "diffuse" });
    if (environ_map.get("HOME")) |home| return try std.fs.path.join(allocator, &.{ home, ".cache", "diffuse" });
    if (environ_map.get("USERPROFILE")) |home| return try std.fs.path.join(allocator, &.{ home, ".diffuse", "cache" });
    return error.CacheUnavailable;
}

fn writeFileAtomic(allocator: std.mem.Allocator, io: std.Io, path: []const u8, contents: []const u8) !void {
    const dir_path = std.fs.path.dirname(path) orelse return error.InvalidPath;
    try std.Io.Dir.createDirPath(.cwd(), io, dir_path);

    const temp_path = try std.fmt.allocPrint(allocator, "{s}.tmp", .{path});
    defer allocator.free(temp_path);
    try std.Io.Dir.writeFile(.cwd(), io, .{ .sub_path = temp_path, .data = contents });
    std.Io.Dir.rename(.cwd(), temp_path, .cwd(), path, io) catch |err| {
        std.Io.Dir.deleteFile(.cwd(), io, temp_path) catch {};
        return err;
    };
}

pub fn hashText(allocator: std.mem.Allocator, text: []const u8) ![]u8 {
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(text, &digest, .{});
    const hex = std.fmt.bytesToHex(digest, .lower);
    return allocator.dupe(u8, &hex);
}

pub fn nowMs(io: std.Io) i64 {
    return std.Io.Timestamp.now(io, .real).toMilliseconds();
}
