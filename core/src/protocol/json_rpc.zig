const std = @import("std");

pub const Request = struct {
    id: i64,
    method: []const u8,
    value: std.json.Parsed(std.json.Value),

    pub fn deinit(self: Request) void {
        self.value.deinit();
    }
};

pub fn parseRequest(allocator: std.mem.Allocator, line: []const u8) !Request {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, line, .{});
    errdefer parsed.deinit();

    const object = parsed.value.object;
    const id_value = object.get("id") orelse return error.MissingId;
    const method_value = object.get("method") orelse return error.MissingMethod;

    return .{
        .id = switch (id_value) {
            .integer => |value| value,
            else => return error.InvalidId,
        },
        .method = switch (method_value) {
            .string => |value| value,
            else => return error.InvalidMethod,
        },
        .value = parsed,
    };
}

pub fn writeResult(writer: anytype, id: i64, result_writer: anytype) !void {
    try writer.print("{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":", .{id});
    try result_writer(writer);
    try writer.writeAll("}\n");
}

pub fn writeRawResultPrefix(writer: anytype, id: i64) !void {
    try writer.print("{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":", .{id});
}

pub fn writeRawResultSuffix(writer: anytype) !void {
    try writer.writeAll("}\n");
}

pub fn writeError(writer: anytype, id: i64, code: i64, message: []const u8) !void {
    try writer.print("{{\"jsonrpc\":\"2.0\",\"id\":{},\"error\":{{\"code\":{},\"message\":", .{ id, code });
    const types = @import("types.zig");
    try types.writeJsonString(writer, message);
    try writer.writeAll("}}}\n");
}

pub fn getStringParam(request: Request, name: []const u8) ![]const u8 {
    const params = request.value.value.object.get("params") orelse return error.MissingParams;
    const params_object = switch (params) {
        .object => |object| object,
        else => return error.InvalidParams,
    };
    const value = params_object.get(name) orelse return error.MissingParam;
    return switch (value) {
        .string => |text| text,
        else => error.InvalidParam,
    };
}
