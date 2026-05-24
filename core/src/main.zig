const std = @import("std");

const cli = @import("app/cli.zig");

pub fn main(init: std.process.Init) !void {
    try cli.run(init.gpa, init.io, init.minimal.args);
}
