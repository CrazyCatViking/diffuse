const std = @import("std");

test {
    _ = std;
    _ = @import("core/review.zig");
    _ = @import("protocol/json_rpc.zig");
    _ = @import("app/rpc_params.zig");
}
