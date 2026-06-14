const std = @import("std");
const builtin = @import("builtin");

const types = @import("../protocol/types.zig");

const linux = std.os.linux;

const in_close_write: u32 = 0x00000008;
const in_moved_from: u32 = 0x00000040;
const in_moved_to: u32 = 0x00000080;
const in_create: u32 = 0x00000100;
const in_delete: u32 = 0x00000200;
const in_delete_self: u32 = 0x00000400;
const in_move_self: u32 = 0x00000800;
const in_isdir: u32 = 0x40000000;
const in_nonblock: u32 = 0o4000;
const in_cloexec: u32 = 0o2000000;
const watch_mask = in_close_write | in_moved_from | in_moved_to | in_create | in_delete | in_delete_self | in_move_self;

pub const RepositoryWatcher = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    outbound: *std.Io.Queue([]u8),
    root: ?[]u8 = null,
    thread: ?std.Thread = null,
    stop_requested: std.atomic.Value(bool) = .init(false),

    pub fn init(allocator: std.mem.Allocator, io: std.Io, outbound: *std.Io.Queue([]u8)) RepositoryWatcher {
        return .{ .allocator = allocator, .io = io, .outbound = outbound };
    }

    pub fn deinit(self: *RepositoryWatcher) void {
        self.stop();
    }

    pub fn start(self: *RepositoryWatcher, root: []const u8) !void {
        if (self.root) |current| {
            if (std.mem.eql(u8, current, root) and self.thread != null) return;
        }

        self.stop();
        self.root = try self.allocator.dupe(u8, root);
        self.stop_requested.store(false, .release);
        self.thread = try std.Thread.spawn(.{}, threadMain, .{self});
    }

    fn stop(self: *RepositoryWatcher) void {
        self.stop_requested.store(true, .release);
        if (self.thread) |thread| {
            thread.join();
            self.thread = null;
        }
        if (self.root) |root| {
            self.allocator.free(root);
            self.root = null;
        }
    }

    fn threadMain(self: *RepositoryWatcher) void {
        if (builtin.os.tag != .linux) return;
        const root = self.root orelse return;

        const fd = inotifyInit() catch |err| {
            std.debug.print("repository watcher init failed: {s}\n", .{@errorName(err)});
            return;
        };
        defer _ = linux.close(fd);

        var paths = std.AutoHashMap(i32, []u8).init(self.allocator);
        defer {
            var iter = paths.valueIterator();
            while (iter.next()) |path| self.allocator.free(path.*);
            paths.deinit();
        }

        addWatchRecursive(self.allocator, self.io, fd, &paths, root) catch |err| {
            std.debug.print("repository watcher failed to watch {s}: {s}\n", .{ root, @errorName(err) });
            return;
        };

        var buffer: [32 * 1024]u8 align(@alignOf(linux.inotify_event)) = undefined;
        var changed_paths: std.ArrayList([]u8) = .empty;
        defer clearChangedPaths(self.allocator, &changed_paths);
        var pending = false;
        var quiet_ticks: u8 = 0;

        while (!self.stop_requested.load(.acquire)) {
            const read_len = std.posix.read(fd, &buffer) catch |err| switch (err) {
                error.WouldBlock => 0,
                else => break,
            };

            if (read_len > 0 and handleEvents(self.allocator, self.io, fd, &paths, root, &changed_paths, buffer[0..read_len])) {
                pending = true;
                quiet_ticks = 5;
            }

            if (pending) {
                if (quiet_ticks > 0) {
                    quiet_ticks -= 1;
                } else {
                    pending = false;
                    self.emitRepositoryChanged(root, changed_paths.items) catch |err| {
                        std.debug.print("repository watcher failed to emit change: {s}\n", .{@errorName(err)});
                    };
                    clearChangedPaths(self.allocator, &changed_paths);
                }
            }

            sleepMs(100);
        }
    }

    fn emitRepositoryChanged(self: *RepositoryWatcher, root: []const u8, changed_paths: []const []const u8) !void {
        var message = std.Io.Writer.Allocating.init(self.allocator);
        errdefer message.deinit();

        try message.writer.writeAll("{\"jsonrpc\":\"2.0\",\"method\":\"repository/changed\",\"params\":{");
        try message.writer.writeAll("\"root\":");
        try types.writeJson(&message.writer, root);
        try message.writer.writeAll(",\"paths\":");
        try types.writeJson(&message.writer, changed_paths);
        try message.writer.writeAll("}}\n");

        const owned = try message.toOwnedSlice();
        self.outbound.putOneUncancelable(self.io, owned) catch self.allocator.free(owned);
    }
};

fn inotifyInit() !i32 {
    const result = linux.inotify_init1(in_nonblock | in_cloexec);
    return switch (linux.errno(result)) {
        .SUCCESS => @intCast(result),
        else => error.InotifyInitFailed,
    };
}

fn inotifyAddWatch(fd: i32, path: []const u8) !i32 {
    const path_z = try std.heap.page_allocator.dupeZ(u8, path);
    defer std.heap.page_allocator.free(path_z);

    const result = linux.inotify_add_watch(fd, path_z.ptr, watch_mask);
    return switch (linux.errno(result)) {
        .SUCCESS => @intCast(result),
        else => error.InotifyAddWatchFailed,
    };
}

fn addWatchRecursive(allocator: std.mem.Allocator, io: std.Io, fd: i32, paths: *std.AutoHashMap(i32, []u8), root: []const u8) !void {
    try addWatchPath(allocator, fd, paths, root);

    var dir = try std.Io.Dir.openDirAbsolute(io, root, .{ .iterate = true });
    defer dir.close(io);

    var walker = try dir.walk(allocator);
    defer walker.deinit();

    while (try walker.next(io)) |entry| {
        if (entry.kind != .directory) continue;
        if (shouldIgnorePath(entry.path)) {
            walker.leave(io);
            continue;
        }

        const full_path = try std.Io.Dir.path.join(allocator, &.{ root, entry.path });
        defer allocator.free(full_path);
        addWatchPath(allocator, fd, paths, full_path) catch {};
    }
}

fn addWatchPath(allocator: std.mem.Allocator, fd: i32, paths: *std.AutoHashMap(i32, []u8), path: []const u8) !void {
    if (shouldIgnorePath(path)) return;
    const wd = try inotifyAddWatch(fd, path);
    const owned_path = try allocator.dupe(u8, path);
    errdefer allocator.free(owned_path);

    const result = try paths.getOrPut(wd);
    if (result.found_existing) allocator.free(result.value_ptr.*);
    result.value_ptr.* = owned_path;
}

fn handleEvents(allocator: std.mem.Allocator, io: std.Io, fd: i32, paths: *std.AutoHashMap(i32, []u8), root: []const u8, changed_paths: *std.ArrayList([]u8), bytes: []align(@alignOf(linux.inotify_event)) u8) bool {
    var offset: usize = 0;
    var changed = false;
    while (offset + @sizeOf(linux.inotify_event) <= bytes.len) {
        const event: *const linux.inotify_event = @ptrCast(@alignCast(bytes[offset..].ptr));
        const event_size = @sizeOf(linux.inotify_event) + event.len;
        if (offset + event_size > bytes.len) break;
        defer offset += event_size;

        const parent = paths.get(event.wd) orelse continue;
        const name = event.getName() orelse "";
        if (shouldIgnorePath(name)) continue;
        appendChangedPath(allocator, changed_paths, root, parent, name) catch {};

        if ((event.mask & in_isdir) != 0 and (event.mask & (in_create | in_moved_to)) != 0 and name.len > 0) {
            const child_path = std.Io.Dir.path.join(allocator, &.{ parent, name }) catch continue;
            defer allocator.free(child_path);
            addWatchRecursive(allocator, io, fd, paths, child_path) catch {};
        }

        changed = true;
    }
    return changed;
}

fn appendChangedPath(allocator: std.mem.Allocator, changed_paths: *std.ArrayList([]u8), root: []const u8, parent: []const u8, name: []const u8) !void {
    const absolute_path = if (name.len > 0) try std.Io.Dir.path.join(allocator, &.{ parent, name }) else try allocator.dupe(u8, parent);
    defer allocator.free(absolute_path);

    var relative_path = absolute_path;
    if (std.mem.startsWith(u8, absolute_path, root)) {
        relative_path = absolute_path[root.len..];
        if (relative_path.len > 0 and (relative_path[0] == '/' or relative_path[0] == '\\')) relative_path = relative_path[1..];
    }
    if (relative_path.len == 0 or shouldIgnorePath(relative_path)) return;

    try changed_paths.append(allocator, try allocator.dupe(u8, relative_path));
}

fn clearChangedPaths(allocator: std.mem.Allocator, changed_paths: *std.ArrayList([]u8)) void {
    for (changed_paths.items) |path| allocator.free(path);
    changed_paths.clearRetainingCapacity();
}

fn shouldIgnorePath(path: []const u8) bool {
    return std.mem.indexOf(u8, path, "node_modules") != null or
        std.mem.indexOf(u8, path, ".zig-cache") != null or
        std.mem.indexOf(u8, path, "zig-out") != null or
        std.mem.indexOf(u8, path, ".git/objects") != null or
        std.mem.indexOf(u8, path, ".git/logs") != null;
}

fn sleepMs(ms: isize) void {
    var request = linux.timespec{ .sec = @divTrunc(ms, 1000), .nsec = @rem(ms, 1000) * std.time.ns_per_ms };
    while (linux.errno(linux.nanosleep(&request, &request)) == .INTR) {}
}
