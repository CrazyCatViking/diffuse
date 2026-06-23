const std = @import("std");

const json_rpc = @import("../protocol/json_rpc.zig");
const diff = @import("../core/diff.zig");
const repository = @import("../core/repository.zig");
const review = @import("../core/review.zig");
const types = @import("../protocol/types.zig");

pub const DiffRenderOptions = struct {
    mode: []const u8,
    context: []const u8,
    diff_context: diff.DiffContextMode,
};

pub fn resolveGrammarRoot(allocator: std.mem.Allocator, environ_map: *const std.process.Environ.Map) !?[]u8 {
    if (environ_map.get("DIFFUSE_GRAMMARS_DIR")) |path| return try allocator.dupe(u8, path);
    const home = environ_map.get("HOME") orelse return null;
    return try std.fs.path.join(allocator, &.{ home, ".diffuse", "grammars" });
}

pub fn getDiffRenderOptions(request: json_rpc.Request) !DiffRenderOptions {
    const context = try getDiffContextText(request);
    return .{
        .mode = (try getDiffOptionEnum(request, "mode", &.{ "split", "inline" })) orelse "split",
        .context = context,
        .diff_context = diffContextMode(context),
    };
}

pub fn getDiffContextText(request: json_rpc.Request) ![]const u8 {
    return (try getDiffOptionEnum(request, "context", &.{ "diff", "full" })) orelse "diff";
}

pub fn getDiffContextMode(request: json_rpc.Request) !diff.DiffContextMode {
    return diffContextMode(try getDiffContextText(request));
}

fn diffContextMode(context: []const u8) diff.DiffContextMode {
    return if (std.mem.eql(u8, context, "full")) .full else .diff;
}

fn getDiffOptionEnum(request: json_rpc.Request, name: []const u8, allowed: []const []const u8) !?[]const u8 {
    const params = request.value.value.object.get("params") orelse return null;
    const params_object = switch (params) {
        .object => |object| object,
        else => return error.InvalidParams,
    };
    const options = params_object.get("options") orelse return null;
    const options_object = switch (options) {
        .object => |object| object,
        else => return error.InvalidParam,
    };
    const value = options_object.get(name) orelse return null;
    return try enumString(value, allowed);
}

pub fn getOptionalStringParam(request: json_rpc.Request, name: []const u8) !?[]const u8 {
    const params = request.value.value.object.get("params") orelse return null;
    const params_object = switch (params) {
        .object => |object| object,
        else => return error.InvalidParams,
    };
    return try getOptionalStringStrict(params_object, name);
}

pub fn getSyntaxSideParam(request: json_rpc.Request, name: []const u8) !diff.SyntaxSide {
    return syntaxSide(try json_rpc.getStringParam(request, name));
}

pub fn getOptionalSyntaxSideParam(request: json_rpc.Request, name: []const u8, default: diff.SyntaxSide) !diff.SyntaxSide {
    const params = request.value.value.object.get("params") orelse return default;
    const params_object = switch (params) {
        .object => |object| object,
        else => return error.InvalidParams,
    };
    const value = params_object.get(name) orelse return default;
    const text = switch (value) {
        .string => |inner| inner,
        else => return error.InvalidParam,
    };
    return syntaxSide(text);
}

fn syntaxSide(text: []const u8) !diff.SyntaxSide {
    if (std.mem.eql(u8, text, "old")) return .old;
    if (std.mem.eql(u8, text, "new")) return .new;
    return error.InvalidParam;
}

pub fn getObjectParam(request: json_rpc.Request, name: []const u8) !std.json.Value {
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

pub fn getObjectRequiredString(value: std.json.Value, name: []const u8) ![]const u8 {
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

pub fn getObjectRequiredReviewId(value: std.json.Value, name: []const u8) ![]const u8 {
    const id = try getObjectRequiredString(value, name);
    try review.validatePathSegment(id);
    return id;
}

pub fn getRequiredString(object: std.json.ObjectMap, name: []const u8) ![]const u8 {
    const field = object.get(name) orelse return error.MissingParam;
    return switch (field) {
        .string => |text| text,
        else => error.InvalidParam,
    };
}

pub fn getRequiredReviewId(object: std.json.ObjectMap, name: []const u8) ![]const u8 {
    const id = try getRequiredString(object, name);
    try review.validatePathSegment(id);
    return id;
}

pub fn getReviewIdParam(request: json_rpc.Request, name: []const u8) ![]const u8 {
    const id = try json_rpc.getStringParam(request, name);
    try review.validatePathSegment(id);
    return id;
}

pub fn getOptionalString(object: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const field = object.get(name) orelse return null;
    return switch (field) {
        .string => |text| if (text.len == 0) null else text,
        else => null,
    };
}

fn getOptionalStringStrict(object: std.json.ObjectMap, name: []const u8) !?[]const u8 {
    const field = object.get(name) orelse return null;
    return switch (field) {
        .null => null,
        .string => |text| if (text.len == 0) null else text,
        else => error.InvalidParam,
    };
}

pub fn isActiveRunStatus(status: []const u8) bool {
    return std.mem.eql(u8, status, "starting") or
        std.mem.eql(u8, status, "planning") or
        std.mem.eql(u8, status, "running") or
        std.mem.eql(u8, status, "cancelling");
}

pub fn getRequiredU32(object: std.json.ObjectMap, name: []const u8) !u32 {
    const field = object.get(name) orelse return error.MissingParam;
    return switch (field) {
        .integer => |number| if (number >= 0 and number <= std.math.maxInt(u32)) @intCast(number) else error.InvalidParam,
        else => error.InvalidParam,
    };
}

pub fn writeJsonField(writer: *std.Io.Writer, name: []const u8, value: []const u8, first: bool) !void {
    if (!first) try writer.writeByte(',');
    try types.writeJson(writer, name);
    try writer.writeByte(':');
    try types.writeJson(writer, value);
}

pub fn stringifyJsonValue(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    var buffer = std.Io.Writer.Allocating.init(allocator);
    errdefer buffer.deinit();
    try std.json.Stringify.value(value, .{ .emit_null_optional_fields = false }, &buffer.writer);
    return try buffer.toOwnedSlice();
}

pub fn cloneJsonValue(allocator: std.mem.Allocator, value: std.json.Value) !std.json.Value {
    return switch (value) {
        .null => .null,
        .bool => |inner| .{ .bool = inner },
        .integer => |inner| .{ .integer = inner },
        .float => |inner| .{ .float = inner },
        .number_string => |inner| .{ .number_string = try allocator.dupe(u8, inner) },
        .string => |inner| .{ .string = try allocator.dupe(u8, inner) },
        .array => |inner| blk: {
            var cloned: std.json.Array = .init(allocator);
            for (inner.items) |item| try cloned.append(try cloneJsonValue(allocator, item));
            break :blk .{ .array = cloned };
        },
        .object => |inner| blk: {
            var cloned: std.json.ObjectMap = .empty;
            var iterator = inner.iterator();
            while (iterator.next()) |entry| {
                const key = try allocator.dupe(u8, entry.key_ptr.*);
                try cloned.put(allocator, key, try cloneJsonValue(allocator, entry.value_ptr.*));
            }
            break :blk .{ .object = cloned };
        },
    };
}

pub fn writeCompactJson(allocator: std.mem.Allocator, writer: *std.Io.Writer, json: []const u8) !void {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, json, .{});
    defer parsed.deinit();
    try std.json.Stringify.value(parsed.value, .{ .emit_null_optional_fields = false }, writer);
}

pub fn getDiffTarget(request: json_rpc.Request) !repository.DiffTarget {
    const params = request.value.value.object.get("params") orelse return .{};
    const params_object = switch (params) {
        .object => |object| object,
        else => return error.InvalidParams,
    };
    const target = params_object.get("target") orelse return .{};
    const target_object = switch (target) {
        .object => |object| object,
        else => return error.InvalidParam,
    };

    return .{
        .base = try getObjectString(target_object, "base"),
        .compare = try getObjectString(target_object, "compare"),
        .include_staged = (try getObjectBool(target_object, "includeStaged")) orelse true,
        .include_unstaged = (try getObjectBool(target_object, "includeUnstaged")) orelse true,
    };
}

pub fn getObjectString(object: std.json.ObjectMap, name: []const u8) !?[]const u8 {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .null => null,
        .string => |text| if (text.len == 0) null else text,
        else => error.InvalidParam,
    };
}

pub fn getObjectBool(object: std.json.ObjectMap, name: []const u8) !?bool {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .null => null,
        .bool => |enabled| enabled,
        else => error.InvalidParam,
    };
}

pub fn getU32Param(request: json_rpc.Request, name: []const u8) !u32 {
    const params = request.value.value.object.get("params") orelse return error.MissingParams;
    const params_object = switch (params) {
        .object => |object| object,
        else => return error.InvalidParams,
    };
    const value = params_object.get(name) orelse return error.MissingParam;
    return switch (value) {
        .integer => |number| if (number >= 0 and number <= std.math.maxInt(u32)) @intCast(number) else error.InvalidParam,
        else => error.InvalidParam,
    };
}

fn enumString(value: std.json.Value, allowed: []const []const u8) ![]const u8 {
    const text = switch (value) {
        .string => |inner| inner,
        else => return error.InvalidParam,
    };
    for (allowed) |allowed_value| {
        if (std.mem.eql(u8, text, allowed_value)) return text;
    }
    return error.InvalidParam;
}

test "rpc params validates diff render options" {
    const request = try json_rpc.parseRequest(std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getDiffRenderModel\",\"params\":{\"options\":{\"mode\":\"inline\",\"context\":\"full\"}}}");
    defer request.deinit();

    const options = try getDiffRenderOptions(request);
    try std.testing.expectEqualStrings("inline", options.mode);
    try std.testing.expectEqualStrings("full", options.context);
    try std.testing.expectEqual(diff.DiffContextMode.full, options.diff_context);
}

test "rpc params rejects invalid diff render option enum" {
    const request = try json_rpc.parseRequest(std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getDiffRenderModel\",\"params\":{\"options\":{\"mode\":\"sideways\"}}}");
    defer request.deinit();

    try std.testing.expectError(error.InvalidParam, getDiffRenderOptions(request));
}

test "rpc params validates syntax side" {
    const request = try json_rpc.parseRequest(std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSyntaxSpans\",\"params\":{\"side\":\"old\"}}");
    defer request.deinit();

    try std.testing.expectEqual(diff.SyntaxSide.old, try getSyntaxSideParam(request, "side"));
}

test "rpc params rejects invalid syntax side" {
    const request = try json_rpc.parseRequest(std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSyntaxSpans\",\"params\":{\"side\":\"left\"}}");
    defer request.deinit();

    try std.testing.expectError(error.InvalidParam, getSyntaxSideParam(request, "side"));
}

test "rpc params rejects invalid diff target field types" {
    const request = try json_rpc.parseRequest(std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"listChangedFiles\",\"params\":{\"target\":{\"base\":42,\"includeStaged\":true}}}");
    defer request.deinit();

    try std.testing.expectError(error.InvalidParam, getDiffTarget(request));
}

test "rpc params rejects invalid u32 params" {
    const negative = try json_rpc.parseRequest(std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSyntaxSpans\",\"params\":{\"line\":-1}}");
    defer negative.deinit();
    try std.testing.expectError(error.InvalidParam, getU32Param(negative, "line"));

    const overflow = try json_rpc.parseRequest(std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSyntaxSpans\",\"params\":{\"line\":4294967296}}");
    defer overflow.deinit();
    try std.testing.expectError(error.InvalidParam, getU32Param(overflow, "line"));
}
