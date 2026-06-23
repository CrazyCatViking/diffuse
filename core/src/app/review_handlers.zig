const std = @import("std");

const json_rpc = @import("../protocol/json_rpc.zig");
const review = @import("../core/review.zig");
const runtime_mod = @import("rpc_runtime.zig");
const types = @import("../protocol/types.zig");
const events = @import("rpc_events.zig");
const params = @import("rpc_params.zig");
const repo_snapshot = @import("rpc_repo.zig");

const Runtime = runtime_mod.Runtime;

pub fn register(server: anytype) !void {
    try server.handle("getReviewConfig", getReviewConfig);
    try server.handle("saveReviewConfig", saveReviewConfig);
    try server.handle("getActiveReviewSession", getActiveReviewSession);
    try server.handle("listReviewSessions", listReviewSessions);
    try server.handle("createReviewSession", createReviewSession);
    try server.handle("getReviewProgress", getReviewProgress);
    try server.handle("saveReviewProgress", saveReviewProgress);
    try server.handle("getReviewedFiles", getReviewedFiles);
    try server.handle("saveReviewedFiles", saveReviewedFiles);
    try server.handle("updateReviewedFiles", updateReviewedFiles);
    try server.handle("getReviewAgentStates", getReviewAgentStates);
    try server.handle("saveReviewAgentState", saveReviewAgentState);
    try server.handle("getReviewRuns", getReviewRuns);
    try server.handle("recoverStaleReviewRuns", recoverStaleReviewRuns);
    try server.handle("saveReviewRun", saveReviewRun);
    try server.handle("createReviewRun", saveReviewRun);
    try server.handle("updateReviewRun", saveReviewRun);
    try server.handle("finishReviewRun", saveReviewRun);
    try server.handle("getReviewThreads", getReviewThreads);
    try server.handle("getReviewChatMessages", getReviewChatMessages);
    try server.handle("saveReviewChatMessage", saveReviewChatMessage);
    try server.handle("addReviewCommentPayload", addReviewCommentPayload);
    try server.handle("addReviewComment", addReviewComment);
    try server.handle("saveReviewThread", saveReviewThread);
}

fn getReviewConfig(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const config_json = try review.readConfig(runtime.allocator, runtime.io, snapshot.root);
    defer runtime.allocator.free(config_json);
    try params.writeCompactJson(runtime.allocator, writer, config_json);
}

fn saveReviewConfig(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const config = try params.getObjectParam(request, "config");
    const config_json = try params.stringifyJsonValue(runtime.allocator, config);
    defer runtime.allocator.free(config_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeConfig(runtime.allocator, runtime.io, repo.root, config_json);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, "", "config.updated");
    try writer.writeAll(saved);
}

fn getActiveReviewSession(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const session_json = try review.getActiveSession(runtime.allocator, runtime.io, snapshot.root);
    defer if (session_json) |json| runtime.allocator.free(json);

    if (session_json) |json| try params.writeCompactJson(runtime.allocator, writer, json) else try writer.writeAll("null");
}

fn createReviewSession(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session = try params.getObjectParam(request, "session");
    const session_id = try params.getObjectRequiredReviewId(session, "id");
    const session_json = try params.stringifyJsonValue(runtime.allocator, session);
    defer runtime.allocator.free(session_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.createSession(runtime.allocator, runtime.io, repo.root, session_id, session_json);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, session_id, "session.created");
    try writer.writeAll(saved);
}

fn listReviewSessions(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const sessions_json = try review.listSessions(runtime.allocator, runtime.io, snapshot.root);
    defer runtime.allocator.free(sessions_json);
    try params.writeCompactJson(runtime.allocator, writer, sessions_json);
}

fn getReviewProgress(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const progress_json = try review.readProgress(runtime.allocator, runtime.io, snapshot.root, session_id);
    defer if (progress_json) |json| runtime.allocator.free(json);

    if (progress_json) |json| try params.writeCompactJson(runtime.allocator, writer, json) else try writer.writeAll("null");
}

fn saveReviewProgress(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    const progress = try params.getObjectParam(request, "progress");
    const progress_json = try params.stringifyJsonValue(runtime.allocator, progress);
    defer runtime.allocator.free(progress_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeProgress(runtime.allocator, runtime.io, repo.root, session_id, progress_json);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, session_id, "progress.updated");
    try writer.writeAll(saved);
}

fn saveReviewAgentState(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    const agent = try params.getObjectParam(request, "agent");
    const agent_run_id = try params.getObjectRequiredReviewId(agent, "id");
    const agent_json = try params.stringifyJsonValue(runtime.allocator, agent);
    defer runtime.allocator.free(agent_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeAgentState(runtime.allocator, runtime.io, repo.root, session_id, agent_run_id, agent_json);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, session_id, "agent.updated");
    try writer.writeAll(saved);
}

fn getReviewAgentStates(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const agents_json = try review.listAgentStates(runtime.allocator, runtime.io, snapshot.root, session_id);
    defer runtime.allocator.free(agents_json);
    try params.writeCompactJson(runtime.allocator, writer, agents_json);
}

fn getReviewRuns(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const runs_json = try review.listRuns(runtime.allocator, runtime.io, snapshot.root, session_id);
    defer runtime.allocator.free(runs_json);
    try params.writeCompactJson(runtime.allocator, writer, runs_json);
}

fn saveReviewRun(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    const run = try params.getObjectParam(request, "run");
    const run_id = try params.getObjectRequiredReviewId(run, "id");
    const run_json = try params.stringifyJsonValue(runtime.allocator, run);
    defer runtime.allocator.free(run_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeRun(runtime.allocator, runtime.io, repo.root, session_id, run_id, run_json);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, session_id, "run.updated");
    try writer.writeAll(saved);
}

fn getReviewedFiles(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const reviewed_files_json = try review.readReviewedFiles(runtime.allocator, runtime.io, snapshot.root, session_id);
    defer if (reviewed_files_json) |json| runtime.allocator.free(json);

    if (reviewed_files_json) |json| try params.writeCompactJson(runtime.allocator, writer, json) else try writer.writeAll("{\"files\":{}}");
}

fn saveReviewedFiles(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    const reviewed_files = try params.getObjectParam(request, "reviewedFiles");
    const reviewed_files_json = try params.stringifyJsonValue(runtime.allocator, reviewed_files);
    defer runtime.allocator.free(reviewed_files_json);

    try runtime.session_lock.lock(runtime.io);
    defer runtime.session_lock.unlock(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeReviewedFiles(runtime.allocator, runtime.io, repo.root, session_id, reviewed_files_json);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, session_id, "reviewed-files.updated");
    try writer.writeAll(saved);
}

fn updateReviewedFiles(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    const update = try params.getObjectParam(request, "update");

    try runtime.session_lock.lock(runtime.io);
    defer runtime.session_lock.unlock(runtime.io);

    const repo = try runtime.session.requireRepo();
    const current_json = try review.readReviewedFiles(runtime.allocator, runtime.io, repo.root, session_id) orelse try runtime.allocator.dupe(u8, "{\"files\":{}}");
    defer runtime.allocator.free(current_json);

    var parsed = try std.json.parseFromSlice(std.json.Value, runtime.allocator, current_json, .{});
    defer parsed.deinit();

    var root_object = switch (parsed.value) {
        .object => |*object| object,
        else => return error.InvalidParam,
    };

    const files_value = root_object.getPtr("files") orelse return error.InvalidParam;
    var files_object = switch (files_value.*) {
        .object => |*object| object,
        else => return error.InvalidParam,
    };

    const update_object = switch (update) {
        .object => |object| object,
        else => return error.InvalidParam,
    };

    if (update_object.get("files")) |files_update_value| {
        const files_update = switch (files_update_value) {
            .object => |object| object,
            else => return error.InvalidParam,
        };
        var iterator = files_update.iterator();
        while (iterator.next()) |entry| {
            const key = try parsed.arena.allocator().dupe(u8, entry.key_ptr.*);
            const value = try params.cloneJsonValue(parsed.arena.allocator(), entry.value_ptr.*);
            try files_object.put(parsed.arena.allocator(), key, value);
        }
    }

    if (update_object.get("removeFileIds")) |remove_value| {
        const remove_ids = switch (remove_value) {
            .array => |array| array,
            else => return error.InvalidParam,
        };
        for (remove_ids.items) |item| {
            const file_id = switch (item) {
                .string => |text| text,
                else => return error.InvalidParam,
            };
            _ = files_object.swapRemove(file_id);
        }
    }

    const reviewed_files_json = try params.stringifyJsonValue(runtime.allocator, parsed.value);
    defer runtime.allocator.free(reviewed_files_json);
    const saved = try review.writeReviewedFiles(runtime.allocator, runtime.io, repo.root, session_id, reviewed_files_json);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, session_id, "reviewed-files.updated");
    try writer.writeAll(saved);
}

fn recoverStaleReviewRuns(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const runs_json = try review.listRuns(runtime.allocator, runtime.io, repo.root, session_id);
    defer runtime.allocator.free(runs_json);

    const parsed = try std.json.parseFromSlice(std.json.Value, runtime.allocator, runs_json, .{});
    defer parsed.deinit();

    var recovered: u32 = 0;
    const now_ms = std.Io.Timestamp.now(runtime.io, .real).toMilliseconds();

    const array = switch (parsed.value) {
        .array => |array| array,
        else => return error.InvalidParam,
    };

    for (array.items) |*item| {
        const object = switch (item.*) {
            .object => |*object| object,
            else => continue,
        };
        const status = object.get("status") orelse continue;
        const status_text = switch (status) {
            .string => |text| text,
            else => continue,
        };
        if (!params.isActiveRunStatus(status_text)) continue;

        const run_id = try params.getRequiredReviewId(object.*, "id");
        const timestamp = try std.fmt.allocPrint(runtime.allocator, "{d}", .{now_ms});
        defer runtime.allocator.free(timestamp);

        try object.put(runtime.allocator, "status", .{ .string = "failed" });
        try object.put(runtime.allocator, "currentPhase", .{ .string = "interrupted" });
        try object.put(runtime.allocator, "message", .{ .string = "Review run was interrupted before Diffuse could attach a provider" });
        try object.put(runtime.allocator, "updatedAt", .{ .string = timestamp });
        try object.put(runtime.allocator, "completedAt", .{ .string = timestamp });

        const run_json = try params.stringifyJsonValue(runtime.allocator, item.*);
        defer runtime.allocator.free(run_json);
        const saved = try review.writeRun(runtime.allocator, runtime.io, repo.root, session_id, run_id, run_json);
        defer runtime.allocator.free(saved);
        recovered += 1;
    }

    if (recovered > 0) try events.emitReviewChanged(runtime, repo.root, session_id, "runs.recovered");
    try writer.print("{{\"recovered\":{d}}}", .{recovered});
}

fn getReviewThreads(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const threads_json = try review.listThreads(runtime.allocator, runtime.io, snapshot.root, session_id);
    defer runtime.allocator.free(threads_json);
    try params.writeCompactJson(runtime.allocator, writer, threads_json);
}

fn getReviewChatMessages(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    var snapshot = try repo_snapshot.snapshot(runtime);
    defer snapshot.deinit();

    const messages_json = try review.listChatMessages(runtime.allocator, runtime.io, snapshot.root, session_id);
    defer runtime.allocator.free(messages_json);
    try params.writeCompactJson(runtime.allocator, writer, messages_json);
}

fn saveReviewChatMessage(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    const message = try params.getObjectParam(request, "message");
    const message_id = try params.getObjectRequiredReviewId(message, "id");
    const message_json = try params.stringifyJsonValue(runtime.allocator, message);
    defer runtime.allocator.free(message_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeChatMessage(runtime.allocator, runtime.io, repo.root, session_id, message_id, message_json);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, session_id, "chat.updated");
    try writer.writeAll(saved);
}

fn saveReviewThread(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    const thread = try params.getObjectParam(request, "thread");
    const thread_id = try params.getObjectRequiredReviewId(thread, "id");
    const thread_json = try params.stringifyJsonValue(runtime.allocator, thread);
    defer runtime.allocator.free(thread_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeThread(runtime.allocator, runtime.io, repo.root, session_id, thread_id, thread_json);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, session_id, "thread.updated");
    try writer.writeAll(saved);
}

fn addReviewComment(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    const comment = try params.getObjectParam(request, "comment");
    const comment_id = try params.getObjectRequiredReviewId(comment, "id");
    const comment_json = try params.stringifyJsonValue(runtime.allocator, comment);
    defer runtime.allocator.free(comment_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeThread(runtime.allocator, runtime.io, repo.root, session_id, comment_id, comment_json);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, session_id, "thread.created");
    try writer.writeAll(saved);
}

fn addReviewCommentPayload(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try params.getReviewIdParam(request, "sessionId");
    const run_id = try params.getReviewIdParam(request, "runId");
    const comment = try params.getObjectParam(request, "comment");
    const object = switch (comment) {
        .object => |object| object,
        else => return error.InvalidParam,
    };

    const file_path = try params.getRequiredString(object, "filePath");
    if (std.fs.path.isAbsolute(file_path) or std.mem.indexOf(u8, file_path, "..") != null) return error.InvalidParam;
    const side = try params.getRequiredString(object, "side");
    if (!std.mem.eql(u8, side, "old") and !std.mem.eql(u8, side, "new")) return error.InvalidParam;
    const start_line = try params.getRequiredU32(object, "startLine");
    const end_line = try params.getRequiredU32(object, "endLine");
    if (start_line == 0 or end_line < start_line) return error.InvalidParam;
    const body = std.mem.trim(u8, try params.getRequiredString(object, "body"), "\r\n\t ");
    if (body.len == 0) return error.InvalidParam;

    const now_ms = std.Io.Timestamp.now(runtime.io, .real).toMilliseconds();
    const thread_id = try std.fmt.allocPrint(runtime.allocator, "thread-{d}-{d}-{d}-{d}", .{ now_ms, start_line, end_line, body.len });
    defer runtime.allocator.free(thread_id);
    const message_id = try std.fmt.allocPrint(runtime.allocator, "msg-{d}-{d}-{d}-{d}", .{ now_ms, start_line, end_line, body.len });
    defer runtime.allocator.free(message_id);
    const timestamp = try std.fmt.allocPrint(runtime.allocator, "{d}", .{now_ms});
    defer runtime.allocator.free(timestamp);

    var thread_json = std.Io.Writer.Allocating.init(runtime.allocator);
    errdefer thread_json.deinit();
    try thread_json.writer.writeAll("{");
    try params.writeJsonField(&thread_json.writer, "id", thread_id, true);
    try params.writeJsonField(&thread_json.writer, "sessionId", session_id, false);
    try params.writeJsonField(&thread_json.writer, "fileId", file_path, false);
    try params.writeJsonField(&thread_json.writer, if (std.mem.eql(u8, side, "old")) "oldPath" else "newPath", file_path, false);
    try thread_json.writer.writeAll(",\"anchor\":{");
    try params.writeJsonField(&thread_json.writer, "side", side, true);
    try thread_json.writer.print(",\"startLine\":{},\"endLine\":{},\"diffTargetFingerprint\":\"agent\"", .{ start_line, end_line });
    if (params.getOptionalString(object, "selectedText")) |text| {
        try thread_json.writer.writeAll(",\"selectedText\":");
        try types.writeJson(&thread_json.writer, text);
    }
    try thread_json.writer.writeAll("}");
    try params.writeJsonField(&thread_json.writer, "status", "open", false);
    if (params.getOptionalString(object, "severity")) |value| try params.writeJsonField(&thread_json.writer, "severity", value, false);
    if (params.getOptionalString(object, "category")) |value| try params.writeJsonField(&thread_json.writer, "category", value, false);
    if (params.getOptionalString(object, "confidence")) |value| try params.writeJsonField(&thread_json.writer, "confidence", value, false);
    try thread_json.writer.writeAll(",\"source\":{\"kind\":\"agent\",\"provider\":\"opencode\",\"agentRunId\":");
    try types.writeJson(&thread_json.writer, run_id);
    try thread_json.writer.writeAll("}");
    try params.writeJsonField(&thread_json.writer, "createdAt", timestamp, false);
    try params.writeJsonField(&thread_json.writer, "updatedAt", timestamp, false);
    try thread_json.writer.writeAll(",\"messages\":[{");
    try params.writeJsonField(&thread_json.writer, "id", message_id, true);
    try params.writeJsonField(&thread_json.writer, "authorId", run_id, false);
    try params.writeJsonField(&thread_json.writer, "body", body, false);
    try params.writeJsonField(&thread_json.writer, "createdAt", timestamp, false);
    try thread_json.writer.writeAll("}]}");

    const owned = try thread_json.toOwnedSlice();
    defer runtime.allocator.free(owned);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeThread(runtime.allocator, runtime.io, repo.root, session_id, thread_id, owned);
    defer runtime.allocator.free(saved);
    try events.emitReviewChanged(runtime, repo.root, session_id, "thread.created");
    try writer.writeAll(saved);
}
