const std = @import("std");

const reviews_dir = ".diffuse/reviews";
const sessions_dir = "sessions";
const active_file = "active-session";
const progress_file = "progress.json";
const reviewed_files_file = "reviewed-files.json";
const config_file = "config.json";

const default_config = "{\"provider\":\"opencode\",\"maxParallelAgents\":1,\"promptInstructions\":\"Prefer high-signal correctness, security, data-loss, race, and test-coverage findings. Do not comment on non-actionable observations.\"}";

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

pub fn readConfig(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8) ![]u8 {
    try ensureReviewsDir(allocator, io, repo_root);
    const path = try configPath(allocator, io, repo_root);
    defer allocator.free(path);
    return std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(1024 * 1024)) catch |err| switch (err) {
        error.FileNotFound => return try allocator.dupe(u8, default_config),
        else => return err,
    };
}

pub fn writeConfig(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, config_json: []const u8) ![]u8 {
    try ensureReviewsDir(allocator, io, repo_root);
    const path = try configPath(allocator, io, repo_root);
    defer allocator.free(path);
    try writeFileAtomic(allocator, io, path, config_json);
    return try allocator.dupe(u8, config_json);
}

pub fn readSession(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const path = try sessionPath(allocator, io, repo_root, session_id);
    defer allocator.free(path);
    return std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(4 * 1024 * 1024));
}

pub fn writeSession(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, session_json: []const u8) !void {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const path = try sessionPath(allocator, io, repo_root, session_id);
    defer allocator.free(path);
    try writeFileAtomic(allocator, io, path, session_json);
}

pub fn listThreads(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const dir_path = try threadsDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    try std.Io.Dir.createDirPath(.cwd(), io, dir_path);

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

pub fn listSessions(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8) ![]u8 {
    try ensureReviewsDir(allocator, io, repo_root);
    const sessions_root = try sessionsRoot(allocator, io, repo_root);
    defer allocator.free(sessions_root);

    var dir = std.Io.Dir.openDir(.cwd(), io, sessions_root, .{ .iterate = true }) catch |err| switch (err) {
        error.FileNotFound => return try allocator.dupe(u8, "[]"),
        else => return err,
    };
    defer dir.close(io);

    var result = std.Io.Writer.Allocating.init(allocator);
    errdefer result.deinit();
    try result.writer.writeByte('[');

    var first = true;
    var iterator = dir.iterate();
    while (try iterator.next(io)) |entry| {
        if (entry.kind != .directory) continue;
        const path = try sessionPath(allocator, io, repo_root, entry.name);
        defer allocator.free(path);
        const contents = std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(4 * 1024 * 1024)) catch |err| switch (err) {
            error.FileNotFound => continue,
            else => return err,
        };
        defer allocator.free(contents);

        if (!first) try result.writer.writeByte(',');
        first = false;
        try result.writer.writeAll(contents);
    }

    try result.writer.writeByte(']');
    return try result.toOwnedSlice();
}

pub fn readProgress(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) !?[]u8 {
    const path = try progressPath(allocator, io, repo_root, session_id);
    defer allocator.free(path);
    return std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(1024 * 1024)) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
}

pub fn writeProgress(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, progress_json: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const path = try progressPath(allocator, io, repo_root, session_id);
    defer allocator.free(path);
    try writeFileAtomic(allocator, io, path, progress_json);
    return try allocator.dupe(u8, progress_json);
}

pub fn readReviewedFiles(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) !?[]u8 {
    const path = try reviewedFilesPath(allocator, io, repo_root, session_id);
    defer allocator.free(path);
    return std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(1024 * 1024)) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
}

pub fn writeReviewedFiles(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, reviewed_files_json: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const path = try reviewedFilesPath(allocator, io, repo_root, session_id);
    defer allocator.free(path);
    try writeFileAtomic(allocator, io, path, reviewed_files_json);
    return try allocator.dupe(u8, reviewed_files_json);
}

pub fn writeAgentState(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, agent_run_id: []const u8, agent_json: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const dir_path = try agentsDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    try std.Io.Dir.createDirPath(.cwd(), io, dir_path);

    const file_name = try std.fmt.allocPrint(allocator, "{s}.json", .{agent_run_id});
    defer allocator.free(file_name);
    const path = try std.fs.path.join(allocator, &.{ dir_path, file_name });
    defer allocator.free(path);
    try writeFileAtomic(allocator, io, path, agent_json);
    return try allocator.dupe(u8, agent_json);
}

pub fn listAgentStates(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const dir_path = try agentsDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    try std.Io.Dir.createDirPath(.cwd(), io, dir_path);

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
        const contents = try std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(1024 * 1024));
        defer allocator.free(contents);

        if (!first) try result.writer.writeByte(',');
        first = false;
        try result.writer.writeAll(contents);
    }

    try result.writer.writeByte(']');
    return try result.toOwnedSlice();
}

pub fn listRuns(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const dir_path = try runsDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    try std.Io.Dir.createDirPath(.cwd(), io, dir_path);

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
        const contents = try std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(1024 * 1024));
        defer allocator.free(contents);

        if (!first) try result.writer.writeByte(',');
        first = false;
        try result.writer.writeAll(contents);
    }

    try result.writer.writeByte(']');
    return try result.toOwnedSlice();
}

pub fn writeRun(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, run_id: []const u8, run_json: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const dir_path = try runsDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    try std.Io.Dir.createDirPath(.cwd(), io, dir_path);

    const file_name = try std.fmt.allocPrint(allocator, "{s}.json", .{run_id});
    defer allocator.free(file_name);
    const path = try std.fs.path.join(allocator, &.{ dir_path, file_name });
    defer allocator.free(path);
    try writeFileAtomic(allocator, io, path, run_json);
    return try allocator.dupe(u8, run_json);
}

pub fn listChatMessages(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const dir_path = try chatMessagesDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    try std.Io.Dir.createDirPath(.cwd(), io, dir_path);

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
        const contents = try std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(1024 * 1024));
        defer allocator.free(contents);

        if (!first) try result.writer.writeByte(',');
        first = false;
        try result.writer.writeAll(contents);
    }

    try result.writer.writeByte(']');
    return try result.toOwnedSlice();
}

pub fn writeChatMessage(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, message_id: []const u8, message_json: []const u8) ![]u8 {
    try ensureSessionDir(allocator, io, repo_root, session_id);
    const dir_path = try chatMessagesDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    try std.Io.Dir.createDirPath(.cwd(), io, dir_path);

    const file_name = try std.fmt.allocPrint(allocator, "{s}.json", .{message_id});
    defer allocator.free(file_name);
    const path = try std.fs.path.join(allocator, &.{ dir_path, file_name });
    defer allocator.free(path);
    try writeFileAtomic(allocator, io, path, message_json);
    return try allocator.dupe(u8, message_json);
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
    const dir_path = try sessionDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    return std.fs.path.join(allocator, &.{ dir_path, "review.json" });
}

fn sessionDirPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const sessions_root = try sessionsRoot(allocator, io, repo_root);
    defer allocator.free(sessions_root);
    return std.fs.path.join(allocator, &.{ sessions_root, session_id });
}

fn threadPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8, thread_id: []const u8) ![]u8 {
    const dir_path = try threadsDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    try std.Io.Dir.createDirPath(.cwd(), io, dir_path);
    const file_name = try std.fmt.allocPrint(allocator, "{s}.json", .{thread_id});
    defer allocator.free(file_name);
    return std.fs.path.join(allocator, &.{ dir_path, file_name });
}

fn threadsDirPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const session_dir = try sessionDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(session_dir);
    return std.fs.path.join(allocator, &.{ session_dir, "threads" });
}

fn progressPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const dir_path = try sessionDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    return std.fs.path.join(allocator, &.{ dir_path, progress_file });
}

fn reviewedFilesPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const dir_path = try sessionDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    return std.fs.path.join(allocator, &.{ dir_path, reviewed_files_file });
}

fn configPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8) ![]u8 {
    const reviews_root = try reviewsRoot(allocator, io, repo_root);
    defer allocator.free(reviews_root);
    return std.fs.path.join(allocator, &.{ reviews_root, config_file });
}

fn agentsDirPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const dir_path = try sessionDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    return std.fs.path.join(allocator, &.{ dir_path, "agents" });
}

fn runsDirPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const dir_path = try sessionDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    return std.fs.path.join(allocator, &.{ dir_path, "runs" });
}

fn chatMessagesDirPath(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, session_id: []const u8) ![]u8 {
    const dir_path = try sessionDirPath(allocator, io, repo_root, session_id);
    defer allocator.free(dir_path);
    return std.fs.path.join(allocator, &.{ dir_path, "chat", "messages" });
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
    _ = io;
    return std.fs.path.join(allocator, &.{ repo_root, reviews_dir });
}

fn sessionsRoot(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8) ![]u8 {
    const reviews_root = try reviewsRoot(allocator, io, repo_root);
    defer allocator.free(reviews_root);
    return std.fs.path.join(allocator, &.{ reviews_root, sessions_dir });
}
