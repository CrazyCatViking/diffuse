const std = @import("std");

const diff = @import("../core/diff.zig");
const repository = @import("../core/repository.zig");
const rpc_server = @import("rpc_server.zig");
const types = @import("../protocol/types.zig");

pub fn run(allocator: std.mem.Allocator, io: std.Io, process_args: std.process.Args) !void {
    var iter = try std.process.Args.Iterator.initAllocator(process_args, allocator);
    defer iter.deinit();

    var args_list: std.ArrayList([]const u8) = .empty;
    defer args_list.deinit(allocator);
    while (iter.next()) |arg| try args_list.append(allocator, arg);
    const args = args_list.items;

    if (args.len <= 1) {
        try printHelp(io);
        return;
    }

    const command = args[1];
    if (std.mem.eql(u8, command, "version")) {
        var stdout_buffer: [1024]u8 = undefined;
        var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
        const stdout = &stdout_writer.interface;
        try stdout.print("{s} {s}\n", .{ types.app_name, types.version });
        try stdout.flush();
    } else if (std.mem.eql(u8, command, "rpc")) {
        try rpc_server.run(allocator, io);
    } else if (std.mem.eql(u8, command, "files")) {
        const repo_path = try readOption(args, "--repo");
        var repo = try repository.open(allocator, io, repo_path);
        defer repo.deinit();
        const files = try repo.listChangedFiles();
        defer repository.freeChangedFiles(allocator, files);
        var stdout_buffer: [4096]u8 = undefined;
        var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
        const stdout = &stdout_writer.interface;

        var result: std.ArrayList(types.ChangedFile) = .empty;
        defer result.deinit(allocator);
        for (files) |file| try result.append(allocator, types.changedFile(file));

        try types.writeJson(stdout, result.items);
        try stdout.writeByte('\n');
        try stdout.flush();
    } else if (std.mem.eql(u8, command, "diff")) {
        const repo_path = try readOption(args, "--repo");
        const file_path = try readOption(args, "--file");
        var repo = try repository.open(allocator, io, repo_path);
        defer repo.deinit();
        var model = try diff.getDiffRenderModel(allocator, io, repo.root, file_path, file_path, .{});
        defer model.deinit(allocator);
        var stdout_buffer: [4096]u8 = undefined;
        var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
        const stdout = &stdout_writer.interface;

        var rows: std.ArrayList(types.DiffRow) = .empty;
        defer rows.deinit(allocator);
        for (model.rows.items) |row| try rows.append(allocator, types.diffRow(row));

        try types.writeJson(stdout, types.DiffRenderModel{
            .fileId = model.file_id,
            .mode = "split",
            .context = "diff",
            .rows = rows.items,
        });
        try stdout.writeByte('\n');
        try stdout.flush();
    } else {
        try printHelp(io);
        std.process.exit(1);
    }
}

fn readOption(args: []const []const u8, name: []const u8) ![]const u8 {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], name)) return args[i + 1];
    }
    return error.MissingOption;
}

fn printHelp(io: std.Io) !void {
    var buffer: [1024]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(io, &buffer);
    const stdout = &stdout_writer.interface;
    try stdout.writeAll(
        \\Usage:
        \\  diffuse version
        \\  diffuse rpc
        \\  diffuse files --repo <path>
        \\  diffuse diff --repo <path> --file <path>
        \\
    );
    try stdout.flush();
}
