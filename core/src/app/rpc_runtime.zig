const std = @import("std");

const json_rpc = @import("../protocol/json_rpc.zig");
const session_mod = @import("../core/session.zig");
const syntax = @import("../core/syntax.zig");

pub const Runtime = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
    session: session_mod.Session,
    syntax_cache: syntax.Cache,
    syntax_cache_lock: std.Io.Mutex = .init,
    session_lock: std.Io.RwLock = .init,
    outbound_buffer: [128][]u8 = undefined,
    outbound: std.Io.Queue([]u8),

    pub fn init(runtime: *Runtime, allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map) void {
        runtime.allocator = allocator;
        runtime.io = io;
        runtime.environ_map = environ_map;
        runtime.session = session_mod.Session.init(allocator, io);
        runtime.syntax_cache = syntax.Cache.init(allocator);
        runtime.syntax_cache_lock = .init;
        runtime.session_lock = .init;
        runtime.outbound_buffer = undefined;
        runtime.outbound = .init(&runtime.outbound_buffer);
    }

    pub fn deinit(runtime: *Runtime) void {
        runtime.syntax_cache.deinit();
        runtime.session.deinit();
    }

    pub fn enqueue(runtime: *Runtime, message: []u8) (std.Io.QueueClosedError || std.Io.Cancelable)!void {
        errdefer runtime.allocator.free(message);
        try runtime.outbound.putOne(runtime.io, message);
    }

    pub fn enqueueError(runtime: *Runtime, id: i64, code: i64, message: []const u8) !void {
        const response = try buildError(runtime.allocator, id, code, message);
        try runtime.enqueue(response);
    }
};

pub fn buildError(allocator: std.mem.Allocator, id: i64, code: i64, message: []const u8) ![]u8 {
    var response = std.Io.Writer.Allocating.init(allocator);
    errdefer response.deinit();

    try json_rpc.writeError(&response.writer, id, code, message);
    return try response.toOwnedSlice();
}
