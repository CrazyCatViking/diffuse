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

pub const DiffTarget = struct {
    base: ?[]const u8 = null,
    compare: ?[]const u8 = null,
    include_staged: bool = true,
    include_unstaged: bool = true,
};

pub const DiffTargetDefaults = struct {
    base: []const u8,
    compare: ?[]const u8 = null,
    include_staged: bool,
    include_unstaged: bool,
    dirty: bool,
    upstream: ?[]const u8 = null,

    pub fn deinit(self: *DiffTargetDefaults, allocator: std.mem.Allocator) void {
        allocator.free(self.base);
        if (self.compare) |value| allocator.free(value);
        if (self.upstream) |value| allocator.free(value);
    }
};

pub const BranchInfo = struct {
    name: []const u8,
    current: bool,

    pub fn deinit(self: *BranchInfo, allocator: std.mem.Allocator) void {
        allocator.free(self.name);
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

    pub fn listChangedFiles(self: *Repository, target: DiffTarget) ![]ChangedFile {
        var files: std.ArrayList(ChangedFile) = .empty;
        errdefer freeChangedFiles(self.allocator, files.items);

        const name_status_output = try self.gitDiff(target, &.{ "--name-status", "-M" }, null);
        defer self.allocator.free(name_status_output);
        const numstat_output = try self.gitDiff(target, &.{"--numstat"}, null);
        defer self.allocator.free(numstat_output);

        var lines = std.mem.splitScalar(u8, name_status_output, '\n');
        while (lines.next()) |line| {
            if (line.len == 0) continue;

            var fields = std.mem.splitScalar(u8, line, '\t');
            const status_text = fields.next() orelse continue;
            const status = fileStatusFromNameStatus(status_text);

            var old_path: ?[]const u8 = null;
            const first_path = fields.next() orelse continue;
            const new_path_text = if (status == .renamed) renamed: {
                old_path = try self.allocator.dupe(u8, first_path);
                break :renamed fields.next() orelse first_path;
            } else first_path;

            if (new_path_text.len == 0) {
                if (old_path) |path| self.allocator.free(path);
                continue;
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

    pub fn gitDiff(self: *Repository, target: DiffTarget, flags: []const []const u8, path: ?[]const u8) ![]u8 {
        var args: std.ArrayList([]const u8) = .empty;
        defer args.deinit(self.allocator);

        try args.append(self.allocator, "diff");
        for (flags) |flag| try args.append(self.allocator, flag);

        if (target.compare) |compare| {
            const base = target.base orelse "HEAD";
            const range = try std.fmt.allocPrint(self.allocator, "{s}...{s}", .{ base, compare });
            defer self.allocator.free(range);
            try args.append(self.allocator, range);
        } else if (target.include_staged and target.include_unstaged) {
            try args.append(self.allocator, target.base orelse "HEAD");
        } else if (target.include_staged) {
            try args.append(self.allocator, "--cached");
            try args.append(self.allocator, target.base orelse "HEAD");
        } else if (!target.include_unstaged) {
            try args.append(self.allocator, "--cached");
            try args.append(self.allocator, "HEAD");
            try args.append(self.allocator, "--diff-filter=d");
            try args.append(self.allocator, "--no-ext-diff");
            try args.append(self.allocator, "--exit-code");
        }

        if (path) |file_path| {
            try args.append(self.allocator, "--");
            try args.append(self.allocator, file_path);
        }

        if (!target.include_staged and !target.include_unstaged and target.compare == null) return try self.allocator.dupe(u8, "");
        return git(self.allocator, self.io, self.root, args.items);
    }

    pub fn diffTargetDefaults(self: *Repository) !DiffTargetDefaults {
        const status_output = try git(self.allocator, self.io, self.root, &.{ "status", "--porcelain=v1", "-uall" });
        defer self.allocator.free(status_output);
        const dirty = std.mem.trim(u8, status_output, "\r\n").len > 0;
        const upstream = try self.resolveDefaultUpstream();
        errdefer if (upstream) |value| self.allocator.free(value);

        if (dirty) {
            return .{
                .base = try self.allocator.dupe(u8, "HEAD"),
                .include_staged = true,
                .include_unstaged = true,
                .dirty = true,
                .upstream = upstream,
            };
        }

        return .{
            .base = if (upstream) |value| try self.allocator.dupe(u8, value) else try self.allocator.dupe(u8, "HEAD"),
            .compare = try self.allocator.dupe(u8, "HEAD"),
            .include_staged = false,
            .include_unstaged = false,
            .dirty = false,
            .upstream = upstream,
        };
    }

    pub fn listBranches(self: *Repository) ![]BranchInfo {
        const output = try git(self.allocator, self.io, self.root, &.{ "for-each-ref", "--format=%(refname:short)%09%(HEAD)", "refs/heads", "refs/remotes" });
        defer self.allocator.free(output);

        var result: std.ArrayList(BranchInfo) = .empty;
        errdefer freeBranches(self.allocator, result.items);

        var seen = std.StringHashMap(void).init(self.allocator);
        defer seen.deinit();

        var lines = std.mem.splitScalar(u8, output, '\n');
        while (lines.next()) |line| {
            if (line.len == 0) continue;

            var fields = std.mem.splitScalar(u8, line, '\t');
            const name = fields.next() orelse continue;
            if (name.len == 0 or std.mem.endsWith(u8, name, "/HEAD")) continue;
            if (seen.contains(name)) continue;

            try seen.put(name, {});
            try result.append(self.allocator, .{
                .name = try self.allocator.dupe(u8, name),
                .current = std.mem.eql(u8, fields.next() orelse "", "*"),
            });
        }

        sortBranches(result.items);
        return try result.toOwnedSlice(self.allocator);
    }

    fn resolveDefaultUpstream(self: *Repository) !?[]u8 {
        if (git(self.allocator, self.io, self.root, &.{ "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}" })) |output| {
            defer self.allocator.free(output);
            const trimmed = std.mem.trim(u8, output, "\r\n");
            if (trimmed.len > 0) return try self.allocator.dupe(u8, trimmed);
        } else |_| {}

        if (refExists(self.allocator, self.io, self.root, "origin/main")) return try self.allocator.dupe(u8, "origin/main");
        if (refExists(self.allocator, self.io, self.root, "origin/master")) return try self.allocator.dupe(u8, "origin/master");
        return null;
    }
};

pub fn freeBranches(allocator: std.mem.Allocator, branches: []BranchInfo) void {
    for (branches) |*branch| branch.deinit(allocator);
    allocator.free(branches);
}

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

fn fileStatusFromNameStatus(status: []const u8) FileStatus {
    if (status.len > 0 and status[0] == 'R') return .renamed;
    if (status.len > 0 and status[0] == 'A') return .added;
    if (status.len > 0 and status[0] == 'D') return .deleted;
    return .modified;
}

fn refExists(allocator: std.mem.Allocator, io: std.Io, repo_path: []const u8, ref: []const u8) bool {
    const output = git(allocator, io, repo_path, &.{ "rev-parse", "--verify", ref }) catch return false;
    allocator.free(output);
    return true;
}

fn sortBranches(branches: []BranchInfo) void {
    std.mem.sort(BranchInfo, branches, {}, struct {
        fn lessThan(_: void, left: BranchInfo, right: BranchInfo) bool {
            if (left.current != right.current) return left.current;
            return std.ascii.lessThanIgnoreCase(left.name, right.name);
        }
    }.lessThan);
}

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
