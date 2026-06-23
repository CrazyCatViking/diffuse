const std = @import("std");

const repository = @import("../core/repository.zig");
const runtime_mod = @import("rpc_runtime.zig");

const Runtime = runtime_mod.Runtime;

pub const Snapshot = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    root: []const u8,
    head: []const u8,

    pub fn deinit(self: *Snapshot) void {
        self.allocator.free(self.root);
        self.allocator.free(self.head);
    }

    pub fn toRepository(self: Snapshot) repository.Repository {
        return .{
            .allocator = self.allocator,
            .io = self.io,
            .root = self.root,
            .head = self.head,
        };
    }
};

pub fn snapshot(runtime: *Runtime) !Snapshot {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const root = try runtime.allocator.dupe(u8, repo.root);
    errdefer runtime.allocator.free(root);
    const head = try runtime.allocator.dupe(u8, repo.head);
    return .{
        .allocator = runtime.allocator,
        .io = repo.io,
        .root = root,
        .head = head,
    };
}
