const std = @import("std");

const diff = @import("../core/diff.zig");
const lsp = @import("../core/lsp.zig");
const json_rpc = @import("../protocol/json_rpc.zig");
const repository = @import("../core/repository.zig");
const review = @import("../core/review.zig");
const runtime_mod = @import("rpc_runtime.zig");
const types = @import("../protocol/types.zig");

const Runtime = runtime_mod.Runtime;

pub fn register(server: anytype) !void {
    try server.handle("getVersion", getVersion);
    try server.handle("openRepository", openRepository);
    try server.handle("getDiffTargetDefaults", getDiffTargetDefaults);
    try server.handle("listBranches", listBranches);
    try server.handle("listChangedFiles", listChangedFiles);
    try server.handle("getDiffRenderModel", getDiffRenderModel);
    try server.handle("getSyntaxSpans", getSyntaxSpans);
    try server.handle("getLspConfigInfo", getLspConfigInfo);
    try server.handle("getLspInstallInfo", getLspInstallInfo);
    try server.handle("installLspServer", installLspServer);
    try server.handle("restartLspServer", restartLspServer);
    try server.handle("getLspStatus", getLspStatus);
    try server.handle("getLspHover", getLspHover);
    try server.handle("getLspDiagnostics", getLspDiagnostics);
    try server.handle("getReviewConfig", getReviewConfig);
    try server.handle("saveReviewConfig", saveReviewConfig);
    try server.handle("getActiveReviewSession", getActiveReviewSession);
    try server.handle("listReviewSessions", listReviewSessions);
    try server.handle("createReviewSession", createReviewSession);
    try server.handle("getReviewProgress", getReviewProgress);
    try server.handle("saveReviewProgress", saveReviewProgress);
    try server.handle("getReviewedFiles", getReviewedFiles);
    try server.handle("saveReviewedFiles", saveReviewedFiles);
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
    try server.handle("listTreeSitterGrammars", listTreeSitterGrammars);
    try server.handle("syncTreeSitterRegistry", syncTreeSitterRegistry);
    try server.handle("installTreeSitterGrammar", installTreeSitterGrammar);
    try server.handle("uninstallTreeSitterGrammar", uninstallTreeSitterGrammar);
}

fn getReviewConfig(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const config_json = try review.readConfig(runtime.allocator, runtime.io, repo.root);
    defer runtime.allocator.free(config_json);
    try writeCompactJson(runtime.allocator, writer, config_json);
}

fn saveReviewConfig(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const config = try getObjectParam(request, "config");
    const config_json = try stringifyJsonValue(runtime.allocator, config);
    defer runtime.allocator.free(config_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeConfig(runtime.allocator, runtime.io, repo.root, config_json);
    defer runtime.allocator.free(saved);
    try emitReviewChanged(runtime, repo.root, "", "config.updated");
    try writer.writeAll(saved);
}

fn getActiveReviewSession(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const session_json = try review.getActiveSession(runtime.allocator, runtime.io, repo.root);
    defer if (session_json) |json| runtime.allocator.free(json);

    if (session_json) |json| try writeCompactJson(runtime.allocator, writer, json) else try writer.writeAll("null");
}

fn createReviewSession(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session = try getObjectParam(request, "session");
    const session_id = try getObjectRequiredString(session, "id");
    const session_json = try stringifyJsonValue(runtime.allocator, session);
    defer runtime.allocator.free(session_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.createSession(runtime.allocator, runtime.io, repo.root, session_id, session_json);
    defer runtime.allocator.free(saved);
    try emitReviewChanged(runtime, repo.root, session_id, "session.created");
    try writer.writeAll(saved);
}

fn listReviewSessions(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const sessions_json = try review.listSessions(runtime.allocator, runtime.io, repo.root);
    defer runtime.allocator.free(sessions_json);
    try writeCompactJson(runtime.allocator, writer, sessions_json);
}

fn getReviewProgress(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const progress_json = try review.readProgress(runtime.allocator, runtime.io, repo.root, session_id);
    defer if (progress_json) |json| runtime.allocator.free(json);

    if (progress_json) |json| try writeCompactJson(runtime.allocator, writer, json) else try writer.writeAll("null");
}

fn saveReviewProgress(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");
    const progress = try getObjectParam(request, "progress");
    const progress_json = try stringifyJsonValue(runtime.allocator, progress);
    defer runtime.allocator.free(progress_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeProgress(runtime.allocator, runtime.io, repo.root, session_id, progress_json);
    defer runtime.allocator.free(saved);
    try emitReviewChanged(runtime, repo.root, session_id, "progress.updated");
    try writer.writeAll(saved);
}

fn saveReviewAgentState(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");
    const agent = try getObjectParam(request, "agent");
    const agent_run_id = try getObjectRequiredString(agent, "id");
    const agent_json = try stringifyJsonValue(runtime.allocator, agent);
    defer runtime.allocator.free(agent_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeAgentState(runtime.allocator, runtime.io, repo.root, session_id, agent_run_id, agent_json);
    defer runtime.allocator.free(saved);
    try emitReviewChanged(runtime, repo.root, session_id, "agent.updated");
    try writer.writeAll(saved);
}

fn getReviewAgentStates(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const agents_json = try review.listAgentStates(runtime.allocator, runtime.io, repo.root, session_id);
    defer runtime.allocator.free(agents_json);
    try writeCompactJson(runtime.allocator, writer, agents_json);
}

fn getReviewRuns(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const runs_json = try review.listRuns(runtime.allocator, runtime.io, repo.root, session_id);
    defer runtime.allocator.free(runs_json);
    try writeCompactJson(runtime.allocator, writer, runs_json);
}

fn saveReviewRun(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");
    const run = try getObjectParam(request, "run");
    const run_id = try getObjectRequiredString(run, "id");
    const run_json = try stringifyJsonValue(runtime.allocator, run);
    defer runtime.allocator.free(run_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeRun(runtime.allocator, runtime.io, repo.root, session_id, run_id, run_json);
    defer runtime.allocator.free(saved);
    try emitReviewChanged(runtime, repo.root, session_id, "run.updated");
    try writer.writeAll(saved);
}

fn getReviewedFiles(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const reviewed_files_json = try review.readReviewedFiles(runtime.allocator, runtime.io, repo.root, session_id);
    defer if (reviewed_files_json) |json| runtime.allocator.free(json);

    if (reviewed_files_json) |json| try writeCompactJson(runtime.allocator, writer, json) else try writer.writeAll("{\"files\":{}}");
}

fn saveReviewedFiles(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");
    const reviewed_files = try getObjectParam(request, "reviewedFiles");
    const reviewed_files_json = try stringifyJsonValue(runtime.allocator, reviewed_files);
    defer runtime.allocator.free(reviewed_files_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeReviewedFiles(runtime.allocator, runtime.io, repo.root, session_id, reviewed_files_json);
    defer runtime.allocator.free(saved);
    try emitReviewChanged(runtime, repo.root, session_id, "reviewed-files.updated");
    try writer.writeAll(saved);
}

fn recoverStaleReviewRuns(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");

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
        if (!isActiveRunStatus(status_text)) continue;

        const run_id = try getRequiredString(object.*, "id");
        const timestamp = try std.fmt.allocPrint(runtime.allocator, "{d}", .{now_ms});
        defer runtime.allocator.free(timestamp);

        try object.put(runtime.allocator, "status", .{ .string = "failed" });
        try object.put(runtime.allocator, "currentPhase", .{ .string = "interrupted" });
        try object.put(runtime.allocator, "message", .{ .string = "Review run was interrupted before Diffuse could attach a provider" });
        try object.put(runtime.allocator, "updatedAt", .{ .string = timestamp });
        try object.put(runtime.allocator, "completedAt", .{ .string = timestamp });

        const run_json = try stringifyJsonValue(runtime.allocator, item.*);
        defer runtime.allocator.free(run_json);
        const saved = try review.writeRun(runtime.allocator, runtime.io, repo.root, session_id, run_id, run_json);
        defer runtime.allocator.free(saved);
        recovered += 1;
    }

    if (recovered > 0) try emitReviewChanged(runtime, repo.root, session_id, "runs.recovered");
    try writer.print("{{\"recovered\":{d}}}", .{recovered});
}

fn getReviewThreads(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const threads_json = try review.listThreads(runtime.allocator, runtime.io, repo.root, session_id);
    defer runtime.allocator.free(threads_json);
    try writeCompactJson(runtime.allocator, writer, threads_json);
}

fn getReviewChatMessages(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const messages_json = try review.listChatMessages(runtime.allocator, runtime.io, repo.root, session_id);
    defer runtime.allocator.free(messages_json);
    try writeCompactJson(runtime.allocator, writer, messages_json);
}

fn saveReviewChatMessage(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");
    const message = try getObjectParam(request, "message");
    const message_id = try getObjectRequiredString(message, "id");
    const message_json = try stringifyJsonValue(runtime.allocator, message);
    defer runtime.allocator.free(message_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeChatMessage(runtime.allocator, runtime.io, repo.root, session_id, message_id, message_json);
    defer runtime.allocator.free(saved);
    try emitReviewChanged(runtime, repo.root, session_id, "chat.updated");
    try writer.writeAll(saved);
}

fn saveReviewThread(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");
    const thread = try getObjectParam(request, "thread");
    const thread_id = try getObjectRequiredString(thread, "id");
    const thread_json = try stringifyJsonValue(runtime.allocator, thread);
    defer runtime.allocator.free(thread_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeThread(runtime.allocator, runtime.io, repo.root, session_id, thread_id, thread_json);
    defer runtime.allocator.free(saved);
    try emitReviewChanged(runtime, repo.root, session_id, "thread.updated");
    try writer.writeAll(saved);
}

fn addReviewComment(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");
    const comment = try getObjectParam(request, "comment");
    const comment_id = try getObjectRequiredString(comment, "id");
    const comment_json = try stringifyJsonValue(runtime.allocator, comment);
    defer runtime.allocator.free(comment_json);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeThread(runtime.allocator, runtime.io, repo.root, session_id, comment_id, comment_json);
    defer runtime.allocator.free(saved);
    try emitReviewChanged(runtime, repo.root, session_id, "thread.created");
    try writer.writeAll(saved);
}

fn addReviewCommentPayload(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const session_id = try json_rpc.getStringParam(request, "sessionId");
    const run_id = try json_rpc.getStringParam(request, "runId");
    const comment = try getObjectParam(request, "comment");
    const object = switch (comment) {
        .object => |object| object,
        else => return error.InvalidParam,
    };

    const file_path = try getRequiredString(object, "filePath");
    if (std.fs.path.isAbsolute(file_path) or std.mem.indexOf(u8, file_path, "..") != null) return error.InvalidParam;
    const side = try getRequiredString(object, "side");
    if (!std.mem.eql(u8, side, "old") and !std.mem.eql(u8, side, "new")) return error.InvalidParam;
    const start_line = try getRequiredU32(object, "startLine");
    const end_line = try getRequiredU32(object, "endLine");
    if (start_line == 0 or end_line < start_line) return error.InvalidParam;
    const body = std.mem.trim(u8, try getRequiredString(object, "body"), "\r\n\t ");
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
    try writeJsonField(&thread_json.writer, "id", thread_id, true);
    try writeJsonField(&thread_json.writer, "sessionId", session_id, false);
    try writeJsonField(&thread_json.writer, "fileId", file_path, false);
    try writeJsonField(&thread_json.writer, if (std.mem.eql(u8, side, "old")) "oldPath" else "newPath", file_path, false);
    try thread_json.writer.writeAll(",\"anchor\":{");
    try writeJsonField(&thread_json.writer, "side", side, true);
    try thread_json.writer.print(",\"startLine\":{},\"endLine\":{},\"diffTargetFingerprint\":\"agent\"", .{ start_line, end_line });
    if (getOptionalString(object, "selectedText")) |text| {
        try thread_json.writer.writeAll(",\"selectedText\":");
        try types.writeJson(&thread_json.writer, text);
    }
    try thread_json.writer.writeAll("}");
    try writeJsonField(&thread_json.writer, "status", "open", false);
    if (getOptionalString(object, "severity")) |value| try writeJsonField(&thread_json.writer, "severity", value, false);
    if (getOptionalString(object, "category")) |value| try writeJsonField(&thread_json.writer, "category", value, false);
    if (getOptionalString(object, "confidence")) |value| try writeJsonField(&thread_json.writer, "confidence", value, false);
    try thread_json.writer.writeAll(",\"source\":{\"kind\":\"agent\",\"provider\":\"opencode\",\"agentRunId\":");
    try types.writeJson(&thread_json.writer, run_id);
    try thread_json.writer.writeAll("}");
    try writeJsonField(&thread_json.writer, "createdAt", timestamp, false);
    try writeJsonField(&thread_json.writer, "updatedAt", timestamp, false);
    try thread_json.writer.writeAll(",\"messages\":[{");
    try writeJsonField(&thread_json.writer, "id", message_id, true);
    try writeJsonField(&thread_json.writer, "authorId", run_id, false);
    try writeJsonField(&thread_json.writer, "body", body, false);
    try writeJsonField(&thread_json.writer, "createdAt", timestamp, false);
    try thread_json.writer.writeAll("}]}");

    const owned = try thread_json.toOwnedSlice();
    defer runtime.allocator.free(owned);

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const saved = try review.writeThread(runtime.allocator, runtime.io, repo.root, session_id, thread_id, owned);
    defer runtime.allocator.free(saved);
    try emitReviewChanged(runtime, repo.root, session_id, "thread.created");
    try writer.writeAll(saved);
}

fn emitReviewChanged(runtime: *Runtime, root: []const u8, session_id: []const u8, change: []const u8) !void {
    var message = std.Io.Writer.Allocating.init(runtime.allocator);
    errdefer message.deinit();

    try message.writer.writeAll("{\"jsonrpc\":\"2.0\",\"method\":\"review/changed\",\"params\":{");
    try message.writer.writeAll("\"root\":");
    try types.writeJson(&message.writer, root);
    try message.writer.writeAll(",\"sessionId\":");
    try types.writeJson(&message.writer, session_id);
    try message.writer.writeAll(",\"change\":");
    try types.writeJson(&message.writer, change);
    try message.writer.writeAll("}}\n");

    try runtime.enqueue(try message.toOwnedSlice());
}

fn getVersion(_: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try types.writeJson(writer, types.versionInfo());
}

fn openRepository(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const path = try json_rpc.getStringParam(request, "path");
    try runtime.session_lock.lock(runtime.io);
    defer runtime.session_lock.unlock(runtime.io);

    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);
    runtime.lsp_manager.deinit(runtime.io);
    runtime.lsp_manager = lsp.Manager.init(runtime.allocator);

    const repo = try runtime.session.openRepository(path);
    try runtime.repo_watcher.start(repo.root);
    try types.writeJson(writer, types.openRepositoryResult(repo));
}

fn getDiffTargetDefaults(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    var defaults = try repo.diffTargetDefaults();
    defer defaults.deinit(runtime.allocator);

    try types.writeJson(writer, types.diffTargetDefaults(defaults));
}

fn listChangedFiles(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const target = getDiffTarget(request);
    const files = try repo.listChangedFiles(target);
    defer repository.freeChangedFiles(runtime.allocator, files);

    var result: std.ArrayList(types.ChangedFile) = .empty;
    defer result.deinit(runtime.allocator);
    for (files) |file| try result.append(runtime.allocator, types.changedFile(file));

    try types.writeJson(writer, result.items);
}

fn listBranches(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const branches = try repo.listBranches();
    defer repository.freeBranches(runtime.allocator, branches);

    var result: std.ArrayList(types.BranchInfo) = .empty;
    defer result.deinit(runtime.allocator);
    for (branches) |branch| try result.append(runtime.allocator, types.branchInfo(branch));

    try types.writeJson(writer, result.items);
}

fn getDiffRenderModel(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const mode = getDiffOption(request, "mode") orelse "split";
    const context = getDiffOption(request, "context") orelse "diff";
    const diff_context: diff.DiffContextMode = if (std.mem.eql(u8, context, "full")) .full else .diff;

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);
    const target = getDiffTarget(request);
    var model = try diff.getDiffRenderModel(runtime.allocator, repo.io, repo.root, file_id, file_id, .{ .context = diff_context, .grammar_root = grammar_root, .target = target });
    defer model.deinit(runtime.allocator);

    var rows: std.ArrayList(types.DiffRow) = .empty;
    defer rows.deinit(runtime.allocator);
    for (model.rows.items) |row| try rows.append(runtime.allocator, types.diffRow(row));

    try types.writeJson(writer, types.DiffRenderModel{
        .fileId = model.file_id,
        .mode = mode,
        .context = context,
        .syntax = types.syntaxStatus(model.syntax_status),
        .rows = rows.items,
    });
}

fn installTreeSitterGrammar(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const language = try json_rpc.getStringParam(request, "language");
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);

    const progress = InstallProgress{ .runtime = runtime, .language = language };
    var result = try diff.syntax.installGrammar(runtime.allocator, runtime.io, language, grammar_root, progress);
    defer result.deinit(runtime.allocator);

    try types.writeJson(writer, types.installTreeSitterGrammarResult(result));
}

fn uninstallTreeSitterGrammar(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const language = try json_rpc.getStringParam(request, "language");
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);

    try runtime.syntax_cache_lock.lock(runtime.io);
    defer runtime.syntax_cache_lock.unlock(runtime.io);
    runtime.syntax_cache.removeLanguage(language);

    var result = try diff.syntax.uninstallGrammar(runtime.allocator, runtime.io, language, grammar_root);
    defer result.deinit(runtime.allocator);

    try types.writeJson(writer, types.uninstallTreeSitterGrammarResult(result));
}

fn listTreeSitterGrammars(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);

    const grammars = try diff.syntax.listGrammars(runtime.allocator, runtime.io, grammar_root);
    defer {
        for (grammars) |*grammar| grammar.deinit(runtime.allocator);
        runtime.allocator.free(grammars);
    }

    var result: std.ArrayList(types.TreeSitterGrammar) = .empty;
    defer result.deinit(runtime.allocator);
    for (grammars) |grammar| try result.append(runtime.allocator, types.treeSitterGrammar(grammar));

    try types.writeJson(writer, result.items);
}

fn syncTreeSitterRegistry(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const git_url = getOptionalStringParam(request, "gitUrl") orelse runtime.environ_map.get("DIFFUSE_TREE_SITTER_REGISTRY_GIT_URL") orelse "https://github.com/CrazyCatViking/diffuse-tree-sitter.git";
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);

    var result = try diff.syntax.syncRegistry(runtime.allocator, runtime.io, grammar_root, git_url);
    defer result.deinit(runtime.allocator);

    try types.writeJson(writer, types.syncTreeSitterRegistryResult(result));
}

fn getSyntaxSpans(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const side_text = try json_rpc.getStringParam(request, "side");
    const start_line = try getU32Param(request, "startLine");
    const end_line = try getU32Param(request, "endLine");
    const context = getDiffOption(request, "context") orelse "diff";
    const diff_context: diff.DiffContextMode = if (std.mem.eql(u8, context, "full")) .full else .diff;
    const side: diff.SyntaxSide = if (std.mem.eql(u8, side_text, "old")) .old else .new;

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const grammar_root = try resolveGrammarRoot(runtime.allocator, runtime.environ_map);
    defer if (grammar_root) |path| runtime.allocator.free(path);
    const target = getDiffTarget(request);
    try runtime.syntax_cache_lock.lock(runtime.io);
    defer runtime.syntax_cache_lock.unlock(runtime.io);

    const spans = try diff.getSyntaxSpans(runtime.allocator, repo.io, &runtime.syntax_cache, repo.root, file_id, file_id, .{ .context = diff_context, .grammar_root = grammar_root, .target = target }, side, start_line, end_line);
    defer diff.freeSyntaxLineSpans(runtime.allocator, spans);

    var result: std.ArrayList(types.SyntaxLineSpans) = .empty;
    defer result.deinit(runtime.allocator);
    for (spans) |line| try result.append(runtime.allocator, types.syntaxLineSpans(line));
    try types.writeJson(writer, result.items);
}

fn getLspStatus(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const side_text = getOptionalStringParam(request, "side") orelse "new";
    const side: diff.SyntaxSide = if (std.mem.eql(u8, side_text, "old")) .old else .new;

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const target = getDiffTarget(request);
    const path = try resolvePathForSide(runtime.allocator, repo, target, file_id, side);
    defer runtime.allocator.free(path);

    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);

    const status = try lsp.statusForPath(&runtime.lsp_manager, runtime.allocator, runtime.io, runtime.environ_map, repo.root, path);
    defer lsp.freeStatus(runtime.allocator, status);
    try types.writeJson(writer, types.lspStatus(status));
}

fn getLspConfigInfo(runtime: *Runtime, writer: *std.Io.Writer, _: json_rpc.Request) !void {
    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);

    var info = try lsp.configInfo(&runtime.lsp_manager, runtime.allocator, runtime.io, runtime.environ_map);
    defer info.deinit(runtime.allocator);

    var servers: std.ArrayList(types.LspServerInfo) = .empty;
    defer servers.deinit(runtime.allocator);
    for (info.servers) |server| try servers.append(runtime.allocator, types.lspServerInfo(server));
    try types.writeJson(writer, types.lspConfigInfo(info, servers.items));
}

fn getLspInstallInfo(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const server_id = try json_rpc.getStringParam(request, "serverId");
    const command = try json_rpc.getStringParam(request, "command");
    const info = try lsp.installInfo(runtime.allocator, server_id, command);
    defer info.deinit(runtime.allocator);
    try types.writeJson(writer, types.lspInstallInfo(info));
}

fn installLspServer(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const server_id = try json_rpc.getStringParam(request, "serverId");
    const command = try json_rpc.getStringParam(request, "command");
    const progress = LspInstallProgress{ .runtime = runtime, .server_id = server_id };
    var result = try lsp.installServer(runtime.allocator, runtime.io, runtime.environ_map, server_id, command, progress);
    defer result.deinit(runtime.allocator);
    try types.writeJson(writer, types.installLspServerResult(result));
}

fn restartLspServer(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const server_id = try json_rpc.getStringParam(request, "serverId");
    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);

    var result = try runtime.lsp_manager.restart(runtime.allocator, runtime.io, server_id);
    defer result.deinit(runtime.allocator);
    try types.writeJson(writer, types.restartLspServerResult(result));
}

fn getLspHover(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const side_text = try json_rpc.getStringParam(request, "side");
    const line = try getU32Param(request, "line");
    const column = try getU32Param(request, "column");
    const side: diff.SyntaxSide = if (std.mem.eql(u8, side_text, "old")) .old else .new;

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const target = getDiffTarget(request);
    const path = try resolvePathForSide(runtime.allocator, repo, target, file_id, side);
    defer runtime.allocator.free(path);
    const source = try diff.sourceForSide(runtime.allocator, runtime.io, repo.root, path, side, target);
    defer runtime.allocator.free(source);

    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);

    const result = try lsp.hover(&runtime.lsp_manager, runtime.allocator, runtime.io, runtime.environ_map, repo.root, path, source, line, column);
    defer lsp.freeHoverResult(runtime.allocator, result);
    try types.writeJson(writer, types.lspHover(result));
}

fn getLspDiagnostics(runtime: *Runtime, writer: *std.Io.Writer, request: json_rpc.Request) !void {
    const file_id = try json_rpc.getStringParam(request, "fileId");
    const side_text = try json_rpc.getStringParam(request, "side");
    const side: diff.SyntaxSide = if (std.mem.eql(u8, side_text, "old")) .old else .new;

    try runtime.session_lock.lockShared(runtime.io);
    defer runtime.session_lock.unlockShared(runtime.io);

    const repo = try runtime.session.requireRepo();
    const target = getDiffTarget(request);
    const path = try resolvePathForSide(runtime.allocator, repo, target, file_id, side);
    defer runtime.allocator.free(path);
    const source = try diff.sourceForSide(runtime.allocator, runtime.io, repo.root, path, side, target);
    defer runtime.allocator.free(source);

    try runtime.lsp_lock.lock(runtime.io);
    defer runtime.lsp_lock.unlock(runtime.io);

    const result = try lsp.diagnostics(&runtime.lsp_manager, runtime.allocator, runtime.io, runtime.environ_map, repo.root, path, source);
    defer lsp.freeDiagnosticsResult(runtime.allocator, result);
    var diagnostics: std.ArrayList(types.LspDiagnostic) = .empty;
    defer diagnostics.deinit(runtime.allocator);
    for (result.diagnostics) |diagnostic| try diagnostics.append(runtime.allocator, types.lspDiagnostic(diagnostic));
    try types.writeJson(writer, types.lspDiagnostics(result, diagnostics.items));
}

fn resolvePathForSide(allocator: std.mem.Allocator, repo: *repository.Repository, target: repository.DiffTarget, file_id: []const u8, side: diff.SyntaxSide) ![]u8 {
    const files = repo.listChangedFiles(target) catch return allocator.dupe(u8, file_id);
    defer repository.freeChangedFiles(allocator, files);
    for (files) |file| {
        if (!std.mem.eql(u8, file.id, file_id) and
            !(file.old_path != null and std.mem.eql(u8, file.old_path.?, file_id)) and
            !(file.new_path != null and std.mem.eql(u8, file.new_path.?, file_id))) continue;
        return switch (side) {
            .old => allocator.dupe(u8, file.old_path orelse file.new_path orelse file.id),
            .new => allocator.dupe(u8, file.new_path orelse file.old_path orelse file.id),
        };
    }
    return allocator.dupe(u8, file_id);
}

const InstallProgress = struct {
    runtime: *Runtime,
    language: []const u8,

    pub fn emit(self: InstallProgress, step: []const u8) !void {
        var message = std.Io.Writer.Allocating.init(self.runtime.allocator);
        errdefer message.deinit();

        try message.writer.writeAll("{\"jsonrpc\":\"2.0\",\"method\":\"treeSitter/installProgress\",\"params\":{");
        try message.writer.writeAll("\"language\":");
        try types.writeJson(&message.writer, self.language);
        try message.writer.writeAll(",\"step\":");
        try types.writeJson(&message.writer, step);
        try message.writer.writeAll("}}\n");

        try self.runtime.enqueue(try message.toOwnedSlice());
    }
};

const LspInstallProgress = struct {
    runtime: *Runtime,
    server_id: []const u8,

    pub fn emit(self: LspInstallProgress, step: []const u8) !void {
        var message = std.Io.Writer.Allocating.init(self.runtime.allocator);
        errdefer message.deinit();

        try message.writer.writeAll("{\"jsonrpc\":\"2.0\",\"method\":\"lsp/installProgress\",\"params\":{");
        try message.writer.writeAll("\"serverId\":");
        try types.writeJson(&message.writer, self.server_id);
        try message.writer.writeAll(",\"step\":");
        try types.writeJson(&message.writer, step);
        try message.writer.writeAll("}}\n");

        try self.runtime.enqueue(try message.toOwnedSlice());
    }
};

fn resolveGrammarRoot(allocator: std.mem.Allocator, environ_map: *const std.process.Environ.Map) !?[]u8 {
    if (environ_map.get("DIFFUSE_GRAMMARS_DIR")) |path| return try allocator.dupe(u8, path);
    const home = environ_map.get("HOME") orelse return null;
    return try std.fs.path.join(allocator, &.{ home, ".diffuse", "grammars" });
}

fn getDiffOption(request: json_rpc.Request, name: []const u8) ?[]const u8 {
    const params = request.value.value.object.get("params") orelse return null;
    const params_object = switch (params) {
        .object => |object| object,
        else => return null,
    };
    const options = params_object.get("options") orelse return null;
    const options_object = switch (options) {
        .object => |object| object,
        else => return null,
    };
    const value = options_object.get(name) orelse return null;
    return switch (value) {
        .string => |text| text,
        else => null,
    };
}

fn getOptionalStringParam(request: json_rpc.Request, name: []const u8) ?[]const u8 {
    const params = request.value.value.object.get("params") orelse return null;
    const params_object = switch (params) {
        .object => |object| object,
        else => return null,
    };
    return getOptionalString(params_object, name);
}

fn getObjectParam(request: json_rpc.Request, name: []const u8) !std.json.Value {
    const params = request.value.value.object.get("params") orelse return error.MissingParams;
    const params_object = switch (params) {
        .object => |object| object,
        else => return error.InvalidParams,
    };
    const value = params_object.get(name) orelse return error.MissingParam;
    return switch (value) {
        .object => value,
        else => error.InvalidParam,
    };
}

fn getObjectRequiredString(value: std.json.Value, name: []const u8) ![]const u8 {
    const object = switch (value) {
        .object => |object| object,
        else => return error.InvalidParam,
    };
    const field = object.get(name) orelse return error.MissingParam;
    return switch (field) {
        .string => |text| text,
        else => error.InvalidParam,
    };
}

fn getRequiredString(object: std.json.ObjectMap, name: []const u8) ![]const u8 {
    const field = object.get(name) orelse return error.MissingParam;
    return switch (field) {
        .string => |text| text,
        else => error.InvalidParam,
    };
}

fn getOptionalString(object: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const field = object.get(name) orelse return null;
    return switch (field) {
        .string => |text| if (text.len == 0) null else text,
        else => null,
    };
}

fn isActiveRunStatus(status: []const u8) bool {
    return std.mem.eql(u8, status, "starting") or
        std.mem.eql(u8, status, "planning") or
        std.mem.eql(u8, status, "running") or
        std.mem.eql(u8, status, "cancelling");
}

fn getRequiredU32(object: std.json.ObjectMap, name: []const u8) !u32 {
    const field = object.get(name) orelse return error.MissingParam;
    return switch (field) {
        .integer => |number| if (number >= 0) @intCast(number) else error.InvalidParam,
        else => error.InvalidParam,
    };
}

fn writeJsonField(writer: *std.Io.Writer, name: []const u8, value: []const u8, first: bool) !void {
    if (!first) try writer.writeByte(',');
    try types.writeJson(writer, name);
    try writer.writeByte(':');
    try types.writeJson(writer, value);
}

fn stringifyJsonValue(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    var buffer = std.Io.Writer.Allocating.init(allocator);
    errdefer buffer.deinit();
    try std.json.Stringify.value(value, .{ .emit_null_optional_fields = false }, &buffer.writer);
    return try buffer.toOwnedSlice();
}

fn writeCompactJson(allocator: std.mem.Allocator, writer: *std.Io.Writer, json: []const u8) !void {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, json, .{});
    defer parsed.deinit();
    try std.json.Stringify.value(parsed.value, .{ .emit_null_optional_fields = false }, writer);
}

fn getDiffTarget(request: json_rpc.Request) repository.DiffTarget {
    const params = request.value.value.object.get("params") orelse return .{};
    const params_object = switch (params) {
        .object => |object| object,
        else => return .{},
    };
    const target = params_object.get("target") orelse return .{};
    const target_object = switch (target) {
        .object => |object| object,
        else => return .{},
    };

    return .{
        .base = getObjectString(target_object, "base"),
        .compare = getObjectString(target_object, "compare"),
        .include_staged = getObjectBool(target_object, "includeStaged") orelse true,
        .include_unstaged = getObjectBool(target_object, "includeUnstaged") orelse true,
    };
}

fn getObjectString(object: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .string => |text| if (text.len == 0) null else text,
        else => null,
    };
}

fn getObjectBool(object: std.json.ObjectMap, name: []const u8) ?bool {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .bool => |enabled| enabled,
        else => null,
    };
}

fn getU32Param(request: json_rpc.Request, name: []const u8) !u32 {
    const params = request.value.value.object.get("params") orelse return error.MissingParams;
    const params_object = switch (params) {
        .object => |object| object,
        else => return error.InvalidParams,
    };
    const value = params_object.get(name) orelse return error.MissingParam;
    return switch (value) {
        .integer => |number| @intCast(number),
        else => error.InvalidParam,
    };
}
