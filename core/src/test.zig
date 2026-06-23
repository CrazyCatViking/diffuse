const std = @import("std");

test {
    _ = std;
    _ = @import("core/review.zig");
    _ = @import("protocol/json_rpc.zig");
}
