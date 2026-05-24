const std = @import("std");
const repository = @import("repository.zig");

pub const Session = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    repo: ?repository.Repository = null,

    pub fn init(allocator: std.mem.Allocator, io: std.Io) Session {
        return .{ .allocator = allocator, .io = io };
    }

    pub fn deinit(self: *Session) void {
        if (self.repo) |*repo| repo.deinit();
    }

    pub fn openRepository(self: *Session, path: []const u8) !repository.Repository {
        if (self.repo) |*repo| repo.deinit();
        self.repo = try repository.open(self.allocator, self.io, path);
        return self.repo.?;
    }

    pub fn requireRepo(self: *Session) !*repository.Repository {
        if (self.repo) |*repo| return repo;
        return error.RepositoryNotOpen;
    }
};
