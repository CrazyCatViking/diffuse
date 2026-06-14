const std = @import("std");
const repository = @import("repository.zig");

const reviews_dir = "diffuse/reviews";
const active_file = "active-session";

pub fn getActiveSession(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8) !?[]u8 {
    const reviews_root = try reviewsRoot(allocator, io, repo_root);
    defer allocator.free(reviews_root);
    const active_path = try std.fs.path.join(allocator, &.{ reviews_root, active_file });
    defer allocator.free(active_path);

    const session_id_raw = std.Io.Dir.readFileAlloc(.cwd(), io, active_path, allocator, .limited(4096)) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
    defer allocator.free(session_id_raw);

    const session_id = std.mem.trim(u8, session_id_raw, "\r\n\t ");
    if (session_id.len == 0) return null;

    return readSession(allocator, io, repo_root, session_id) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
}

pub fn createSession(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, session_json: []const u8) ![]u8 {
    try ensureReviewsDir(allocator, io, repo_root);
    try writeSession(allocator, io, repo_root, session_id, session_json);

    const reviews_root = try reviewsRoot(allocator, io, repo_root);
    defer allocator.free(reviews_root);
    const active_path = try std.fs.path.join(allocator, &.{ reviews_root, active_file });
    defer allocator.free(active_path);
    try writeFileAtomic(allocator, io, active_path, session_id);

    return try allocator.dupe(u8, session_json);
}

pub fn readSession(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const path = try sessionPath(allocator, io, repo_root, session_id);
    defer allocator.free(path);
    return std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(4 * 1024 * 1024));
}

pub fn writeSession(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, session_json: []const u8) !void {
    try ensureReviewsDir(allocator, io, repo_root);
    const path = try sessionPath(allocator, io, repo_root, session_id);
    defer allocator.free(path);
    try writeFileAtomic(allocator, io, path, session_json);
}

pub fn listThreads(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const dir_path = try sessionDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);

    var dir = try std.Io.Dir.openDir(.cwd(), io, dir_path, .{ .iterate = true });
    defer dir.close(io);

    var result = std.Io.Writer.Allocating.init(allocator);
    errdefer result.deinit();
    try result.writer.writeByte('[');

    var first = true;
    var iterator = dir.iterate();
    while (try iterator.next(io)) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".json")) continue;
        const path = try std.fs.path.join(allocator, &.{ dir_path, entry.name });
        defer allocator.free(path);
        const contents = try std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(2 * 1024 * 1024));
        defer allocator.free(contents);

        if (!first) try result.writer.writeByte(',');
        first = false;
        try result.writer.writeAll(contents);
    }

    try result.writer.writeByte(']');
    return try result.toOwnedSlice();
}

pub fn writeThread(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, thread_id: []const u8, thread_json: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const path = try threadPath(allocator, io, repo_root, session_id, thread_id);
    defer allocator.free(path);
    try writeFileAtomic(allocator, io, path, thread_json);
    return try allocator.dupe(u8, thread_json);
}

fn ensureReviewsDir(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8) !void {
    const path = try reviewsRoot(allocator, io, repo_root);
    defer allocator.free(path);
    try std.Io.Dir.createDirPath(.cwd(), io, path);
}

fn ensureSessionDir(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) !void {
    try ensureReviewsDir(allocator, io, repo_root);
    const path = try sessionDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(path);
    try std.Io.Dir.createDirPath(.cwd(), io, path);
}

fn sessionPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const reviews_root = try reviewsRoot(allocator, io, repo_root);
    defer allocator.free(reviews_root);
    const file_name = try std.fmt.allocPrint(allocator, "{s}.json", .{session_id});
    defer allocator.free(file_name);
    return std.fs.path.join(allocator, &.{ reviews_root, file_name });
}

fn sessionDirPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const reviews_root = try reviewsRoot(allocator, io, repo_root);
    defer allocator.free(reviews_root);
    return std.fs.path.join(allocator, &.{ reviews_root, session_id });
}

fn threadPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, thread_id: []const u8) ![]u8 {
    const dir_path = try sessionDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    const file_name = try std.fmt.allocPrint(allocator, "{s}.json", .{thread_id});
    defer allocator.free(file_name);
    return std.fs.path.join(allocator, &.{ dir_path, file_name });
}

fn writeFileAtomic(allocator: std.mem.Allocator, io: std.Io, path: []const u8, contents: []const u8) !void {
    const temp_path = try std.fmt.allocPrint(allocator, "{s}.tmp", .{path});
    defer allocator.free(temp_path);

    try std.Io.Dir.writeFile(.cwd(), io, .{ .sub_path = temp_path, .data = contents });
    std.Io.Dir.rename(.cwd(), temp_path, .cwd(), path, io) catch |err| {
        std.Io.Dir.deleteFile(.cwd(), io, temp_path) catch {};
        return err;
    };
}

fn reviewsRoot(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8) ![]u8 {
    const output = try repository.git(allocator, io, repo_root, &.{ "rev-parse", "--git-common-dir" });
    defer allocator.free(output);
    const git_dir = std.mem.trim(u8, output, "\r\n\t ");
    const git_root = if (std.fs.path.isAbsolute(git_dir))
        try allocator.dupe(u8, git_dir)
    else
        try std.fs.path.join(allocator, &.{ repo_root, git_dir });
    defer allocator.free(git_root);
    return std.fs.path.join(allocator, &.{ git_root, reviews_dir });
}
