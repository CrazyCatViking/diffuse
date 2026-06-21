const std = @import("std");
const builtin = @import("builtin");

pub fn build(b: *std.Build) void {
    const default_target: std.Target.Query = switch (builtin.os.tag) {
        .linux => .{ .cpu_arch = .x86_64, .os_tag = .linux, .abi = .gnu },
        .windows => .{ .cpu_arch = .x86_64, .os_tag = .windows },
        .macos => .{ .cpu_arch = .x86_64, .os_tag = .macos },
        else => .{},
    };
    const target = b.standardTargetOptions(.{ .default_target = default_target });
    const optimize = b.standardOptimizeOption(.{});

    const root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const tree_sitter = b.dependency("tree_sitter_zig_bindings", .{
        .target = target,
        .optimize = optimize,
    });
    root_module.addImport("tree-sitter", tree_sitter.module("tree_sitter"));

    const exe = b.addExecutable(.{
        .name = "diffuse",
        .root_module = root_module,
    });

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);

    const run_step = b.step("run", "Run diffuse");
    run_step.dependOn(&run_cmd.step);
}
