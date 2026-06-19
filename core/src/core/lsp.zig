const std = @import("std");

const diff = @import("diff.zig");
const repository = @import("repository.zig");

pub const Side = diff.SyntaxSide;

pub const Config = struct {
    id: []const u8,
    language: []const u8,
    command: []const u8,
    args: []const []const u8 = &.{},
    source: []const u8,

    pub fn deinit(self: *Config, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.language);
        allocator.free(self.command);
        for (self.args) |arg| allocator.free(arg);
        allocator.free(self.args);
        allocator.free(self.source);
    }
};

pub const Status = struct {
    language: ?[]const u8 = null,
    serverId: ?[]const u8 = null,
    command: ?[]const u8 = null,
    configured: bool = false,
    installed: bool = false,
    starting: bool = false,
    running: bool = false,
    configSource: ?[]const u8 = null,
    lastError: ?[]const u8 = null,
    message: ?[]const u8 = null,
};

pub const ConfigInfo = struct {
    config_path: ?[]const u8 = null,
    servers: []const ServerInfo,

    pub fn deinit(self: *ConfigInfo, allocator: std.mem.Allocator) void {
        if (self.config_path) |value| allocator.free(value);
        for (self.servers) |*server| server.deinit(allocator);
        allocator.free(self.servers);
    }
};

pub const ServerInfo = struct {
    language: []const u8,
    server_id: []const u8,
    command: []const u8,
    args: []const []const u8,
    config_source: []const u8,
    installed: bool,
    starting: bool = false,
    running: bool = false,
    last_error: ?[]const u8 = null,
    install_info: ?InstallInfo = null,

    pub fn deinit(self: *const ServerInfo, allocator: std.mem.Allocator) void {
        allocator.free(self.language);
        allocator.free(self.server_id);
        allocator.free(self.command);
        for (self.args) |arg| allocator.free(arg);
        allocator.free(self.args);
        allocator.free(self.config_source);
        if (self.last_error) |value| allocator.free(value);
        if (self.install_info) |*value| value.deinit(allocator);
    }
};

pub const InstallInfo = struct {
    manager: []const u8,
    command: []const u8,
    args: []const []const u8,
    description: []const u8,
    requires_shell: bool = false,
    safe_to_run: bool = false,
    note: ?[]const u8 = null,

    pub fn deinit(self: *const InstallInfo, allocator: std.mem.Allocator) void {
        allocator.free(self.manager);
        allocator.free(self.command);
        for (self.args) |arg| allocator.free(arg);
        allocator.free(self.args);
        allocator.free(self.description);
        if (self.note) |value| allocator.free(value);
    }
};

const SessionInfo = struct {
    starting: bool = false,
    running: bool = false,
    last_error: ?[]const u8 = null,
};

pub const HoverResult = struct {
    status: []const u8,
    language: ?[]const u8 = null,
    serverId: ?[]const u8 = null,
    contents: ?[]const u8 = null,
    message: ?[]const u8 = null,
};

pub const Diagnostic = struct {
    line: u32,
    startColumn: u32,
    endColumn: u32,
    severity: []const u8,
    message: []const u8,
    source: ?[]const u8 = null,
    code: ?[]const u8 = null,

    fn deinit(self: Diagnostic, allocator: std.mem.Allocator) void {
        allocator.free(self.severity);
        allocator.free(self.message);
        if (self.source) |value| allocator.free(value);
        if (self.code) |value| allocator.free(value);
    }
};

pub const DiagnosticsResult = struct {
    status: []const u8,
    language: ?[]const u8 = null,
    serverId: ?[]const u8 = null,
    diagnostics: []const Diagnostic = &.{},
    message: ?[]const u8 = null,
};

pub const InstallResult = struct {
    serverId: []const u8,
    command: []const u8,
    installed: bool,
    message: ?[]const u8 = null,

    pub fn deinit(self: *InstallResult, allocator: std.mem.Allocator) void {
        allocator.free(self.serverId);
        allocator.free(self.command);
        if (self.message) |value| allocator.free(value);
    }
};

pub const RestartResult = struct {
    serverId: []const u8,
    restarted: bool,
    message: ?[]const u8 = null,

    pub fn deinit(self: *RestartResult, allocator: std.mem.Allocator) void {
        allocator.free(self.serverId);
        if (self.message) |value| allocator.free(value);
    }
};

const DocumentState = struct {
    hash: u64,
    version: u32,
};

pub const Manager = struct {
    allocator: std.mem.Allocator,
    sessions: std.ArrayList(Session),

    pub fn init(allocator: std.mem.Allocator) Manager {
        return .{ .allocator = allocator, .sessions = .empty };
    }

    pub fn deinit(self: *Manager, io: std.Io) void {
        for (self.sessions.items) |*session| session.deinit(self.allocator, io);
        self.sessions.deinit(self.allocator);
    }

    fn hover(self: *Manager, io: std.Io, repo_root: []const u8, path: []const u8, source: []const u8, line: u32, column: u32, config: Config) ![]u8 {
        const session = try self.sessionFor(io, repo_root, config);
        return session.hover(self.allocator, io, repo_root, path, source, line, column, config.language) catch |err| {
            try session.setLastError(self.allocator, err);
            return err;
        };
    }

    fn diagnostics(self: *Manager, io: std.Io, repo_root: []const u8, path: []const u8, source: []const u8, config: Config) ![]Diagnostic {
        const session = try self.sessionFor(io, repo_root, config);
        return session.collectDiagnostics(self.allocator, io, repo_root, path, source, config.language) catch |err| {
            try session.setLastError(self.allocator, err);
            return err;
        };
    }

    fn sessionInfo(self: *Manager, allocator: std.mem.Allocator, repo_root: []const u8, language: []const u8, server_id: []const u8) !SessionInfo {
        for (self.sessions.items) |session| {
            if (std.mem.eql(u8, session.repo_root, repo_root) and
                std.mem.eql(u8, session.language, language) and
                std.mem.eql(u8, session.server_id, server_id)) return session.info(allocator);
        }
        return .{};
    }

    fn anySessionInfo(self: *Manager, allocator: std.mem.Allocator, language: []const u8, server_id: []const u8) !SessionInfo {
        for (self.sessions.items) |session| {
            if (std.mem.eql(u8, session.language, language) and
                std.mem.eql(u8, session.server_id, server_id)) return session.info(allocator);
        }
        return .{};
    }

    pub fn restart(self: *Manager, allocator: std.mem.Allocator, io: std.Io, server_id: []const u8) !RestartResult {
        var restarted = false;
        var index: usize = 0;
        while (index < self.sessions.items.len) {
            if (!std.mem.eql(u8, self.sessions.items[index].server_id, server_id)) {
                index += 1;
                continue;
            }
            var session = self.sessions.swapRemove(index);
            session.deinit(allocator, io);
            restarted = true;
        }
        return .{
            .serverId = try allocator.dupe(u8, server_id),
            .restarted = restarted,
            .message = try allocator.dupe(u8, if (restarted) "Language server session stopped. It will restart on the next request." else "No running session found."),
        };
    }

    fn sessionFor(self: *Manager, io: std.Io, repo_root: []const u8, config: Config) !*Session {
        for (self.sessions.items) |*session| {
            if (std.mem.eql(u8, session.repo_root, repo_root) and
                std.mem.eql(u8, session.language, config.language) and
                std.mem.eql(u8, session.server_id, config.id)) return session;
        }

        var session = try Session.start(self.allocator, io, repo_root, config);
        errdefer session.deinit(self.allocator, io);
        try self.sessions.append(self.allocator, session);
        return &self.sessions.items[self.sessions.items.len - 1];
    }
};

const Session = struct {
    repo_root: []const u8,
    language: []const u8,
    server_id: []const u8,
    child: std.process.Child,
    stream: LspStream,
    next_id: i64 = 1,
    supports_pull_diagnostics: bool = false,
    running: bool = false,
    last_error: ?[]const u8 = null,
    documents: std.StringHashMap(DocumentState),
    diagnostics: std.StringHashMap([]Diagnostic),

    fn start(allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, config: Config) !Session {
        var argv: std.ArrayList([]const u8) = .empty;
        defer argv.deinit(allocator);
        try argv.append(allocator, config.command);
        for (config.args) |arg| try argv.append(allocator, arg);

        var child = try std.process.spawn(io, .{
            .argv = argv.items,
            .cwd = .{ .path = repo_root },
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = .ignore,
        });
        errdefer child.kill(io);

        var session = Session{
            .repo_root = try allocator.dupe(u8, repo_root),
            .language = try allocator.dupe(u8, config.language),
            .server_id = try allocator.dupe(u8, config.id),
            .child = child,
            .stream = LspStream.init(allocator, child.stdout.?.handle),
            .documents = std.StringHashMap(DocumentState).init(allocator),
            .diagnostics = std.StringHashMap([]Diagnostic).init(allocator),
        };
        errdefer session.deinit(allocator, io);

        var write_buffer: [8192]u8 = undefined;
        var stdin_writer = session.child.stdin.?.writer(io, &write_buffer);
        const writer = &stdin_writer.interface;
        const initialize_id = session.nextId();
        try sendInitialize(allocator, writer, repo_root, initialize_id);
        const initialize_response = try session.readUntilResponse(allocator, initialize_id);
        session.supports_pull_diagnostics = initializeSupportsPullDiagnostics(allocator, initialize_response);
        allocator.free(initialize_response);
        try sendNotification(allocator, writer, "initialized", "{}");
        session.running = true;

        return session;
    }

    fn deinit(self: *Session, allocator: std.mem.Allocator, io: std.Io) void {
        if (self.child.id != null) {
            var write_buffer: [1024]u8 = undefined;
            if (self.child.stdin) |stdin| {
                var stdin_writer = stdin.writer(io, &write_buffer);
                const writer = &stdin_writer.interface;
                const shutdown_id = self.nextId();
                sendShutdown(allocator, writer, shutdown_id) catch {};
                if (self.readUntilResponse(allocator, shutdown_id)) |response| allocator.free(response) else |_| {}
                sendNotification(allocator, writer, "exit", "{}") catch {};
            }
            self.child.kill(io);
        }
        var iterator = self.documents.iterator();
        while (iterator.next()) |entry| allocator.free(entry.key_ptr.*);
        self.documents.deinit();
        var diagnostics_iterator = self.diagnostics.iterator();
        while (diagnostics_iterator.next()) |entry| {
            allocator.free(entry.key_ptr.*);
            freeDiagnostics(allocator, entry.value_ptr.*);
        }
        self.diagnostics.deinit();
        self.stream.deinit();
        if (self.last_error) |value| allocator.free(value);
        allocator.free(self.repo_root);
        allocator.free(self.language);
        allocator.free(self.server_id);
    }

    fn setLastError(self: *Session, allocator: std.mem.Allocator, err: anyerror) !void {
        if (self.last_error) |value| allocator.free(value);
        self.last_error = try std.fmt.allocPrint(allocator, "{s}", .{@errorName(err)});
    }

    fn info(self: Session, allocator: std.mem.Allocator) !SessionInfo {
        return .{
            .running = self.running and self.child.id != null,
            .last_error = if (self.last_error) |value| try allocator.dupe(u8, value) else null,
        };
    }

    fn hover(self: *Session, allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, path: []const u8, source: []const u8, line: u32, column: u32, language: []const u8) ![]u8 {
        var write_buffer: [8192]u8 = undefined;
        var stdin_writer = self.child.stdin.?.writer(io, &write_buffer);
        const writer = &stdin_writer.interface;
        const uri = try fileUri(allocator, repo_root, path);
        defer allocator.free(uri);

        try self.syncDocument(allocator, writer, uri, language, source);
        const hover_id = self.nextId();
        try sendHover(allocator, writer, uri, line, column, hover_id);
        const hover_response = try self.readUntilResponse(allocator, hover_id);
        defer allocator.free(hover_response);
        return parseHoverContents(allocator, hover_response);
    }

    fn collectDiagnostics(self: *Session, allocator: std.mem.Allocator, io: std.Io, repo_root: []const u8, path: []const u8, source: []const u8, language: []const u8) ![]Diagnostic {
        var write_buffer: [8192]u8 = undefined;
        var stdin_writer = self.child.stdin.?.writer(io, &write_buffer);
        const writer = &stdin_writer.interface;
        const uri = try fileUri(allocator, repo_root, path);
        defer allocator.free(uri);

        self.drainNotifications(allocator, 0) catch {};
        try self.syncDocument(allocator, writer, uri, language, source);
        if (self.supports_pull_diagnostics) {
            const diagnostics_id = self.nextId();
            try sendDocumentDiagnostic(allocator, writer, uri, diagnostics_id);
            const diagnostics_response = self.readUntilResponse(allocator, diagnostics_id) catch |err| switch (err) {
                error.LspResponseNotFound => null,
                else => return err,
            };
            if (diagnostics_response) |response| {
                defer allocator.free(response);
                const pulled_diagnostics = try parseDocumentDiagnostics(allocator, response);
                if (pulled_diagnostics) |items| return items;
            }
        }

        try sendDidSave(allocator, writer, uri);
        self.drainNotifications(allocator, 1000) catch {};
        if (self.diagnostics.get(uri)) |items| return dupeDiagnostics(allocator, items);
        return try allocator.alloc(Diagnostic, 0);
    }

    fn readUntilResponse(self: *Session, allocator: std.mem.Allocator, id: i64) ![]u8 {
        var messages_read: usize = 0;
        while (messages_read < 128) : (messages_read += 1) {
            const body = try self.stream.readMessageTimeout(5000);
            errdefer allocator.free(body);
            if (messageHasId(body, id)) return body;
            try self.handleNotification(allocator, body);
            allocator.free(body);
        }
        return error.LspResponseNotFound;
    }

    fn drainNotifications(self: *Session, allocator: std.mem.Allocator, timeout_ms: i32) !void {
        var messages_read: usize = 0;
        while (messages_read < 64) : (messages_read += 1) {
            const body = self.stream.readMessageTimeout(timeout_ms) catch |err| switch (err) {
                error.Timeout => return,
                else => return err,
            };
            defer allocator.free(body);
            try self.handleNotification(allocator, body);
        }
    }

    fn handleNotification(self: *Session, allocator: std.mem.Allocator, body: []const u8) !void {
        const parsed = std.json.parseFromSlice(std.json.Value, allocator, body, .{}) catch return;
        defer parsed.deinit();
        const root = switch (parsed.value) { .object => |object| object, else => return };
        const method_value = root.get("method") orelse return;
        const method = switch (method_value) { .string => |text| text, else => return };
        if (!std.mem.eql(u8, method, "textDocument/publishDiagnostics")) return;
        const params_value = root.get("params") orelse return;
        const params = switch (params_value) { .object => |object| object, else => return };
        const uri_value = params.get("uri") orelse return;
        const uri = switch (uri_value) { .string => |text| text, else => return };
        const diagnostics_value = params.get("diagnostics") orelse return;
        const diagnostics_array = switch (diagnostics_value) { .array => |array| array, else => return };
        const parsed_diagnostics = try parseDiagnostics(allocator, diagnostics_array.items);
        errdefer freeDiagnostics(allocator, parsed_diagnostics);
        const owned_uri = try allocator.dupe(u8, uri);
        errdefer allocator.free(owned_uri);
        if (self.diagnostics.fetchRemove(uri)) |entry| {
            allocator.free(entry.key);
            freeDiagnostics(allocator, entry.value);
        }
        try self.diagnostics.put(owned_uri, parsed_diagnostics);
    }

    fn syncDocument(self: *Session, allocator: std.mem.Allocator, writer: *std.Io.Writer, uri: []const u8, language: []const u8, source: []const u8) !void {
        const hash = std.hash.Wyhash.hash(0, source);
        if (self.documents.getPtr(uri)) |state| {
            if (state.hash == hash) return;
            state.version += 1;
            state.hash = hash;
            self.clearDiagnostics(allocator, uri);
            try sendDidChange(allocator, writer, uri, state.version, source);
            return;
        }

        const owned_uri = try allocator.dupe(u8, uri);
        errdefer allocator.free(owned_uri);
        self.clearDiagnostics(allocator, uri);
        try sendDidOpen(allocator, writer, uri, language, source);
        try self.documents.put(owned_uri, .{ .hash = hash, .version = 1 });
    }

    fn clearDiagnostics(self: *Session, allocator: std.mem.Allocator, uri: []const u8) void {
        if (self.diagnostics.fetchRemove(uri)) |entry| {
            allocator.free(entry.key);
            freeDiagnostics(allocator, entry.value);
        }
    }

    fn nextId(self: *Session) i64 {
        const id = self.next_id;
        self.next_id += 1;
        return id;
    }
};

pub fn detectLanguage(path: []const u8) ?[]const u8 {
    const name = std.fs.path.basename(path);
    if (std.mem.eql(u8, name, "Dockerfile")) return "dockerfile";
    const ext = std.fs.path.extension(path);
    if (std.mem.eql(u8, ext, ".ts")) return "typescript";
    if (std.mem.eql(u8, ext, ".tsx")) return "typescript";
    if (std.mem.eql(u8, ext, ".js")) return "javascript";
    if (std.mem.eql(u8, ext, ".jsx")) return "javascript";
    if (std.mem.eql(u8, ext, ".mjs")) return "javascript";
    if (std.mem.eql(u8, ext, ".cjs")) return "javascript";
    if (std.mem.eql(u8, ext, ".rs")) return "rust";
    if (std.mem.eql(u8, ext, ".py")) return "python";
    if (std.mem.eql(u8, ext, ".go")) return "go";
    if (std.mem.eql(u8, ext, ".zig")) return "zig";
    if (std.mem.eql(u8, ext, ".lua")) return "lua";
    return null;
}

pub fn statusForPath(manager: *Manager, allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map, repo_root: []const u8, path: []const u8) !Status {
    const language = detectLanguage(path) orelse return .{ .message = try allocator.dupe(u8, "No language detected for this file") };
    var config = try resolveConfig(allocator, io, environ_map, language);
    defer if (config) |*value| value.deinit(allocator);
    if (config == null) return .{
        .language = try allocator.dupe(u8, language),
        .message = try allocator.dupe(u8, "No LSP server configured for this language"),
    };

    const cfg = config.?;
    const installed = commandExists(allocator, io, environ_map, cfg.command);
    const session_info = try manager.sessionInfo(allocator, repo_root, language, cfg.id);
    return .{
        .language = try allocator.dupe(u8, language),
        .serverId = try allocator.dupe(u8, cfg.id),
        .command = try allocator.dupe(u8, cfg.command),
        .configured = true,
        .installed = installed,
        .starting = session_info.starting,
        .running = session_info.running,
        .configSource = try allocator.dupe(u8, cfg.source),
        .lastError = session_info.last_error,
        .message = try allocator.dupe(u8, if (installed) "LSP server ready" else "LSP server command was not found on PATH"),
    };
}

pub fn freeStatus(allocator: std.mem.Allocator, status: Status) void {
    if (status.language) |value| allocator.free(value);
    if (status.serverId) |value| allocator.free(value);
    if (status.command) |value| allocator.free(value);
    if (status.configSource) |value| allocator.free(value);
    if (status.lastError) |value| allocator.free(value);
    if (status.message) |value| allocator.free(value);
}

pub fn configInfo(manager: *Manager, allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map) !ConfigInfo {
    const languages = [_][]const u8{ "typescript", "javascript", "rust", "python", "go", "zig", "lua" };
    var servers: std.ArrayList(ServerInfo) = .empty;
    errdefer {
        for (servers.items) |*server| server.deinit(allocator);
        servers.deinit(allocator);
    }

    for (languages) |language| {
        var config = try resolveConfig(allocator, io, environ_map, language);
        defer if (config) |*value| value.deinit(allocator);
        const cfg = config orelse continue;
        const session_info = try manager.anySessionInfo(allocator, cfg.language, cfg.id);
        try servers.append(allocator, .{
            .language = try allocator.dupe(u8, cfg.language),
            .server_id = try allocator.dupe(u8, cfg.id),
            .command = try allocator.dupe(u8, cfg.command),
            .args = try dupeStringArray(allocator, cfg.args),
            .config_source = try allocator.dupe(u8, cfg.source),
            .installed = commandExists(allocator, io, environ_map, cfg.command),
            .starting = session_info.starting,
            .running = session_info.running,
            .last_error = session_info.last_error,
            .install_info = try installInfoForServer(allocator, cfg.id, cfg.command),
        });
    }

    return .{
        .config_path = try userConfigPath(allocator, environ_map),
        .servers = try servers.toOwnedSlice(allocator),
    };
}

pub fn installInfo(allocator: std.mem.Allocator, server_id: []const u8, command: []const u8) !InstallInfo {
    return (try installInfoForServer(allocator, server_id, command)).?;
}

pub fn installServer(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
    server_id: []const u8,
    server_command: []const u8,
    progress: anytype,
) !InstallResult {
    var info = try installInfo(allocator, server_id, server_command);
    defer info.deinit(allocator);

    if (!info.safe_to_run) return .{
        .serverId = try allocator.dupe(u8, server_id),
        .command = try allocator.dupe(u8, server_command),
        .installed = commandExists(allocator, io, environ_map, server_command),
        .message = try allocator.dupe(u8, "This language server install is copy-only for now."),
    };

    if (!commandExists(allocator, io, environ_map, info.command)) return .{
        .serverId = try allocator.dupe(u8, server_id),
        .command = try allocator.dupe(u8, server_command),
        .installed = false,
        .message = try std.fmt.allocPrint(allocator, "Installer command not found: {s}", .{info.command}),
    };

    try progress.emit("Starting install");
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.append(allocator, info.command);
    for (info.args) |arg| try argv.append(allocator, arg);

    try progress.emit("Running installer");
    var child = try std.process.spawn(io, .{
        .argv = argv.items,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });
    const term = try child.wait(io);
    const success = switch (term) {
        .exited => |code| code == 0,
        else => false,
    };

    if (!success) return .{
        .serverId = try allocator.dupe(u8, server_id),
        .command = try allocator.dupe(u8, server_command),
        .installed = commandExists(allocator, io, environ_map, server_command),
        .message = try allocator.dupe(u8, "Installer exited unsuccessfully."),
    };

    try progress.emit("Verifying command");
    const installed = commandExists(allocator, io, environ_map, server_command);
    return .{
        .serverId = try allocator.dupe(u8, server_id),
        .command = try allocator.dupe(u8, server_command),
        .installed = installed,
        .message = if (installed) try allocator.dupe(u8, "Language server installed.") else try allocator.dupe(u8, "Installer finished, but the language server command was not found on PATH."),
    };
}

pub fn hover(
    manager: *Manager,
    allocator: std.mem.Allocator,
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
    repo_root: []const u8,
    path: []const u8,
    source: []const u8,
    line: u32,
    column: u32,
) !HoverResult {
    const language = detectLanguage(path) orelse return .{ .status = "language-unknown", .message = try allocator.dupe(u8, "No language detected for this file") };
    var config = try resolveConfig(allocator, io, environ_map, language);
    defer if (config) |*value| value.deinit(allocator);
    if (config == null) return .{
        .status = "server-not-configured",
        .language = try allocator.dupe(u8, language),
        .message = try allocator.dupe(u8, "No LSP server configured for this language"),
    };

    const cfg = config.?;
    if (!commandExists(allocator, io, environ_map, cfg.command)) {
        return .{
            .status = "server-not-installed",
            .language = try allocator.dupe(u8, language),
            .serverId = try allocator.dupe(u8, cfg.id),
            .message = try allocator.dupe(u8, "LSP server command was not found on PATH"),
        };
    }

    const contents = manager.hover(io, repo_root, path, source, line, column, cfg) catch |err| {
        const message = try std.fmt.allocPrint(allocator, "LSP hover request failed: {s}", .{@errorName(err)});
        return .{
            .status = "request-failed",
            .language = try allocator.dupe(u8, language),
            .serverId = try allocator.dupe(u8, cfg.id),
            .message = message,
        };
    };
    if (contents.len == 0) {
        allocator.free(contents);
        return .{
            .status = "hover-unavailable",
            .language = try allocator.dupe(u8, language),
            .serverId = try allocator.dupe(u8, cfg.id),
            .message = try allocator.dupe(u8, "No hover information available"),
        };
    }
    return .{
        .status = "ok",
        .language = try allocator.dupe(u8, language),
        .serverId = try allocator.dupe(u8, cfg.id),
        .contents = contents,
    };
}

pub fn freeHoverResult(allocator: std.mem.Allocator, result: HoverResult) void {
    if (result.language) |value| allocator.free(value);
    if (result.serverId) |value| allocator.free(value);
    if (result.contents) |value| allocator.free(value);
    if (result.message) |value| allocator.free(value);
}

pub fn diagnostics(
    manager: *Manager,
    allocator: std.mem.Allocator,
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
    repo_root: []const u8,
    path: []const u8,
    source: []const u8,
) !DiagnosticsResult {
    const language = detectLanguage(path) orelse return .{ .status = "language-unknown", .message = try allocator.dupe(u8, "No language detected for this file") };
    var config = try resolveConfig(allocator, io, environ_map, language);
    defer if (config) |*value| value.deinit(allocator);
    if (config == null) return .{
        .status = "server-not-configured",
        .language = try allocator.dupe(u8, language),
        .message = try allocator.dupe(u8, "No LSP server configured for this language"),
    };

    const cfg = config.?;
    if (!commandExists(allocator, io, environ_map, cfg.command)) {
        return .{
            .status = "server-not-installed",
            .language = try allocator.dupe(u8, language),
            .serverId = try allocator.dupe(u8, cfg.id),
            .message = try allocator.dupe(u8, "LSP server command was not found on PATH"),
        };
    }

    const items = manager.diagnostics(io, repo_root, path, source, cfg) catch |err| {
        const message = try std.fmt.allocPrint(allocator, "LSP diagnostics request failed: {s}", .{@errorName(err)});
        return .{
            .status = "request-failed",
            .language = try allocator.dupe(u8, language),
            .serverId = try allocator.dupe(u8, cfg.id),
            .message = message,
        };
    };
    return .{
        .status = "ok",
        .language = try allocator.dupe(u8, language),
        .serverId = try allocator.dupe(u8, cfg.id),
        .diagnostics = items,
    };
}

pub fn freeDiagnosticsResult(allocator: std.mem.Allocator, result: DiagnosticsResult) void {
    if (result.language) |value| allocator.free(value);
    if (result.serverId) |value| allocator.free(value);
    freeDiagnostics(allocator, result.diagnostics);
    if (result.message) |value| allocator.free(value);
}

fn sendInitialize(allocator: std.mem.Allocator, writer: *std.Io.Writer, repo_root: []const u8, id: i64) !void {
    const root_uri = try dirUri(allocator, repo_root);
    defer allocator.free(root_uri);
    const body = try std.fmt.allocPrint(allocator,
        "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"method\":\"initialize\",\"params\":{{\"processId\":null,\"rootUri\":\"{s}\",\"workspaceFolders\":[{{\"uri\":\"{s}\",\"name\":\"diffuse\"}}],\"capabilities\":{{\"textDocument\":{{\"synchronization\":{{\"didSave\":true}},\"publishDiagnostics\":{{}},\"hover\":{{\"contentFormat\":[\"markdown\",\"plaintext\"]}},\"diagnostic\":{{\"dynamicRegistration\":false}}}}}},\"initializationOptions\":{{}},\"trace\":\"off\",\"clientInfo\":{{\"name\":\"diffuse\",\"version\":\"0.1.0\"}}}}}}",
        .{ id, root_uri, root_uri });
    defer allocator.free(body);
    try sendMessage(writer, body);
}

fn sendDidOpen(allocator: std.mem.Allocator, writer: *std.Io.Writer, uri: []const u8, language: []const u8, source: []const u8) !void {
    const escaped_source = try jsonString(allocator, source);
    defer allocator.free(escaped_source);
    const body = try std.fmt.allocPrint(allocator,
        "{{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/didOpen\",\"params\":{{\"textDocument\":{{\"uri\":\"{s}\",\"languageId\":\"{s}\",\"version\":1,\"text\":{s}}}}}}}",
        .{ uri, language, escaped_source });
    defer allocator.free(body);
    try sendMessage(writer, body);
}

fn sendDidChange(allocator: std.mem.Allocator, writer: *std.Io.Writer, uri: []const u8, version: u32, source: []const u8) !void {
    const escaped_uri = try jsonString(allocator, uri);
    defer allocator.free(escaped_uri);
    const escaped_source = try jsonString(allocator, source);
    defer allocator.free(escaped_source);
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    try out.writer.print("{{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/didChange\",\"params\":{{\"textDocument\":{{\"uri\":{s},\"version\":{d}}},\"contentChanges\":[{{\"text\":{s}}}]}}}}", .{ escaped_uri, version, escaped_source });
    const body = try out.toOwnedSlice();
    defer allocator.free(body);
    try sendMessage(writer, body);
}

fn sendDidSave(allocator: std.mem.Allocator, writer: *std.Io.Writer, uri: []const u8) !void {
    const body = try std.fmt.allocPrint(allocator,
        "{{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/didSave\",\"params\":{{\"textDocument\":{{\"uri\":\"{s}\"}}}}}}",
        .{uri});
    defer allocator.free(body);
    try sendMessage(writer, body);
}

fn sendHover(allocator: std.mem.Allocator, writer: *std.Io.Writer, uri: []const u8, line: u32, column: u32, id: i64) !void {
    const lsp_line = if (line > 0) line - 1 else 0;
    const body = try std.fmt.allocPrint(allocator,
        "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"method\":\"textDocument/hover\",\"params\":{{\"textDocument\":{{\"uri\":\"{s}\"}},\"position\":{{\"line\":{d},\"character\":{d}}}}}}}",
        .{ id, uri, lsp_line, column });
    defer allocator.free(body);
    try sendMessage(writer, body);
}

fn sendDocumentDiagnostic(allocator: std.mem.Allocator, writer: *std.Io.Writer, uri: []const u8, id: i64) !void {
    const body = try std.fmt.allocPrint(allocator,
        "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"method\":\"textDocument/diagnostic\",\"params\":{{\"textDocument\":{{\"uri\":\"{s}\"}}}}}}",
        .{ id, uri });
    defer allocator.free(body);
    try sendMessage(writer, body);
}

fn sendShutdown(allocator: std.mem.Allocator, writer: *std.Io.Writer, id: i64) !void {
    const body = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"method\":\"shutdown\",\"params\":null}}", .{id});
    defer allocator.free(body);
    try sendMessage(writer, body);
}

fn sendNotification(allocator: std.mem.Allocator, writer: *std.Io.Writer, method: []const u8, params: []const u8) !void {
    const body = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"method\":\"{s}\",\"params\":{s}}}", .{ method, params });
    defer allocator.free(body);
    try sendMessage(writer, body);
}

fn sendMessage(writer: *std.Io.Writer, body: []const u8) !void {
    try writer.print("Content-Length: {d}\r\n\r\n", .{body.len});
    try writer.writeAll(body);
    try writer.flush();
}

const LspStream = struct {
    allocator: std.mem.Allocator,
    fd: std.posix.fd_t,
    buffer: std.ArrayList(u8),

    const timeout_ms = 5000;

    fn init(allocator: std.mem.Allocator, fd: std.posix.fd_t) LspStream {
        return .{ .allocator = allocator, .fd = fd, .buffer = .empty };
    }

    fn deinit(self: *LspStream) void {
        self.buffer.deinit(self.allocator);
    }

    fn readUntilResponse(self: *LspStream, id: i64) ![]u8 {
        var messages_read: usize = 0;
        while (messages_read < 128) : (messages_read += 1) {
            const body = try self.readMessageTimeout(timeout_ms);
            errdefer self.allocator.free(body);
            if (messageHasId(body, id)) return body;
            self.allocator.free(body);
        }
        return error.LspResponseNotFound;
    }

    fn readMessageTimeout(self: *LspStream, timeout: i32) ![]u8 {
        while (true) {
            while (headerEnd(self.buffer.items) == null) try self.fill(timeout);
            const header_end = headerEnd(self.buffer.items).?;
            const header = self.buffer.items[0..header_end];
            const content_length = parseContentLength(header) orelse {
                try self.consume(header_end + 4);
                continue;
            };
            if (content_length == 0 or content_length > 20 * 1024 * 1024) return error.InvalidLspMessage;
            const message_end = header_end + 4 + content_length;
            while (self.buffer.items.len < message_end) try self.fill(timeout);
            const body = try self.allocator.dupe(u8, self.buffer.items[header_end + 4 .. message_end]);
            try self.consume(message_end);
            return body;
        }
    }

    fn fill(self: *LspStream, timeout: i32) !void {
        var fds = [_]std.posix.pollfd{.{ .fd = self.fd, .events = std.posix.POLL.IN, .revents = 0 }};
        const ready = try std.posix.poll(&fds, timeout);
        if (ready == 0) return error.Timeout;
        if ((fds[0].revents & (std.posix.POLL.ERR | std.posix.POLL.HUP | std.posix.POLL.NVAL)) != 0) return error.EndOfStream;
        var chunk: [8192]u8 = undefined;
        const read_count = try std.posix.read(self.fd, &chunk);
        if (read_count == 0) return error.EndOfStream;
        try self.buffer.appendSlice(self.allocator, chunk[0..read_count]);
    }

    fn consume(self: *LspStream, len: usize) !void {
        if (len >= self.buffer.items.len) {
            self.buffer.clearRetainingCapacity();
            return;
        }
        std.mem.copyForwards(u8, self.buffer.items[0 .. self.buffer.items.len - len], self.buffer.items[len..]);
        self.buffer.shrinkRetainingCapacity(self.buffer.items.len - len);
    }
};

fn headerEnd(buffer: []const u8) ?usize {
    return std.mem.indexOf(u8, buffer, "\r\n\r\n") orelse std.mem.indexOf(u8, buffer, "\n\n");
}

fn parseContentLength(header: []const u8) ?usize {
    var lines = std.mem.splitScalar(u8, header, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, "\r \t");
        if (!std.ascii.startsWithIgnoreCase(trimmed, "Content-Length:")) continue;
        const value = std.mem.trim(u8, trimmed["Content-Length:".len..], " \t");
        return std.fmt.parseInt(usize, value, 10) catch null;
    }
    return null;
}

fn messageHasId(body: []const u8, expected: i64) bool {
    const parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, body, .{}) catch return false;
    defer parsed.deinit();
    const object = switch (parsed.value) { .object => |object| object, else => return false };
    const value = object.get("id") orelse return false;
    return switch (value) { .integer => |id| id == expected, else => false };
}

fn initializeSupportsPullDiagnostics(allocator: std.mem.Allocator, body: []const u8) bool {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, body, .{}) catch return false;
    defer parsed.deinit();
    const root = switch (parsed.value) { .object => |object| object, else => return false };
    const result = switch (root.get("result") orelse return false) { .object => |object| object, else => return false };
    const capabilities = switch (result.get("capabilities") orelse return false) { .object => |object| object, else => return false };
    return capabilities.get("diagnosticProvider") != null;
}

fn parseHoverContents(allocator: std.mem.Allocator, body: []const u8) ![]u8 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
    defer parsed.deinit();
    const root = switch (parsed.value) { .object => |object| object, else => return allocator.dupe(u8, "") };
    const result = root.get("result") orelse return allocator.dupe(u8, "");
    if (result == .null) return allocator.dupe(u8, "");
    const result_object = switch (result) { .object => |object| object, else => return allocator.dupe(u8, "") };
    const contents = result_object.get("contents") orelse return allocator.dupe(u8, "");
    return hoverContentsValue(allocator, contents);
}

fn parseDocumentDiagnostics(allocator: std.mem.Allocator, body: []const u8) !?[]Diagnostic {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
    defer parsed.deinit();
    const root = switch (parsed.value) { .object => |object| object, else => return null };
    if (root.get("error") != null) return null;
    const result = root.get("result") orelse return null;
    if (result == .null) return null;
    const result_object = switch (result) { .object => |object| object, else => return null };
    const items_value = result_object.get("items") orelse return null;
    const items = switch (items_value) { .array => |array| array, else => return null };
    return try parseDiagnostics(allocator, items.items);
}

fn hoverContentsValue(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    return switch (value) {
        .string => |text| allocator.dupe(u8, text),
        .object => |object| blk: {
            if (object.get("value")) |field| break :blk hoverContentsValue(allocator, field);
            break :blk allocator.dupe(u8, "");
        },
        .array => |array| blk: {
            var out: std.ArrayList(u8) = .empty;
            defer out.deinit(allocator);
            for (array.items, 0..) |item, index| {
                const part = try hoverContentsValue(allocator, item);
                defer allocator.free(part);
                if (part.len == 0) continue;
                if (index > 0 and out.items.len > 0) try out.appendSlice(allocator, "\n\n");
                try out.appendSlice(allocator, part);
            }
            break :blk try out.toOwnedSlice(allocator);
        },
        else => allocator.dupe(u8, ""),
    };
}

fn parseDiagnostics(allocator: std.mem.Allocator, values: []std.json.Value) ![]Diagnostic {
    var result: std.ArrayList(Diagnostic) = .empty;
    errdefer {
        for (result.items) |item| item.deinit(allocator);
        result.deinit(allocator);
    }
    for (values) |value| {
        const object = switch (value) { .object => |object| object, else => continue };
        const range_value = object.get("range") orelse continue;
        const range = switch (range_value) { .object => |range| range, else => continue };
        const start_value = range.get("start") orelse continue;
        const start = switch (start_value) { .object => |start| start, else => continue };
        const end_value = range.get("end") orelse start_value;
        const end = switch (end_value) { .object => |end| end, else => start };
        const line = jsonU32(start.get("line") orelse continue) + 1;
        const start_column = jsonU32(start.get("character") orelse continue);
        const end_column = jsonU32(end.get("character") orelse start.get("character").?);
        const severity = severityName(jsonU32(object.get("severity") orelse .{ .integer = 3 }));
        const message_value = object.get("message") orelse continue;
        const message = switch (message_value) { .string => |message| message, else => continue };
        const source = if (object.get("source")) |source_value| switch (source_value) { .string => |source_text| try allocator.dupe(u8, source_text), else => null } else null;
        errdefer if (source) |source_text| allocator.free(source_text);
        const code = if (object.get("code")) |code_value| try diagnosticCode(allocator, code_value) else null;
        errdefer if (code) |code_text| allocator.free(code_text);
        try result.append(allocator, .{
            .line = line,
            .startColumn = start_column,
            .endColumn = end_column,
            .severity = try allocator.dupe(u8, severity),
            .message = try allocator.dupe(u8, message),
            .source = source,
            .code = code,
        });
    }
    return try result.toOwnedSlice(allocator);
}

fn dupeDiagnostics(allocator: std.mem.Allocator, values: []const Diagnostic) ![]Diagnostic {
    var result = try allocator.alloc(Diagnostic, values.len);
    errdefer allocator.free(result);
    for (values, 0..) |value, index| {
        result[index] = .{
            .line = value.line,
            .startColumn = value.startColumn,
            .endColumn = value.endColumn,
            .severity = try allocator.dupe(u8, value.severity),
            .message = try allocator.dupe(u8, value.message),
            .source = if (value.source) |source| try allocator.dupe(u8, source) else null,
            .code = if (value.code) |code| try allocator.dupe(u8, code) else null,
        };
    }
    return result;
}

fn freeDiagnostics(allocator: std.mem.Allocator, values: []const Diagnostic) void {
    for (values) |value| value.deinit(allocator);
    allocator.free(values);
}

fn jsonU32(value: std.json.Value) u32 {
    return switch (value) {
        .integer => |integer| if (integer < 0) 0 else @intCast(integer),
        .float => |float| if (float < 0) 0 else @intFromFloat(float),
        else => 0,
    };
}

fn diagnosticCode(allocator: std.mem.Allocator, value: std.json.Value) !?[]const u8 {
    return switch (value) {
        .string => |text| try allocator.dupe(u8, text),
        .integer => |integer| try std.fmt.allocPrint(allocator, "{d}", .{integer}),
        .float => |float| try std.fmt.allocPrint(allocator, "{d}", .{@as(i64, @intFromFloat(float))}),
        .object => |object| blk: {
            const nested = object.get("value") orelse break :blk null;
            break :blk try diagnosticCode(allocator, nested);
        },
        else => null,
    };
}

fn severityName(severity: u32) []const u8 {
    return switch (severity) {
        1 => "error",
        2 => "warning",
        4 => "hint",
        else => "info",
    };
}

fn resolveConfig(allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map, language: []const u8) !?Config {
    if (try readUserConfig(allocator, io, environ_map, language)) |config| return config;
    return builtinConfig(allocator, language);
}

fn readUserConfig(allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map, language: []const u8) !?Config {
    const path = try userConfigPath(allocator, environ_map) orelse return null;
    defer allocator.free(path);
    const bytes = std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(1024 * 1024)) catch return null;
    defer allocator.free(bytes);
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, bytes, .{}) catch return null;
    defer parsed.deinit();
    const root = switch (parsed.value) { .object => |object| object, else => return null };
    const lsp_value = root.get("lsp") orelse return null;
    const lsp_object = switch (lsp_value) { .object => |object| object, else => return null };
    const server_value = lsp_object.get(language) orelse return null;
    const server_object = switch (server_value) { .object => |object| object, else => return null };
    const command_value = server_object.get("command") orelse return null;
    const command = switch (command_value) { .string => |text| text, else => return null };
    return .{
        .id = try allocator.dupe(u8, language),
        .language = try allocator.dupe(u8, language),
        .command = try allocator.dupe(u8, command),
        .args = try readStringArray(allocator, server_object.get("args")),
        .source = try allocator.dupe(u8, "user"),
    };
}

fn userConfigPath(allocator: std.mem.Allocator, environ_map: *const std.process.Environ.Map) !?[]u8 {
    const home = environ_map.get("HOME") orelse return null;
    return try std.fs.path.join(allocator, &.{ home, ".diffuse", "lsp.json" });
}

fn dupeStringArray(allocator: std.mem.Allocator, values: []const []const u8) ![]const []const u8 {
    var result = try allocator.alloc([]const u8, values.len);
    errdefer allocator.free(result);
    for (values, 0..) |value, index| result[index] = try allocator.dupe(u8, value);
    return result;
}

fn installInfoForServer(allocator: std.mem.Allocator, server_id: []const u8, command: []const u8) !?InstallInfo {
    const Template = struct {
        server_id: []const u8,
        manager: []const u8,
        command: []const u8,
        args: []const []const u8,
        description: []const u8,
        requires_shell: bool = false,
        safe_to_run: bool = false,
        note: ?[]const u8 = null,
    };
    const templates = [_]Template{
        .{
            .server_id = "typescript-language-server",
            .manager = "npm",
            .command = "npm",
            .args = &.{ "install", "-g", "typescript", "typescript-language-server" },
            .description = "Install the TypeScript language server from npm.",
            .note = "Mason package: typescript-language-server. npm installs remain copy-only in Diffuse for now.",
        },
        .{
            .server_id = "rust-analyzer",
            .manager = "rustup",
            .command = "rustup",
            .args = &.{ "component", "add", "rust-analyzer" },
            .description = "Install rust-analyzer with rustup.",
            .note = "Mason package: rust-analyzer.",
            .safe_to_run = true,
        },
        .{
            .server_id = "gopls",
            .manager = "go",
            .command = "go",
            .args = &.{ "install", "golang.org/x/tools/gopls@latest" },
            .description = "Install the Go language server with go install.",
            .note = "Mason package: gopls.",
            .safe_to_run = true,
        },
        .{
            .server_id = "pyright",
            .manager = "npm",
            .command = "npm",
            .args = &.{ "install", "-g", "pyright" },
            .description = "Install Pyright from npm.",
            .note = "Mason package: pyright. npm installs remain copy-only in Diffuse for now.",
        },
        .{
            .server_id = "zig",
            .manager = "manual",
            .command = "zls",
            .args = &.{"--version"},
            .description = "Install ZLS, then point ~/.diffuse/lsp.json at the zls executable if it is not on PATH.",
            .note = "Mason package: zls. If you use Mason, the command is usually ~/.local/share/nvim/mason/bin/zls.",
        },
        .{
            .server_id = "zls",
            .manager = "manual",
            .command = "zls",
            .args = &.{"--version"},
            .description = "Install ZLS, then point ~/.diffuse/lsp.json at the zls executable if it is not on PATH.",
            .note = "Mason package: zls. If you use Mason, the command is usually ~/.local/share/nvim/mason/bin/zls.",
        },
        .{
            .server_id = "lua-language-server",
            .manager = "manual",
            .command = "lua-language-server",
            .args = &.{"--version"},
            .description = "Install Lua Language Server from your package manager or Mason.",
            .note = "Mason package: lua-language-server. If the binary is not on PATH, add its full path to ~/.diffuse/lsp.json.",
        },
    };

    for (templates) |template| {
        if (!std.mem.eql(u8, template.server_id, server_id)) continue;
        return .{
            .manager = try allocator.dupe(u8, template.manager),
            .command = try allocator.dupe(u8, template.command),
            .args = try dupeStringArray(allocator, template.args),
            .description = try allocator.dupe(u8, template.description),
            .requires_shell = template.requires_shell,
            .safe_to_run = template.safe_to_run,
            .note = if (template.note) |value| try allocator.dupe(u8, value) else null,
        };
    }

    return .{
        .manager = try allocator.dupe(u8, "manual"),
        .command = try allocator.dupe(u8, command),
        .args = try dupeStringArray(allocator, &.{"--version"}),
        .description = try std.fmt.allocPrint(allocator, "Install {s}, then refresh this list.", .{server_id}),
        .note = try allocator.dupe(u8, "If the command is not on PATH, add its full path to ~/.diffuse/lsp.json."),
    };
}

fn readStringArray(allocator: std.mem.Allocator, value: ?std.json.Value) ![]const []const u8 {
    const array_value = value orelse return try allocator.alloc([]const u8, 0);
    const array = switch (array_value) { .array => |array| array, else => return try allocator.alloc([]const u8, 0) };
    var result: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (result.items) |item| allocator.free(item);
        result.deinit(allocator);
    }
    for (array.items) |item| {
        const text = switch (item) { .string => |text| text, else => continue };
        try result.append(allocator, try allocator.dupe(u8, text));
    }
    return try result.toOwnedSlice(allocator);
}

fn builtinConfig(allocator: std.mem.Allocator, language: []const u8) !?Config {
    const Builtin = struct { language: []const u8, id: []const u8, command: []const u8, args: []const []const u8 };
    const builtins = [_]Builtin{
        .{ .language = "typescript", .id = "typescript-language-server", .command = "typescript-language-server", .args = &.{"--stdio"} },
        .{ .language = "javascript", .id = "typescript-language-server", .command = "typescript-language-server", .args = &.{"--stdio"} },
        .{ .language = "rust", .id = "rust-analyzer", .command = "rust-analyzer", .args = &.{} },
        .{ .language = "python", .id = "pyright", .command = "pyright-langserver", .args = &.{"--stdio"} },
        .{ .language = "go", .id = "gopls", .command = "gopls", .args = &.{} },
        .{ .language = "zig", .id = "zls", .command = "zls", .args = &.{} },
        .{ .language = "lua", .id = "lua-language-server", .command = "lua-language-server", .args = &.{} },
    };
    for (builtins) |builtin| {
        if (!std.mem.eql(u8, builtin.language, language)) continue;
        var args = try allocator.alloc([]const u8, builtin.args.len);
        errdefer allocator.free(args);
        for (builtin.args, 0..) |arg, index| args[index] = try allocator.dupe(u8, arg);
        return .{
            .id = try allocator.dupe(u8, builtin.id),
            .language = try allocator.dupe(u8, builtin.language),
            .command = try allocator.dupe(u8, builtin.command),
            .args = args,
            .source = try allocator.dupe(u8, "builtin"),
        };
    }
    return null;
}

fn commandExists(allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map, command: []const u8) bool {
    if (std.mem.indexOfScalar(u8, command, '/') != null) {
        return pathExists(io, command);
    }
    const path_value = environ_map.get("PATH") orelse return false;
    var paths = std.mem.splitScalar(u8, path_value, ':');
    while (paths.next()) |dir| {
        if (dir.len == 0) continue;
        const full_path = std.fs.path.join(allocator, &.{ dir, command }) catch continue;
        defer allocator.free(full_path);
        if (!pathExists(io, full_path)) continue;
        return true;
    }
    return false;
}

fn pathExists(io: std.Io, path: []const u8) bool {
    var file = std.Io.Dir.openFile(.cwd(), io, path, .{}) catch return false;
    file.close(io);
    return true;
}

fn fileUri(allocator: std.mem.Allocator, repo_root: []const u8, path: []const u8) ![]u8 {
    const full_path = try std.fs.path.join(allocator, &.{ repo_root, path });
    defer allocator.free(full_path);
    return pathUri(allocator, full_path);
}

fn dirUri(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    return pathUri(allocator, path);
}

fn pathUri(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, "file://");
    for (path) |byte| {
        if (std.ascii.isAlphanumeric(byte) or byte == '/' or byte == '-' or byte == '_' or byte == '.' or byte == '~') {
            try out.append(allocator, byte);
        } else {
            const encoded = try std.fmt.allocPrint(allocator, "%{X:0>2}", .{byte});
            defer allocator.free(encoded);
            try out.appendSlice(allocator, encoded);
        }
    }
    return try out.toOwnedSlice(allocator);
}

fn jsonString(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    try std.json.Stringify.value(value, .{}, &out.writer);
    return try out.toOwnedSlice();
}
