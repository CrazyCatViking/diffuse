const std = @import("std");
const repository = @import("repository.zig");

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
    rows: std.ArrayList(DiffRow),

    pub fn deinit(self: *DiffRenderModel, allocator: std.mem.Allocator) void {
        allocator.free(self.file_id);
        for (self.rows.items) |row| {
            if (row.old_text) |text| allocator.free(text);
            if (row.new_text) |text| allocator.free(text);
            if (row.text) |text| allocator.free(text);
            if (row.hunk_header) |text| allocator.free(text);
        }
        self.rows.deinit(allocator);
    }
};

pub fn getDiffRenderModel(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, file_id: []const u8, path: []const u8) !DiffRenderModel {
    const output = try repository.git(allocator, io, repo_root, &.{ "diff", "--", path });
    defer allocator.free(output);

    var model = DiffRenderModel{
        .file_id = try allocator.dupe(u8, file_id),
        .rows = .empty,
    };
    errdefer model.deinit(allocator);

    try parseUnifiedDiff(allocator, output, &model.rows);
    return model;
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
