const std = @import("std");

const json_rpc = @import("../protocol/json_rpc.zig");
const repository_watcher = @import("repository_watcher.zig");
const session_mod = @import("../core/session.zig");
const lsp = @import("../core/lsp.zig");
const syntax = @import("../core/syntax.zig");

pub const SearchJobState = struct {
    cancelled: bool = false,
};

pub const DiffAnalysisJobStatus = enum {
    queued,
    analyzing,
    failed,
};

pub const DiffAnalysisJobState = struct {
    status: DiffAnalysisJobStatus,
    message: ?[]const u8 = null,

    pub fn statusText(self: DiffAnalysisJobState) []const u8 {
        return switch (self.status) {
            .queued => "queued",
            .analyzing => "analyzing",
            .failed => "failed",
        };
    }
};

pub const Runtime = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
    session: session_mod.Session,
    syntax_cache: syntax.Cache,
    lsp_manager: lsp.Manager,
    repo_watcher: repository_watcher.RepositoryWatcher,
    syntax_cache_lock: std.Io.Mutex = .init,
    lsp_lock: std.Io.Mutex = .init,
    review_lock: std.Io.Mutex = .init,
    search_lock: std.Io.Mutex = .init,
    diff_analysis_lock: std.Io.Mutex = .init,
    session_lock: std.Io.RwLock = .init,
    search_jobs: std.StringHashMap(SearchJobState),
    diff_analysis_jobs: std.StringHashMap(DiffAnalysisJobState),
    search_group: std.Io.Group = .init,
    diff_analysis_group: std.Io.Group = .init,
    outbound_buffer: [128][]u8 = undefined,
    outbound: std.Io.Queue([]u8),

    pub fn init(runtime: *Runtime, allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map) void {
        runtime.allocator = allocator;
        runtime.io = io;
        runtime.environ_map = environ_map;
        runtime.session = session_mod.Session.init(allocator, io);
        runtime.syntax_cache = syntax.Cache.init(allocator);
        runtime.lsp_manager = lsp.Manager.init(allocator);
        runtime.syntax_cache_lock = .init;
        runtime.lsp_lock = .init;
        runtime.review_lock = .init;
        runtime.search_lock = .init;
        runtime.diff_analysis_lock = .init;
        runtime.session_lock = .init;
        runtime.search_jobs = std.StringHashMap(SearchJobState).init(allocator);
        runtime.diff_analysis_jobs = std.StringHashMap(DiffAnalysisJobState).init(allocator);
        runtime.search_group = .init;
        runtime.diff_analysis_group = .init;
        runtime.outbound_buffer = undefined;
        runtime.outbound = .init(&runtime.outbound_buffer);
        runtime.repo_watcher = repository_watcher.RepositoryWatcher.init(allocator, io, &runtime.outbound);
    }

    pub fn deinit(runtime: *Runtime) void {
        runtime.repo_watcher.deinit();
        var analysis_key_iter = runtime.diff_analysis_jobs.keyIterator();
        while (analysis_key_iter.next()) |key| runtime.allocator.free(key.*);
        runtime.diff_analysis_jobs.deinit();
        runtime.search_jobs.deinit();
        runtime.lsp_manager.deinit(runtime.io);
        runtime.syntax_cache.deinit();
        runtime.session.deinit();
    }

    pub fn cancelAndAwaitSearchJobs(runtime: *Runtime) !void {
        try runtime.search_lock.lock(runtime.io);
        var iterator = runtime.search_jobs.iterator();
        while (iterator.next()) |entry| entry.value_ptr.cancelled = true;
        runtime.search_lock.unlock(runtime.io);

        try runtime.search_group.await(runtime.io);
    }

    pub fn awaitDiffAnalysisJobs(runtime: *Runtime) !void {
        try runtime.diff_analysis_group.await(runtime.io);
    }

    pub fn enqueue(runtime: *Runtime, message: []u8) (std.Io.QueueClosedError || std.Io.Cancelable)!void {
        errdefer runtime.allocator.free(message);
        try runtime.outbound.putOne(runtime.io, message);
    }

    pub fn enqueueError(runtime: *Runtime, id: i64, code: i64, message: []const u8) !void {
        const response = try buildError(runtime.allocator, id, code, message);
        try runtime.enqueue(response);
    }

    pub fn enqueueParseError(runtime: *Runtime, message: []const u8) !void {
        const response = try buildParseError(runtime.allocator, message);
        try runtime.enqueue(response);
    }
};

pub fn buildError(allocator: std.mem.Allocator, id: i64, code: i64, message: []const u8) ![]u8 {
    var response = std.Io.Writer.Allocating.init(allocator);
    errdefer response.deinit();

    try json_rpc.writeError(&response.writer, id, code, message);
    return try response.toOwnedSlice();
}

pub fn buildParseError(allocator: std.mem.Allocator, message: []const u8) ![]u8 {
    var response = std.Io.Writer.Allocating.init(allocator);
    errdefer response.deinit();

    try json_rpc.writeErrorNullId(&response.writer, -32700, message);
    return try response.toOwnedSlice();
}
