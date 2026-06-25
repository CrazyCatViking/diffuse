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
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, line, .{ .allocate = .alloc_always });
    errdefer parsed.deinit();

    const object = switch (parsed.value) {
        .object => |object| object,
        else => return error.InvalidRequest,
    };
    if (object.get("jsonrpc")) |jsonrpc| {
        const version = switch (jsonrpc) {
            .string => |value| value,
            else => return error.InvalidRequest,
        };
        if (!std.mem.eql(u8, version, "2.0")) return error.InvalidRequest;
    }
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
    try writer.writeAll("}}\n");
}

pub fn writeErrorNullId(writer: anytype, code: i64, message: []const u8) !void {
    try writer.print("{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":{},\"message\":", .{code});
    const types = @import("types.zig");
    try types.writeJsonString(writer, message);
    try writer.writeAll("}}\n");
}

pub fn paramsObject(request: Request) !std.json.ObjectMap {
    const params = request.value.value.object.get("params") orelse return error.MissingParams;
    return switch (params) {
        .object => |object| object,
        else => error.InvalidParams,
    };
}

pub fn getStringParam(request: Request, name: []const u8) ![]const u8 {
    const params_object = try paramsObject(request);
    const value = params_object.get(name) orelse return error.MissingParam;
    return switch (value) {
        .string => |text| text,
        else => error.InvalidParam,
    };
}

test "parseRequest rejects non-object requests" {
    try std.testing.expectError(error.InvalidRequest, parseRequest(std.testing.allocator, "[]"));
}

test "parseRequest rejects invalid jsonrpc version" {
    try std.testing.expectError(error.InvalidRequest, parseRequest(std.testing.allocator, "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"getVersion\"}"));
}

test "parseRequest accepts jsonrpc request" {
    const request = try parseRequest(std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getVersion\",\"params\":{}} ");
    defer request.deinit();
    try std.testing.expectEqual(@as(i64, 1), request.id);
    try std.testing.expectEqualStrings("getVersion", request.method);
}
