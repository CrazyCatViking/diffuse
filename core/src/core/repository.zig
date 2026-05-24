const std = @import("std");

pub const FileStatus = enum {
    added,
    modified,
    deleted,
    renamed,

    pub fn fromPorcelain(status: []const u8) FileStatus {
        if (std.mem.indexOfScalar(u8, status, 'R') != null) return .renamed;
        if (std.mem.indexOfScalar(u8, status, 'A') != null or std.mem.indexOfScalar(u8, status, '?') != null) return .added;
        if (std.mem.indexOfScalar(u8, status, 'D') != null) return .deleted;
        return .modified;
    }
};

pub const ChangedFile = struct {
    id: []const u8,
    old_path: ?[]const u8,
    new_path: ?[]const u8,
    status: FileStatus,
    additions: u32,
    deletions: u32,

    pub fn statusString(self: ChangedFile) []const u8 {
        return switch (self.status) {
            .added => "added",
            .modified => "modified",
            .deleted => "deleted",
            .renamed => "renamed",
        };
    }
};

pub const Repository = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    root: []const u8,
    head: []const u8,

    pub fn deinit(self: *Repository) void {
        self.allocator.free(self.root);
        self.allocator.free(self.head);
    }

    pub fn listChangedFiles(self: *Repository) ![]ChangedFile {
        var files: std.ArrayList(ChangedFile) = .empty;
        errdefer freeChangedFiles(self.allocator, files.items);

        const status_output = try git(self.allocator, self.io, self.root, &.{ "status", "--porcelain=v1", "-uall" });
        defer self.allocator.free(status_output);

        const numstat_output = try git(self.allocator, self.io, self.root, &.{ "diff", "--numstat" });
        defer self.allocator.free(numstat_output);

        var lines = std.mem.splitScalar(u8, status_output, '\n');
        while (lines.next()) |line| {
            if (line.len < 4) continue;

            const status_text = line[0..2];
            const status = FileStatus.fromPorcelain(status_text);
            const raw_path = std.mem.trim(u8, line[3..], " \t");
            if (raw_path.len == 0) continue;

            var old_path: ?[]const u8 = null;
            var new_path_text = raw_path;
            if (std.mem.indexOf(u8, raw_path, " -> ")) |idx| {
                old_path = try self.allocator.dupe(u8, raw_path[0..idx]);
                new_path_text = raw_path[idx + 4 ..];
            }

            const path_copy = try self.allocator.dupe(u8, new_path_text);
            const id_copy = try self.allocator.dupe(u8, new_path_text);
            const counts = parseNumstat(numstat_output, new_path_text);

            try files.append(self.allocator, .{
                .id = id_copy,
                .old_path = old_path,
                .new_path = path_copy,
                .status = status,
                .additions = counts.additions,
                .deletions = counts.deletions,
            });
        }

        return try files.toOwnedSlice(self.allocator);
    }
};

pub fn open(allocator: std.mem.Allocator, io: std.Io, path: []const u8) !Repository {
    const root_output = try git(allocator, io, path, &.{ "rev-parse", "--show-toplevel" });
    defer allocator.free(root_output);
    const root_trimmed = std.mem.trim(u8, root_output, "\r\n");

    const head_output = git(allocator, io, root_trimmed, &.{ "rev-parse", "--short", "HEAD" }) catch try allocator.dupe(u8, "");
    defer allocator.free(head_output);
    const head_trimmed = std.mem.trim(u8, head_output, "\r\n");

    return .{
        .allocator = allocator,
        .io = io,
        .root = try allocator.dupe(u8, root_trimmed),
        .head = try allocator.dupe(u8, head_trimmed),
    };
}

pub fn freeChangedFiles(allocator: std.mem.Allocator, files: []ChangedFile) void {
    for (files) |file| {
        allocator.free(file.id);
        if (file.old_path) |path| allocator.free(path);
        if (file.new_path) |path| allocator.free(path);
    }
    allocator.free(files);
}

pub fn git(allocator: std.mem.Allocator, io: std.Io, repo_path: []const u8, args: []const []const u8) ![]u8 {
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);

    try argv.append(allocator, "git");
    try argv.append(allocator, "-C");
    try argv.append(allocator, repo_path);
    for (args) |arg| try argv.append(allocator, arg);

    const result = try std.process.run(allocator, io, .{
        .argv = argv.items,
        .stdout_limit = .limited(20 * 1024 * 1024),
        .stderr_limit = .limited(1024 * 1024),
    });
    defer allocator.free(result.stderr);

    switch (result.term) {
        .exited => |code| if (code != 0) {
            allocator.free(result.stdout);
            return error.GitCommandFailed;
        },
        else => {
            allocator.free(result.stdout);
            return error.GitCommandFailed;
        },
    }

    return result.stdout;
}

const Counts = struct { additions: u32 = 0, deletions: u32 = 0 };

fn parseNumstat(output: []const u8, path: []const u8) Counts {
    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var fields = std.mem.splitScalar(u8, line, '\t');
        const additions_text = fields.next() orelse continue;
        const deletions_text = fields.next() orelse continue;
        const file_path = fields.next() orelse continue;
        if (!std.mem.eql(u8, file_path, path)) continue;

        return .{
            .additions = std.fmt.parseInt(u32, additions_text, 10) catch 0,
            .deletions = std.fmt.parseInt(u32, deletions_text, 10) catch 0,
        };
    }
    return .{};
}
