const std = @import("std");
const repository = @import("../core/repository.zig");
const diff = @import("../core/diff.zig");

pub const app_name = "diffuse";
pub const version = "0.1.0";

pub fn writeVersionJson(writer: anytype) !void {
    try writer.print("{{\"name\":\"{s}\",\"version\":\"{s}\"}}", .{ app_name, version });
}

pub fn writeOpenRepositoryJson(writer: anytype, repo: repository.Repository) !void {
    try writer.writeAll("{");
    try writeJsonStringField(writer, "root", repo.root, false);
    try writer.writeAll(",");
    try writeJsonStringField(writer, "head", repo.head, false);
    try writer.writeAll("}");
}

pub fn writeChangedFilesJson(writer: anytype, files: []const repository.ChangedFile) !void {
    try writer.writeByte('[');
    for (files, 0..) |file, index| {
        if (index > 0) try writer.writeByte(',');
        try writer.writeByte('{');
        try writeJsonStringField(writer, "id", file.id, false);
        try writer.writeByte(',');
        try writeOptionalJsonStringField(writer, "oldPath", file.old_path, false);
        try writer.writeByte(',');
        try writeOptionalJsonStringField(writer, "newPath", file.new_path, false);
        try writer.writeByte(',');
        try writeJsonStringField(writer, "status", file.statusString(), false);
        try writer.print(",\"additions\":{},\"deletions\":{}", .{ file.additions, file.deletions });
        try writer.writeByte('}');
    }
    try writer.writeByte(']');
}

pub fn writeDiffRenderModelJson(writer: anytype, model: diff.DiffRenderModel) !void {
    try writer.writeByte('{');
    try writeJsonStringField(writer, "fileId", model.file_id, false);
    try writer.writeAll(",\"mode\":\"split\",\"rows\":[");
    for (model.rows.items, 0..) |row, index| {
        if (index > 0) try writer.writeByte(',');
        try writer.writeByte('{');
        try writeJsonStringField(writer, "kind", row.kindString(), false);
        if (row.old_line) |line| try writer.print(",\"oldLine\":{}", .{line});
        if (row.new_line) |line| try writer.print(",\"newLine\":{}", .{line});
        if (row.old_text) |text| {
            try writer.writeByte(',');
            try writeJsonStringField(writer, "oldText", text, false);
        }
        if (row.new_text) |text| {
            try writer.writeByte(',');
            try writeJsonStringField(writer, "newText", text, false);
        }
        if (row.text) |text| {
            try writer.writeByte(',');
            try writeJsonStringField(writer, "text", text, false);
        }
        if (row.hunk_header) |text| {
            try writer.writeByte(',');
            try writeJsonStringField(writer, "hunkHeader", text, false);
        }
        try writer.writeByte('}');
    }
    try writer.writeAll("]}");
}

pub fn writeJsonStringField(writer: anytype, name: []const u8, value: []const u8, comma_before: bool) !void {
    if (comma_before) try writer.writeByte(',');
    try writer.print("\"{s}\":", .{name});
    try writeJsonString(writer, value);
}

pub fn writeOptionalJsonStringField(writer: anytype, name: []const u8, value: ?[]const u8, comma_before: bool) !void {
    if (comma_before) try writer.writeByte(',');
    try writer.print("\"{s}\":", .{name});
    if (value) |text| {
        try writeJsonString(writer, text);
    } else {
        try writer.writeAll("null");
    }
}

pub fn writeJsonString(writer: anytype, value: []const u8) !void {
    try writer.writeByte('"');
    for (value) |c| {
        switch (c) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            '\n' => try writer.writeAll("\\n"),
            '\r' => try writer.writeAll("\\r"),
            '\t' => try writer.writeAll("\\t"),
            0...8, 11...12, 14...0x1f => try writer.print("\\u{x:0>4}", .{c}),
            else => try writer.writeByte(c),
        }
    }
    try writer.writeByte('"');
}
