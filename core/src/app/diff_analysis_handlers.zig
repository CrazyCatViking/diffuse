const std = @import("std");

const diff = @import("../core/diff.zig");
const diff_analysis = @import("../core/diff_analysis.zig");
const json_rpc = @import("../protocol/json_rpc.zig");
const repository = @import("../core/repository.zig");
const runtime_mod = @import("rpc_runtime.zig");
const types = @import("../protocol/types.zig");
const events = @import("rpc_events.zig");
const params = @import("rpc_params.zig");
const repo_snapshot = @import("rpc_repo.zig");

const Runtime = runtime_mod.Runtime;

const FileInput = struct {
    file_id: []const u8,
    signature: []const u8,
};

const OwnedAnalysisRequest = struct {
    job_key: []u8,
    root: []u8,
    head: []u8,
    file_id: []u8,
    signature: []u8,
    target_key: []u8,
    target: repository.DiffTarget,
    context: diff.DiffContextMode,
    grammar_root: ?[]u8,

    fn deinit(self: *OwnedAnalysisRequest, allocator: std.mem.Allocator) void {
        allocator.free(self.job_key);
        allocator.free(self.root);
        allocator.free(self.head);
        allocator.free(self.file_id);
        allocator.free(self.signature);
        allocator.free(self.target_key);
        if (self.target.base) |base| allocator.free(base);
        if (self.target.compare) |compare| allocator.free(compare);
        if (self.grammar_root) |grammar_root| allocator.free(grammar_root);
    }
};

pub fn register(server: anytype) !void {
    try server.handle("getDiffAnalysis", getDiffAnalysis);
    try server.handle("getDiffAnalysisStatuses", getDiffAnalysisStatuses);
    try server.handle("ensureDiffAnalysis", ensureDiffAnalysis);
}

fn getDiffAnalysis(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const signature = try json_rpc.getStringParam(request, "signature");
    const context = try params.getDiffContextMode(request);
    const target = try params.getDiffTarget(request);
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const target_key = try diff_analysis.targetKey(runtime.allocator, target, context, snapshot.head);
    defer runtime.allocator.free(target_key);
    const raw = try diff_analysis.readAnalysisIfFresh(runtime.allocator, runtime.io, runtime.environ_map, snapshot.root, target_key, file_id, signature);
    defer if (raw) |json| runtime.allocator.free(json);

    if (raw) |json| try writer.writeAll(json) else try writer.writeAll("null");
}

fn getDiffAnalysisStatuses(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const context = try params.getDiffContextMode(request);
    const target = try params.getDiffTarget(request);
    const files = try getFilesParam(runtime.allocator, request);
    defer runtime.allocator.free(files);
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const target_key = try diff_analysis.targetKey(runtime.allocator, target, context, snapshot.head);
    defer runtime.allocator.free(target_key);
    const now = diff_analysis.nowMs(runtime.io);
    var records: std.ArrayList(diff_analysis.StatusRecord) = .empty;
    defer records.deinit(runtime.allocator);

    for (files) |file| {
        const job_key = try analysisJobKey(runtime.allocator, snapshot.root, target_key, file.file_id, file.signature);
        defer runtime.allocator.free(job_key);
        if (try inMemoryStatus(runtime, job_key)) |record| {
            try records.append(runtime.allocator, .{ .fileId = file.file_id, .signature = file.signature, .status = record.statusText(), .updatedAtMs = now, .message = record.message });
            continue;
        }

        const status = try diff_analysis.cachedStatus(runtime.allocator, runtime.io, runtime.environ_map, snapshot.root, target_key, file.file_id, file.signature);
        try records.append(runtime.allocator, .{ .fileId = file.file_id, .signature = file.signature, .status = status, .updatedAtMs = now });
    }

    try types.writeJson(writer, records.items);
}

fn ensureDiffAnalysis(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    var owned = try parseAnalysisRequest(runtime, request);
    var request_moved = false;
    defer if (!request_moved) owned.deinit(runtime.allocator);

    const cached = try diff_analysis.cachedStatus(runtime.allocator, runtime.io, runtime.environ_map, owned.root, owned.target_key, owned.file_id, owned.signature);
    if (std.mem.eql(u8, cached, "ready")) {
        try types.writeJson(writer, diff_analysis.StatusRecord{ .fileId = owned.file_id, .signature = owned.signature, .status = "ready", .updatedAtMs = diff_analysis.nowMs(runtime.io) });
        return;
    }

    if (try inMemoryStatus(runtime, owned.job_key)) |record| {
        try types.writeJson(writer, diff_analysis.StatusRecord{ .fileId = owned.file_id, .signature = owned.signature, .status = record.statusText(), .updatedAtMs = diff_analysis.nowMs(runtime.io), .message = record.message });
        return;
    }

    const map_key = try runtime.allocator.dupe(u8, owned.job_key);
    var map_key_moved = false;
    errdefer if (!map_key_moved) runtime.allocator.free(map_key);
    try runtime.diff_analysis_lock.lock(runtime.io);
    const result = runtime.diff_analysis_jobs.getOrPut(map_key) catch |err| {
        runtime.diff_analysis_lock.unlock(runtime.io);
        return err;
    };
    if (result.found_existing) {
        const status = result.value_ptr.statusText();
        const message = result.value_ptr.message;
        runtime.diff_analysis_lock.unlock(runtime.io);
        runtime.allocator.free(map_key);
        try types.writeJson(writer, diff_analysis.StatusRecord{ .fileId = owned.file_id, .signature = owned.signature, .status = status, .updatedAtMs = diff_analysis.nowMs(runtime.io), .message = message });
        return;
    }
    result.value_ptr.* = .{ .status = .queued };
    map_key_moved = true;
    runtime.diff_analysis_lock.unlock(runtime.io);

    const queued = diff_analysis.StatusRecord{ .fileId = owned.file_id, .signature = owned.signature, .status = "queued", .updatedAtMs = diff_analysis.nowMs(runtime.io) };
    try events.emitDiffAnalysisStatus(runtime, queued);

    runtime.diff_analysis_group.concurrent(runtime.io, analysisWorker, .{ runtime, owned }) catch |err| {
        try removeAnalysisJob(runtime, owned.job_key);
        return err;
    };
    request_moved = true;
    try types.writeJson(writer, queued);
}

fn parseAnalysisRequest(runtime: *Runtime, request: json_rpc.Request) !OwnedAnalysisRequest {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const signature = try json_rpc.getStringParam(request, "signature");
    const context = try params.getDiffContextMode(request);
    const target = try copyTarget(runtime.allocator, try params.getDiffTarget(request));
    errdefer freeTarget(runtime.allocator, target);
    const grammar_root = try params.resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    errdefer if (grammar_root) |value| runtime.allocator.free(value);
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();
    const target_key = try diff_analysis.targetKey(runtime.allocator, target, context, snapshot.head);
    errdefer runtime.allocator.free(target_key);
    const job_key = try analysisJobKey(runtime.allocator, snapshot.root, target_key, file_id, signature);
    errdefer runtime.allocator.free(job_key);
    const root = try runtime.allocator.dupe(u8, snapshot.root);
    errdefer runtime.allocator.free(root);
    const head = try runtime.allocator.dupe(u8, snapshot.head);
    errdefer runtime.allocator.free(head);
    const owned_file_id = try runtime.allocator.dupe(u8, file_id);
    errdefer runtime.allocator.free(owned_file_id);
    const owned_signature = try runtime.allocator.dupe(u8, signature);
    errdefer runtime.allocator.free(owned_signature);

    return .{
        .job_key = job_key,
        .root = root,
        .head = head,
        .file_id = owned_file_id,
        .signature = owned_signature,
        .target_key = target_key,
        .target = target,
        .context = context,
        .grammar_root = grammar_root,
    };
}

fn analysisWorker(runtime: *Runtime, request_arg: OwnedAnalysisRequest) void {
    var request = request_arg;
    defer request.deinit(runtime.allocator);

    setAnalysisJob(runtime, request.job_key, .analyzing, null) catch {};
    events.emitDiffAnalysisStatus(runtime, .{ .fileId = request.file_id, .signature = request.signature, .status = "analyzing", .updatedAtMs = diff_analysis.nowMs(runtime.io) }) catch {};

    runAnalysis(runtime, request) catch |err| {
        const message = @errorName(err);
        setAnalysisJob(runtime, request.job_key, .failed, message) catch {};
        events.emitDiffAnalysisStatus(runtime, .{ .fileId = request.file_id, .signature = request.signature, .status = "failed", .updatedAtMs = diff_analysis.nowMs(runtime.io), .message = message }) catch {};
        return;
    };

    removeAnalysisJob(runtime, request.job_key) catch {};
    events.emitDiffAnalysisStatus(runtime, .{ .fileId = request.file_id, .signature = request.signature, .status = "ready", .updatedAtMs = diff_analysis.nowMs(runtime.io) }) catch {};
}

fn runAnalysis(runtime: *Runtime, request: OwnedAnalysisRequest) !void {
    var model = try diff.getDiffRenderModel(runtime.allocator, runtime.io, request.root, request.file_id, request.file_id, .{
        .context = request.context,
        .enrichment = .full,
        .grammar_root = request.grammar_root,
        .target = request.target,
    });
    defer model.deinit(runtime.allocator);
    try diff_analysis.writeAnalysis(runtime.allocator, runtime.io, runtime.environ_map, request.root, request.target_key, request.file_id, request.signature, &model);
}

fn getFilesParam(allocator: std.mem.Allocator, request: json_rpc.Request) ![]FileInput {
    const params_object = try json_rpc.paramsObject(request);
    const value = params_object.get("files") orelse return error.MissingParam;
    const array = switch (value) {
        .array => |items| items,
        else => return error.InvalidParam,
    };
    var files: std.ArrayList(FileInput) = .empty;
    errdefer files.deinit(allocator);
    for (array.items) |item| {
        const object = switch (item) {
            .object => |object| object,
            else => return error.InvalidParam,
        };
        const file_id = switch (object.get("fileId") orelse return error.MissingParam) {
            .string => |text| text,
            else => return error.InvalidParam,
        };
        const signature = switch (object.get("signature") orelse return error.MissingParam) {
            .string => |text| text,
            else => return error.InvalidParam,
        };
        try files.append(allocator, .{ .file_id = file_id, .signature = signature });
    }
    return try files.toOwnedSlice(allocator);
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

fn analysisJobKey(allocator: std.mem.Allocator, root: []const u8, target_key: []const u8, file_id: []const u8, signature: []const u8) ![]u8 {
    var writer = std.Io.Writer.Allocating.init(allocator);
    errdefer writer.deinit();
    try writer.writer.writeAll(root);
    try writer.writer.writeByte(0);
    try writer.writer.writeAll(target_key);
    try writer.writer.writeByte(0);
    try writer.writer.writeAll(file_id);
    try writer.writer.writeByte(0);
    try writer.writer.writeAll(signature);
    const text = try writer.toOwnedSlice();
    defer allocator.free(text);
    return diff_analysis.hashText(allocator, text);
}

fn inMemoryStatus(runtime: *Runtime, job_key: []const u8) !?runtime_mod.DiffAnalysisJobState {
    try runtime.diff_analysis_lock.lock(runtime.io);
    defer runtime.diff_analysis_lock.unlock(runtime.io);
    return runtime.diff_analysis_jobs.get(job_key);
}

fn setAnalysisJob(runtime: *Runtime, job_key: []const u8, status: runtime_mod.DiffAnalysisJobStatus, message: ?[]const u8) !void {
    try runtime.diff_analysis_lock.lock(runtime.io);
    defer runtime.diff_analysis_lock.unlock(runtime.io);
    if (runtime.diff_analysis_jobs.getPtr(job_key)) |job| {
        job.status = status;
        job.message = message;
    }
}

fn removeAnalysisJob(runtime: *Runtime, job_key: []const u8) !void {
    try runtime.diff_analysis_lock.lock(runtime.io);
    defer runtime.diff_analysis_lock.unlock(runtime.io);
    if (runtime.diff_analysis_jobs.fetchRemove(job_key)) |entry| runtime.allocator.free(entry.key);
}
