const std = @import("std");
const repository = @import("../core/repository.zig");
const diff = @import("../core/diff.zig");

pub const app_name = "diffuse";
pub const version = "0.1.0";

const json_options: std.json.Stringify.Options = .{ .emit_null_optional_fields = false };

pub const VersionInfo = struct {
    name: []const u8,
    version: []const u8,
};

pub const OpenRepositoryResult = struct {
    root: []const u8,
    head: []const u8,
};

pub const ChangedFile = struct {
    id: []const u8,
    oldPath: ?[]const u8,
    newPath: ?[]const u8,
    status: []const u8,
    additions: u32,
    deletions: u32,
};

pub const DiffRenderModel = struct {
    fileId: []const u8,
    mode: []const u8,
    rows: []const DiffRow,
};

pub const DiffRow = struct {
    kind: []const u8,
    oldLine: ?u32 = null,
    newLine: ?u32 = null,
    oldText: ?[]const u8 = null,
    newText: ?[]const u8 = null,
    text: ?[]const u8 = null,
    hunkHeader: ?[]const u8 = null,
};

pub fn versionInfo() VersionInfo {
    return .{
        .name = app_name,
        .version = version,
    };
}

pub fn openRepositoryResult(repo: repository.Repository) OpenRepositoryResult {
    return .{
        .root = repo.root,
        .head = repo.head,
    };
}

pub fn changedFile(file: repository.ChangedFile) ChangedFile {
    return .{
        .id = file.id,
        .oldPath = file.old_path,
        .newPath = file.new_path,
        .status = file.statusString(),
        .additions = file.additions,
        .deletions = file.deletions,
    };
}

pub fn diffRow(row: diff.DiffRow) DiffRow {
    return .{
        .kind = row.kindString(),
        .oldLine = row.old_line,
        .newLine = row.new_line,
        .oldText = row.old_text,
        .newText = row.new_text,
        .text = row.text,
        .hunkHeader = row.hunk_header,
    };
}

pub fn writeJsonString(writer: *std.Io.Writer, value: []const u8) !void {
    try writeJson(writer, value);
}

pub fn writeJson(writer: *std.Io.Writer, value: anytype) !void {
    try std.json.Stringify.value(value, json_options, writer);
}
