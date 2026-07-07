const repository_handlers = @import("repository_handlers.zig");
const diff_handlers = @import("diff_handlers.zig");
const diff_analysis_handlers = @import("diff_analysis_handlers.zig");
const syntax_handlers = @import("syntax_handlers.zig");
const lsp_handlers = @import("lsp_handlers.zig");
const review_handlers = @import("review_handlers.zig");
const search_handlers = @import("search_handlers.zig");

pub fn register(server: anytype) !void {
    try repository_handlers.register(server);
    try diff_handlers.register(server);
    try diff_analysis_handlers.register(server);
    try syntax_handlers.register(server);
    try lsp_handlers.register(server);
    try review_handlers.register(server);
    try search_handlers.register(server);
}
