const std = @import("std");

const diff = @import("../core/diff.zig");
const json_rpc = @import("../protocol/json_rpc.zig");
const repository = @import("../core/repository.zig");
const review = @import("../core/review.zig");
const runtime_mod = @import("rpc_runtime.zig");
const search = @import("../core/search.zig");
const events = @import("rpc_events.zig");
const params = @import("rpc_params.zig");
const repo_snapshot = @import("rpc_repo.zig");

const Runtime = runtime_mod.Runtime;
const batch_size = 75;

const SearchRequest = struct {
    search_id: []u8,
    session_id: []u8,
    query: []u8,
    mode: search.SearchMode,
    filters: []search.SearchFilterKind,
    target: repository.DiffTarget,
    root: []u8,

    fn deinit(self: *SearchRequest, allocator: std.mem.Allocator) void {
        allocator.free(self.search_id);
        allocator.free(self.session_id);
        allocator.free(self.query);
        allocator.free(self.filters);
        if (self.target.base) |base| allocator.free(base);
        if (self.target.compare) |compare| allocator.free(compare);
        allocator.free(self.root);
    }
};

const SearchStats = struct {
    total_files: u32 = 0,
    scanned_files: u32 = 0,
    emitted_results: u32 = 0,
};

pub fn register(server: anytype) !void {
    try server.handle("startSearch", startSearch);
    try server.handle("cancelSearch", cancelSearch);
}

fn startSearch(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    var owned = try parseSearchRequest(runtime, request);
    var request_moved = false;
    errdefer if (!request_moved) owned.deinit(runtime.allocator);

    try runtime.search_lock.lock(runtime.io);
    if (runtime.search_jobs.contains(owned.search_id)) {
        runtime.search_lock.unlock(runtime.io);
        return error.InvalidParam;
    }
    runtime.search_jobs.put(owned.search_id, .{}) catch |err| {
        runtime.search_lock.unlock(runtime.io);
        return err;
    };
    runtime.search_lock.unlock(runtime.io);

    var job_registered = true;
    errdefer if (job_registered) removeSearchJob(runtime, owned.search_id);

    try events.emitSearchStarted(runtime, owned.search_id);

    runtime.search_group.concurrent(runtime.io, searchWorker, .{ runtime, owned }) catch |err| {
        return err;
    };
    request_moved = true;
    job_registered = false;

    try writer.writeAll("{\"searchId\":");
    try @import("../protocol/types.zig").writeJson(writer, owned.search_id);
    try writer.writeByte('}');
}

fn cancelSearch(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const search_id = try json_rpc.getStringParam(request, "searchId");
    var cancelled = false;

    try runtime.search_lock.lock(runtime.io);
    if (runtime.search_jobs.getPtr(search_id)) |job| {
        job.cancelled = true;
        cancelled = true;
    }
    runtime.search_lock.unlock(runtime.io);

    try writer.print("{{\"cancelled\":{}}}", .{cancelled});
}

fn parseSearchRequest(runtime: *Runtime, request: json_rpc.Request) !SearchRequest {
    const query = try json_rpc.getStringParam(request, "query");
    const mode = try search.parseMode(try json_rpc.getStringParam(request, "mode"));
    const session_id = try json_rpc.getStringParam(request, "sessionId");
    const target = try copyTarget(runtime.allocator, try params.getDiffTarget(request));
    errdefer freeTarget(runtime.allocator, target);
    const filters = try parseFilters(runtime.allocator, request);
    errdefer runtime.allocator.free(filters);

    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const search_id = if (try params.getOptionalStringParam(request, "searchId")) |value|
        try runtime.allocator.dupe(u8, value)
    else
        try std.fmt.allocPrint(runtime.allocator, "search-{d}-{d}", .{ request.id, std.Io.Timestamp.now(runtime.io, .real).toMilliseconds() });
    errdefer runtime.allocator.free(search_id);

    return .{
        .search_id = search_id,
        .session_id = try runtime.allocator.dupe(u8, session_id),
        .query = try runtime.allocator.dupe(u8, query),
        .mode = mode,
        .filters = filters,
        .target = target,
        .root = try runtime.allocator.dupe(u8, snapshot.root),
    };
}

fn parseFilters(allocator: std.mem.Allocator, request: json_rpc.Request) ![]search.SearchFilterKind {
    const params_object = try json_rpc.paramsObject(request);
    const filters_value = params_object.get("filters") orelse return try allocator.alloc(search.SearchFilterKind, 0);
    const filters_array = switch (filters_value) {
        .array => |array| array,
        else => return error.InvalidParam,
    };

    var filters: std.ArrayList(search.SearchFilterKind) = .empty;
    errdefer filters.deinit(allocator);
    for (filters_array.items) |item| {
        const text = switch (item) {
            .string => |value| value,
            else => return error.InvalidParam,
        };
        try filters.append(allocator, try search.parseFilterKind(text));
    }
    return try filters.toOwnedSlice(allocator);
}

fn copyTarget(allocator: std.mem.Allocator, target: repository.DiffTarget) !repository.DiffTarget {
    return .{
        .base = if (target.base) |value| try allocator.dupe(u8, value) else null,
        .compare = if (target.compare) |value| try allocator.dupe(u8, value) else null,
        .include_staged = target.include_staged,
        .include_unstaged = target.include_unstaged,
    };
}

fn freeTarget(allocator: std.mem.Allocator, target: repository.DiffTarget) void {
    if (target.base) |base| allocator.free(base);
    if (target.compare) |compare| allocator.free(compare);
}

fn searchWorker(runtime: *Runtime, request_arg: SearchRequest) void {
    var request = request_arg;
    defer request.deinit(runtime.allocator);
    defer removeSearchJob(runtime, request.search_id);

    var stats: SearchStats = .{};
    runSearch(runtime, request, &stats) catch |err| {
        if (err == error.SearchCancelled) {
            events.emitSearchCancelled(runtime, request.search_id, stats.scanned_files, stats.emitted_results) catch {};
            return;
        }
        events.emitSearchError(runtime, request.search_id, @errorName(err)) catch {};
        return;
    };

    events.emitSearchDone(runtime, request.search_id, stats.emitted_results, stats.scanned_files) catch {};
}

fn runSearch(runtime: *Runtime, request: SearchRequest, stats: *SearchStats) !void {
    var repo = repository.Repository{ .allocator = runtime.allocator, .io = runtime.io, .root = request.root, .head = "" };
    const files = try repo.listChangedFiles(request.target);
    defer repository.freeChangedFiles(runtime.allocator, files);
    stats.total_files = @intCast(files.len);

    var reviewed_json: ?[]u8 = null;
    defer if (reviewed_json) |json| runtime.allocator.free(json);
    var threads_json: ?[]u8 = null;
    defer if (threads_json) |json| runtime.allocator.free(json);
    if (request.session_id.len > 0) {
        reviewed_json = try review.readReviewedFiles(runtime.allocator, runtime.io, request.root, request.session_id);
        threads_json = try review.listThreads(runtime.allocator, runtime.io, request.root, request.session_id);
    }

    var review_data = try search.ReviewData.init(runtime.allocator, reviewed_json, threads_json);
    defer review_data.deinit(runtime.allocator);
    var query = try search.parseQuery(runtime.allocator, request.query);
    defer query.deinit(runtime.allocator);
    const query_terms = try search.collectQueryTerms(runtime.allocator, query);
    defer runtime.allocator.free(query_terms);
    const comment_terms = try search.collectCommentTerms(runtime.allocator, query);
    defer runtime.allocator.free(comment_terms);

    if (request.mode.includesFiles()) try runFilePhase(runtime, request, files, review_data, query, query_terms, stats);
    if (request.mode.includesContent()) try runContentPhase(runtime, request, files, review_data, query, query_terms, stats);
    if (request.mode.includesComments()) try runCommentPhase(runtime, request, files, review_data, query, comment_terms, stats);
}

fn runFilePhase(
    runtime: *Runtime,
    request: SearchRequest,
    files: []const repository.ChangedFile,
    review_data: search.ReviewData,
    query: search.ParsedQuery,
    query_terms: []const []const u8,
    stats: *SearchStats,
) !void {
    var results: std.ArrayList(search.ResultJson) = .empty;
    defer freeResultItems(runtime.allocator, &results);

    for (files) |file| {
        if (isSearchCancelled(runtime, request.search_id)) break;
        const metadata = search.metadataForFile(file, review_data);
        if (try search.buildFileResult(runtime.allocator, file, metadata, query, query_terms, request.filters, review_data)) |result| {
            try results.append(runtime.allocator, result);
        }
    }

    search.sortResults(results.items);
    try emitResultBatches(runtime, request.search_id, results.items, stats);
    if (isSearchCancelled(runtime, request.search_id)) return error.SearchCancelled;
}

fn runContentPhase(
    runtime: *Runtime,
    request: SearchRequest,
    files: []const repository.ChangedFile,
    review_data: search.ReviewData,
    query: search.ParsedQuery,
    query_terms: []const []const u8,
    stats: *SearchStats,
) !void {
    var results: std.ArrayList(search.ResultJson) = .empty;
    defer freeResultItems(runtime.allocator, &results);
    var cancelled = false;

    for (files) |file| {
        if (isSearchCancelled(runtime, request.search_id)) {
            cancelled = true;
            break;
        }

        const metadata = search.metadataForFile(file, review_data);
        if (try search.filePassesFilters(runtime.allocator, file, metadata, query.filters, request.filters, review_data, false)) {
            const side = search.sourceSide(file);
            const path = search.sourcePath(file, side);
            const source = diff.sourceForSide(runtime.allocator, runtime.io, request.root, path, side, request.target) catch null;
            if (source) |text| {
                defer runtime.allocator.free(text);
                const file_results = try search.buildContentResultsForFile(runtime.allocator, file, metadata, text, side, query_terms);
                errdefer search.freeResults(runtime.allocator, file_results);
                try results.appendSlice(runtime.allocator, file_results);
                runtime.allocator.free(file_results);
            }
        }

        stats.scanned_files += 1;
        try events.emitSearchProgress(runtime, request.search_id, stats.scanned_files, stats.total_files, stats.emitted_results);
    }

    search.sortResults(results.items);
    try emitResultBatches(runtime, request.search_id, results.items, stats);
    if (cancelled or isSearchCancelled(runtime, request.search_id)) return error.SearchCancelled;
}

fn runCommentPhase(
    runtime: *Runtime,
    request: SearchRequest,
    files: []const repository.ChangedFile,
    review_data: search.ReviewData,
    query: search.ParsedQuery,
    comment_terms: []const []const u8,
    stats: *SearchStats,
) !void {
    var results: std.ArrayList(search.ResultJson) = .empty;
    defer freeResultItems(runtime.allocator, &results);

    for (review_data.threads) |thread| {
        if (isSearchCancelled(runtime, request.search_id)) break;
        const file = findFile(files, thread.file_id) orelse continue;
        const metadata = search.metadataForFile(file, review_data);
        if (try search.buildCommentResult(runtime.allocator, thread, file, metadata, query, comment_terms, request.filters, review_data)) |result| {
            try results.append(runtime.allocator, result);
        }
    }

    search.sortResults(results.items);
    try emitResultBatches(runtime, request.search_id, results.items, stats);
    if (isSearchCancelled(runtime, request.search_id)) return error.SearchCancelled;
}

fn emitResultBatches(runtime: *Runtime, search_id: []const u8, results: []const search.ResultJson, stats: *SearchStats) !void {
    var index: usize = 0;
    while (index < results.len) {
        const end = @min(results.len, index + batch_size);
        try events.emitSearchResults(runtime, search_id, results[index..end]);
        stats.emitted_results += @intCast(end - index);
        index = end;
    }
}

fn freeResultItems(allocator: std.mem.Allocator, results: *std.ArrayList(search.ResultJson)) void {
    for (results.items) |*result| result.deinit(allocator);
    results.deinit(allocator);
}

fn findFile(files: []const repository.ChangedFile, file_id: []const u8) ?repository.ChangedFile {
    for (files) |file| {
        if (std.mem.eql(u8, file.id, file_id)) return file;
    }
    return null;
}

fn isSearchCancelled(runtime: *Runtime, search_id: []const u8) bool {
    runtime.search_lock.lock(runtime.io) catch return true;
    defer runtime.search_lock.unlock(runtime.io);

    const job = runtime.search_jobs.getPtr(search_id) orelse return true;
    return job.cancelled;
}

fn removeSearchJob(runtime: *Runtime, search_id: []const u8) void {
    runtime.search_lock.lock(runtime.io) catch return;
    _ = runtime.search_jobs.remove(search_id);
    runtime.search_lock.unlock(runtime.io);
}
