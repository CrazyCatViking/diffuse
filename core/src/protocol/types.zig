const std = @import("std");
const repository = @import("../core/repository.zig");
const diff = @import("../core/diff.zig");
const lsp = @import("../core/lsp.zig");

pub const app_name = "diffuse";
pub const version = "0.1.0";

const json_options: std.json.Stringify.Options = .{ .emit_null_optional_fields = false };

pub const VersionInfo = struct {
    name: []const u8,
    version: []const u8,
};

pub const OpenRepositoryResult = struct {
    root: []const u8,
    head: []const u8,
};

pub const ChangedFile = struct {
    id: []const u8,
    oldPath: ?[]const u8,
    newPath: ?[]const u8,
    status: []const u8,
    additions: u32,
    deletions: u32,
};

pub const DiffTarget = struct {
    base: ?[]const u8 = null,
    compare: ?[]const u8 = null,
    includeStaged: bool,
    includeUnstaged: bool,
};

pub const DiffTargetDefaults = struct {
    base: []const u8,
    compare: ?[]const u8 = null,
    includeStaged: bool,
    includeUnstaged: bool,
    dirty: bool,
    upstream: ?[]const u8 = null,
};

pub const BranchInfo = struct {
    name: []const u8,
    current: bool,
};

pub const DiffRenderModel = struct {
    fileId: []const u8,
    mode: []const u8,
    context: []const u8,
    syntax: SyntaxStatus,
    rows: []const DiffRow,
};

pub const SyntaxStatus = struct {
    language: ?[]const u8 = null,
    grammarInstalled: bool,
    grammarPath: ?[]const u8 = null,
    highlightsQueryPath: ?[]const u8 = null,
    highlightsInstalled: bool = false,
    missingReason: ?[]const u8 = null,
};

pub const SyntaxSpan = diff.syntax.SyntaxSpan;

pub const SyntaxLineSpans = struct {
    line: u32,
    spans: []const SyntaxSpan,
};

pub const LspStatus = struct {
    language: ?[]const u8 = null,
    serverId: ?[]const u8 = null,
    command: ?[]const u8 = null,
    configured: bool,
    installed: bool,
    starting: bool = false,
    running: bool = false,
    configSource: ?[]const u8 = null,
    lastError: ?[]const u8 = null,
    message: ?[]const u8 = null,
};

pub const LspHover = struct {
    status: []const u8,
    language: ?[]const u8 = null,
    serverId: ?[]const u8 = null,
    contents: ?[]const u8 = null,
    message: ?[]const u8 = null,
};

pub const LspDiagnostic = struct {
    line: u32,
    startColumn: u32,
    endColumn: u32,
    severity: []const u8,
    message: []const u8,
    source: ?[]const u8 = null,
    code: ?[]const u8 = null,
};

pub const LspDiagnostics = struct {
    status: []const u8,
    language: ?[]const u8 = null,
    serverId: ?[]const u8 = null,
    diagnostics: []const LspDiagnostic,
    message: ?[]const u8 = null,
};

pub const LspConfigInfo = struct {
    configPath: ?[]const u8 = null,
    servers: []const LspServerInfo,
};

pub const LspServerInfo = struct {
    language: []const u8,
    serverId: []const u8,
    command: []const u8,
    args: []const []const u8,
    configSource: []const u8,
    installed: bool,
    starting: bool = false,
    running: bool = false,
    lastError: ?[]const u8 = null,
    install: ?LspInstallInfo = null,
};

pub const LspInstallInfo = struct {
    manager: []const u8,
    command: []const u8,
    args: []const []const u8,
    description: []const u8,
    requiresShell: bool,
    safeToRun: bool,
    note: ?[]const u8 = null,
};

pub const InstallLspServerResult = struct {
    serverId: []const u8,
    command: []const u8,
    installed: bool,
    message: ?[]const u8 = null,
};

pub const RestartLspServerResult = struct {
    serverId: []const u8,
    restarted: bool,
    message: ?[]const u8 = null,
};

pub const InstallTreeSitterGrammarResult = struct {
    language: []const u8,
    installed: bool,
    grammarPath: ?[]const u8 = null,
    highlightsQueryPath: ?[]const u8 = null,
    highlightsInstalled: bool = false,
    message: ?[]const u8 = null,
};

pub const UninstallTreeSitterGrammarResult = struct {
    language: []const u8,
    uninstalled: bool,
    message: ?[]const u8 = null,
};

pub const SyncTreeSitterRegistryResult = struct {
    path: []const u8,
    synced: bool,
    message: ?[]const u8 = null,
};

pub const TreeSitterGrammar = struct {
    id: []const u8,
    url: ?[]const u8 = null,
    revision: ?[]const u8 = null,
    requires: []const []const u8,
    installed: bool,
    grammarPath: ?[]const u8 = null,
    highlightsQueryPath: ?[]const u8 = null,
    highlightsInstalled: bool = false,
};

pub const DiffRow = struct {
    kind: []const u8,
    oldLine: ?u32 = null,
    newLine: ?u32 = null,
    oldText: ?[]const u8 = null,
    newText: ?[]const u8 = null,
    text: ?[]const u8 = null,
    hunkHeader: ?[]const u8 = null,
    oldSyntaxSpans: ?[]const SyntaxSpan = null,
    newSyntaxSpans: ?[]const SyntaxSpan = null,
};

pub fn versionInfo() VersionInfo {
    return .{
        .name = app_name,
        .version = version,
    };
}

pub fn openRepositoryResult(repo: repository.Repository) OpenRepositoryResult {
    return .{
        .root = repo.root,
        .head = repo.head,
    };
}

pub fn changedFile(file: repository.ChangedFile) ChangedFile {
    return .{
        .id = file.id,
        .oldPath = file.old_path,
        .newPath = file.new_path,
        .status = file.statusString(),
        .additions = file.additions,
        .deletions = file.deletions,
    };
}

pub fn diffTargetDefaults(value: repository.DiffTargetDefaults) DiffTargetDefaults {
    return .{
        .base = value.base,
        .compare = value.compare,
        .includeStaged = value.include_staged,
        .includeUnstaged = value.include_unstaged,
        .dirty = value.dirty,
        .upstream = value.upstream,
    };
}

pub fn branchInfo(value: repository.BranchInfo) BranchInfo {
    return .{ .name = value.name, .current = value.current };
}

pub fn diffRow(row: diff.DiffRow) DiffRow {
    return .{
        .kind = row.kindString(),
        .oldLine = row.old_line,
        .newLine = row.new_line,
        .oldText = row.old_text,
        .newText = row.new_text,
        .text = row.text,
        .hunkHeader = row.hunk_header,
        .oldSyntaxSpans = syntaxSpans(row.old_syntax_spans),
        .newSyntaxSpans = syntaxSpans(row.new_syntax_spans),
    };
}

pub fn syntaxStatus(status: diff.syntax.SyntaxStatus) SyntaxStatus {
    return .{
        .language = status.language,
        .grammarInstalled = status.grammarInstalled,
        .grammarPath = status.grammarPath,
        .highlightsQueryPath = status.highlightsQueryPath,
        .highlightsInstalled = status.highlightsInstalled,
        .missingReason = status.missingReason,
    };
}

pub fn installTreeSitterGrammarResult(result: diff.syntax.InstallResult) InstallTreeSitterGrammarResult {
    return .{
        .language = result.language,
        .installed = result.installed,
        .grammarPath = result.grammarPath,
        .highlightsQueryPath = result.highlightsQueryPath,
        .highlightsInstalled = result.highlightsInstalled,
        .message = result.message,
    };
}

pub fn uninstallTreeSitterGrammarResult(result: diff.syntax.UninstallResult) UninstallTreeSitterGrammarResult {
    return .{
        .language = result.language,
        .uninstalled = result.uninstalled,
        .message = result.message,
    };
}

pub fn syncTreeSitterRegistryResult(result: diff.syntax.RegistrySyncResult) SyncTreeSitterRegistryResult {
    return .{
        .path = result.path,
        .synced = result.synced,
        .message = result.message,
    };
}

pub fn treeSitterGrammar(grammar: diff.syntax.GrammarInfo) TreeSitterGrammar {
    return .{
        .id = grammar.id,
        .url = grammar.url,
        .revision = grammar.revision,
        .requires = grammar.requires,
        .installed = grammar.installed,
        .grammarPath = grammar.grammarPath,
        .highlightsQueryPath = grammar.highlightsQueryPath,
        .highlightsInstalled = grammar.highlightsInstalled,
    };
}

pub fn syntaxLineSpans(value: diff.SyntaxLineSpans) SyntaxLineSpans {
    return .{ .line = value.line, .spans = value.spans };
}

pub fn lspStatus(value: lsp.Status) LspStatus {
    return .{
        .language = value.language,
        .serverId = value.serverId,
        .command = value.command,
        .configured = value.configured,
        .installed = value.installed,
        .starting = value.starting,
        .running = value.running,
        .configSource = value.configSource,
        .lastError = value.lastError,
        .message = value.message,
    };
}

pub fn lspHover(value: lsp.HoverResult) LspHover {
    return .{
        .status = value.status,
        .language = value.language,
        .serverId = value.serverId,
        .contents = value.contents,
        .message = value.message,
    };
}

pub fn lspDiagnostic(value: lsp.Diagnostic) LspDiagnostic {
    return .{
        .line = value.line,
        .startColumn = value.startColumn,
        .endColumn = value.endColumn,
        .severity = value.severity,
        .message = value.message,
        .source = value.source,
        .code = value.code,
    };
}

pub fn lspDiagnostics(value: lsp.DiagnosticsResult, diagnostics: []const LspDiagnostic) LspDiagnostics {
    return .{
        .status = value.status,
        .language = value.language,
        .serverId = value.serverId,
        .diagnostics = diagnostics,
        .message = value.message,
    };
}

pub fn lspConfigInfo(value: lsp.ConfigInfo, servers: []const LspServerInfo) LspConfigInfo {
    return .{ .configPath = value.config_path, .servers = servers };
}

pub fn lspServerInfo(value: lsp.ServerInfo) LspServerInfo {
    return .{
        .language = value.language,
        .serverId = value.server_id,
        .command = value.command,
        .args = value.args,
        .configSource = value.config_source,
        .installed = value.installed,
        .starting = value.starting,
        .running = value.running,
        .lastError = value.last_error,
        .install = if (value.install_info) |install| lspInstallInfo(install) else null,
    };
}

pub fn lspInstallInfo(value: lsp.InstallInfo) LspInstallInfo {
    return .{
        .manager = value.manager,
        .command = value.command,
        .args = value.args,
        .description = value.description,
        .requiresShell = value.requires_shell,
        .safeToRun = value.safe_to_run,
        .note = value.note,
    };
}

pub fn installLspServerResult(value: lsp.InstallResult) InstallLspServerResult {
    return .{
        .serverId = value.serverId,
        .command = value.command,
        .installed = value.installed,
        .message = value.message,
    };
}

pub fn restartLspServerResult(value: lsp.RestartResult) RestartLspServerResult {
    return .{
        .serverId = value.serverId,
        .restarted = value.restarted,
        .message = value.message,
    };
}

fn syntaxSpans(spans: ?[]const diff.syntax.SyntaxSpan) ?[]const SyntaxSpan {
    return spans;
}

pub fn writeJsonString(writer: *std.Io.Writer, value: []const u8) !void {
    try writeJson(writer, value);
}

pub fn writeJson(writer: *std.Io.Writer, value: anytype) !void {
    try std.json.Stringify.value(value, json_options, writer);
}
