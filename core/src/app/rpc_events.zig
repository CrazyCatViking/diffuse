const std = @import("std");

const runtime_mod = @import("rpc_runtime.zig");
const types = @import("../protocol/types.zig");

const Runtime = runtime_mod.Runtime;

pub fn emitReviewChanged(runtime: *Runtime, root: []const u8, session_id: []const u8, change: []const u8) !void {
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

pub const TreeSitterInstallProgress = struct {
    runtime: *Runtime,
    language: []const u8,

    pub fn emit(self: TreeSitterInstallProgress, step: []const u8) !void {
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

pub const LspInstallProgress = struct {
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
