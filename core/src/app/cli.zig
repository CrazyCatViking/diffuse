const std = @import("std");

const diff = @import("../core/diff.zig");
const repository = @import("../core/repository.zig");
const rpc_server = @import("rpc_server.zig");
const types = @import("../protocol/types.zig");

pub fn run(allocator: std.mem.Allocator, io: std.Io, process_args: std.process.Args, environ_map: *const std.process.Environ.Map) !void {
    var iter = try std.process.Args.Iterator.initAllocator(process_args, allocator);
    defer iter.deinit();

    var args_list: std.ArrayList([]const u8) = .empty;
    defer args_list.deinit(allocator);
    while (iter.next()) |arg| try args_list.append(allocator, arg);
    const args = args_list.items;

    if (args.len <= 1) return launchApp(allocator, io, null, environ_map);

    const command = args[1];
    if (std.mem.eql(u8, command, "--help") or std.mem.eql(u8, command, "-h")) {
        try printHelp(io);
    } else if (std.mem.eql(u8, command, "--version") or std.mem.eql(u8, command, "version")) {
        var stdout_buffer: [1024]u8 = undefined;
        var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
        const stdout = &stdout_writer.interface;
        try stdout.print("diffuse {s}\n", .{types.version});
        try stdout.flush();
    } else if (std.mem.eql(u8, command, "completion")) {
        if (args.len < 3) return error.MissingOption;
        try printCompletion(io, args[2]);
    } else if (std.mem.eql(u8, command, "list-versions")) {
        const cached_only = hasArg(args, "--cached");
        const versions = try listVersions(allocator, io, environ_map, cached_only);
        defer allocator.free(versions);
        var stdout_buffer: [4096]u8 = undefined;
        var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
        const stdout = &stdout_writer.interface;
        try stdout.writeAll(versions);
        try stdout.flush();
    } else if (std.mem.eql(u8, command, "update")) {
        const versions = try listVersions(allocator, io, environ_map, false);
        defer allocator.free(versions);
        const latest = firstLine(versions) orelse return error.NoVersionsFound;
        try installVersion(allocator, io, environ_map, latest);
    } else if (std.mem.eql(u8, command, "install")) {
        if (args.len < 3) return error.MissingOption;
        const version = try resolveInstallVersion(allocator, io, environ_map, args[2]);
        defer allocator.free(version);
        try installVersion(allocator, io, environ_map, version);
    } else if (std.mem.eql(u8, command, "rpc")) {
        try rpc_server.run(allocator, io, environ_map);
    } else if (std.mem.eql(u8, command, "files")) {
        const repo_path = try readOption(args, "--repo");
        var repo = try repository.open(allocator, io, repo_path);
        defer repo.deinit();
        const files = try repo.listChangedFiles(.{});
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
        const grammar_root = try resolveGrammarRoot(allocator, environ_map);
        defer if (grammar_root) |path| allocator.free(path);
        var model = try diff.getDiffRenderModel(allocator, io, repo.root, file_path, file_path, .{ .grammar_root = grammar_root });
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
            .syntax = types.syntaxStatus(model.syntax_status),
            .rows = rows.items,
        });
        try stdout.writeByte('\n');
        try stdout.flush();
    } else if (std.mem.startsWith(u8, command, "-")) return error.UnknownOption else try launchApp(allocator, io, command, environ_map);
}

fn launchApp(allocator: std.mem.Allocator, io: std.Io, maybe_path: ?[]const u8, environ_map: *const std.process.Environ.Map) !void {
    const install_root = try installRoot(allocator, environ_map);
    defer allocator.free(install_root);
    const app_root = try std.fs.path.join(allocator, &.{ install_root, "app" });
    defer allocator.free(app_root);
    const electron = try electronExecutable(allocator, io, app_root);
    defer allocator.free(electron);

    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.append(allocator, electron);
    try argv.append(allocator, app_root);
    var resolved_path: ?[]u8 = null;
    defer if (resolved_path) |path| allocator.free(path);
    if (maybe_path) |path| {
        resolved_path = try std.fs.path.resolve(allocator, &.{path});
        try argv.append(allocator, "--open-repository");
        try argv.append(allocator, resolved_path.?);
    }

    _ = try std.process.spawn(io, .{ .argv = argv.items, .stdin = .ignore, .stdout = .ignore, .stderr = .ignore });
}

fn installRoot(allocator: std.mem.Allocator, environ_map: *const std.process.Environ.Map) ![]u8 {
    if (environ_map.get("DIFFUSE_INSTALL_ROOT")) |root| return try allocator.dupe(u8, root);
    const home = environ_map.get("HOME") orelse return try allocator.dupe(u8, ".");
    return try std.fs.path.join(allocator, &.{ home, ".local", "share", "diffuse" });
}

fn electronExecutable(allocator: std.mem.Allocator, io: std.Io, app_root: []const u8) ![]u8 {
    const local = try std.fs.path.join(allocator, &.{ app_root, "node_modules", "electron", "dist", "electron" });
    if (fileExists(io, local)) return local;
    allocator.free(local);
    return try allocator.dupe(u8, "electron");
}

fn githubRepo(environ_map: *const std.process.Environ.Map) []const u8 {
    return environ_map.get("DIFFUSE_GITHUB_REPO") orelse "CrazyCatViking/diffuse";
}

fn listVersions(allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map, cached_only: bool) ![]u8 {
    const cache_path = try versionCachePath(allocator, environ_map);
    defer allocator.free(cache_path);
    if (cached_only) return readVersionCache(allocator, io, cache_path) catch allocator.alloc(u8, 0);

    const repo = githubRepo(environ_map);
    const url = try std.fmt.allocPrint(allocator, "https://api.github.com/repos/{s}/tags", .{repo});
    defer allocator.free(url);
    const json = runOutput(allocator, io, &.{ "curl", "-fsSL", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: diffuse-cli", url }) catch return readVersionCache(allocator, io, cache_path) catch allocator.alloc(u8, 0);
    defer allocator.free(json);
    const tags = try parseGitHubTags(allocator, json);
    try writeVersionCache(io, cache_path, tags);
    return tags;
}

fn versionCachePath(allocator: std.mem.Allocator, environ_map: *const std.process.Environ.Map) ![]u8 {
    const cache_home = environ_map.get("XDG_CACHE_HOME") orelse blk: {
        const home = environ_map.get("HOME") orelse ".";
        break :blk try std.fs.path.join(allocator, &.{ home, ".cache" });
    };
    if (environ_map.get("XDG_CACHE_HOME") != null) return try std.fs.path.join(allocator, &.{ cache_home, "diffuse", "tags.txt" });
    defer allocator.free(cache_home);
    return try std.fs.path.join(allocator, &.{ cache_home, "diffuse", "tags.txt" });
}

fn parseGitHubTags(allocator: std.mem.Allocator, json: []const u8) ![]u8 {
    var result: std.ArrayList(u8) = .empty;
    errdefer result.deinit(allocator);
    var rest = json;
    while (std.mem.indexOf(u8, rest, "\"name\"")) |name_index| {
        rest = rest[name_index + 6 ..];
        const colon = std.mem.indexOfScalar(u8, rest, ':') orelse break;
        rest = rest[colon + 1 ..];
        const quote = std.mem.indexOfScalar(u8, rest, '"') orelse break;
        rest = rest[quote + 1 ..];
        const end = std.mem.indexOfScalar(u8, rest, '"') orelse break;
        try result.appendSlice(allocator, rest[0..end]);
        try result.append(allocator, '\n');
        rest = rest[end + 1 ..];
    }
    return result.toOwnedSlice(allocator);
}

fn readVersionCache(allocator: std.mem.Allocator, io: std.Io, path: []const u8) ![]u8 {
    return std.Io.Dir.readFileAlloc(.cwd(), io, path, allocator, .limited(1024 * 1024));
}

fn writeVersionCache(io: std.Io, path: []const u8, tags: []const u8) !void {
    const parent = std.fs.path.dirname(path) orelse ".";
    try std.Io.Dir.createDirPath(.cwd(), io, parent);
    try std.Io.Dir.writeFile(.cwd(), io, .{ .sub_path = path, .data = tags });
}

fn resolveInstallVersion(allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map, requested: []const u8) ![]u8 {
    const versions = try listVersions(allocator, io, environ_map, false);
    defer allocator.free(versions);
    var candidates = [_][]const u8{ requested, requested };
    var prefixed: ?[]u8 = null;
    defer if (prefixed) |value| allocator.free(value);
    if (!std.mem.startsWith(u8, requested, "v")) {
        prefixed = try std.fmt.allocPrint(allocator, "v{s}", .{requested});
        candidates[0] = prefixed.?;
        candidates[1] = requested;
    } else {
        candidates[0] = requested;
        candidates[1] = requested[1..];
    }
    for (candidates) |candidate| {
        if (containsLine(versions, candidate)) return try allocator.dupe(u8, candidate);
    }
    if (versions.len == 0) return try allocator.dupe(u8, candidates[0]);

    var stderr_buffer: [2048]u8 = undefined;
    var stderr_writer = std.Io.File.stderr().writer(io, &stderr_buffer);
    const stderr = &stderr_writer.interface;
    try stderr.print("Diffuse version {s} does not exist in {s}.\n", .{ requested, githubRepo(environ_map) });
    if (closestVersion(versions, requested)) |closest| try stderr.print("Closest version: {s}\n", .{closest});
    if (firstLine(versions)) |latest| try stderr.print("Latest version: {s}\n", .{latest});
    try stderr.flush();
    std.process.exit(1);
}

fn installVersion(allocator: std.mem.Allocator, io: std.Io, environ_map: *const std.process.Environ.Map, tag: []const u8) !void {
    const repo = githubRepo(environ_map);
    const script = try std.fmt.allocPrint(allocator,
        "tmp=$(mktemp -d) && trap 'rm -rf \"$tmp\"' EXIT && curl -fsSL -o \"$tmp/diffuse.tar.gz\" 'https://github.com/{s}/archive/refs/tags/{s}.tar.gz' && tar -xzf \"$tmp/diffuse.tar.gz\" -C \"$tmp\" && src=$(find \"$tmp\" -mindepth 1 -maxdepth 1 -type d | head -n 1) && cd \"$src\" && just install",
        .{ repo, tag },
    );
    defer allocator.free(script);
    try runChecked(allocator, io, "install diffuse", &.{ "sh", "-c", script });
}

fn containsLine(text: []const u8, needle: []const u8) bool {
    var iter = std.mem.splitScalar(u8, text, '\n');
    while (iter.next()) |line| if (std.mem.eql(u8, line, needle)) return true;
    return false;
}

fn firstLine(text: []const u8) ?[]const u8 {
    var iter = std.mem.splitScalar(u8, text, '\n');
    while (iter.next()) |line| if (line.len > 0) return line;
    return null;
}

fn closestVersion(versions: []const u8, requested: []const u8) ?[]const u8 {
    var best: ?[]const u8 = null;
    var best_distance: usize = std.math.maxInt(usize);
    var iter = std.mem.splitScalar(u8, versions, '\n');
    while (iter.next()) |version| {
        if (version.len == 0) continue;
        const distance = levenshtein(stripV(version), stripV(requested));
        if (distance < best_distance) {
            best = version;
            best_distance = distance;
        }
    }
    return best;
}

fn stripV(value: []const u8) []const u8 {
    return if (std.mem.startsWith(u8, value, "v")) value[1..] else value;
}

fn levenshtein(a: []const u8, b: []const u8) usize {
    var distance: usize = if (a.len > b.len) a.len - b.len else b.len - a.len;
    const common = @min(a.len, b.len);
    for (0..common) |index| {
        if (a[index] != b[index]) distance += 1;
    }
    return distance;
}

fn hasArg(args: []const []const u8, needle: []const u8) bool {
    for (args) |arg| if (std.mem.eql(u8, arg, needle)) return true;
    return false;
}

fn runChecked(allocator: std.mem.Allocator, io: std.Io, step: []const u8, argv: []const []const u8) !void {
    if (try runCommand(allocator, io, step, argv)) |message| {
        defer allocator.free(message);
        var stderr_buffer: [4096]u8 = undefined;
        var stderr_writer = std.Io.File.stderr().writer(io, &stderr_buffer);
        const stderr = &stderr_writer.interface;
        try stderr.print("{s}\n", .{message});
        try stderr.flush();
        std.process.exit(1);
    }
}

fn runCommand(allocator: std.mem.Allocator, io: std.Io, step: []const u8, argv: []const []const u8) !?[]u8 {
    const result = try std.process.run(allocator, io, .{ .argv = argv, .stdout_limit = .limited(1024 * 1024), .stderr_limit = .limited(1024 * 1024) });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    switch (result.term) {
        .exited => |code| if (code == 0) return null,
        else => {},
    }
    return try std.fmt.allocPrint(allocator, "{s} failed: {s}{s}", .{ step, result.stderr, result.stdout });
}

fn runOutput(allocator: std.mem.Allocator, io: std.Io, argv: []const []const u8) ![]u8 {
    const result = try std.process.run(allocator, io, .{ .argv = argv, .stdout_limit = .limited(20 * 1024 * 1024), .stderr_limit = .limited(1024 * 1024) });
    defer allocator.free(result.stderr);
    switch (result.term) {
        .exited => |code| if (code == 0) return result.stdout,
        else => {},
    }
    allocator.free(result.stdout);
    return error.CommandFailed;
}

fn fileExists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.access(.cwd(), io, path, .{}) catch return false;
    return true;
}

fn resolveGrammarRoot(allocator: std.mem.Allocator, environ_map: *const std.process.Environ.Map) !?[]u8 {
    if (environ_map.get("DIFFUSE_GRAMMARS_DIR")) |path| return try allocator.dupe(u8, path);
    const home = environ_map.get("HOME") orelse return null;
    return try std.fs.path.join(allocator, &.{ home, ".diffuse", "grammars" });
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
        \\  diffuse [path]
        \\  diffuse --version
        \\  diffuse update
        \\  diffuse install <version>
        \\  diffuse completion <bash|zsh|fish|powershell>
        \\  diffuse list-versions [--cached]
        \\  diffuse rpc
        \\  diffuse files --repo <path>
        \\  diffuse diff --repo <path> --file <path>
        \\
    );
    try stdout.flush();
}

fn printCompletion(io: std.Io, shell: []const u8) !void {
    var buffer: [8192]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(io, &buffer);
    const stdout = &stdout_writer.interface;
    if (std.mem.eql(u8, shell, "bash")) {
        try stdout.writeAll(
            \\_diffuse_complete() {
            \\  local cur="${COMP_WORDS[COMP_CWORD]}"
            \\  if [[ "${COMP_WORDS[1]}" == "install" && ${COMP_CWORD} -eq 2 ]]; then COMPREPLY=( $(compgen -W "$(diffuse list-versions 2>/dev/null)" -- "$cur") ); return; fi
            \\  if [[ "${COMP_WORDS[1]}" == "completion" && ${COMP_CWORD} -eq 2 ]]; then COMPREPLY=( $(compgen -W "bash zsh fish powershell" -- "$cur") ); return; fi
            \\  if [[ ${COMP_CWORD} -eq 1 ]]; then COMPREPLY=( $(compgen -W "update install completion list-versions --help --version" -- "$cur") $(compgen -d -- "$cur") ); fi
            \\}
            \\complete -F _diffuse_complete diffuse
            \\
        );
    } else if (std.mem.eql(u8, shell, "zsh")) {
        try stdout.writeAll(
            \\#compdef diffuse
            \\case $words[2] in
            \\  install) local -a versions; versions=(${(f)"$(diffuse list-versions 2>/dev/null)"}); _describe 'versions' versions ;;
            \\  completion) _values 'shells' bash zsh fish powershell ;;
            \\  *) _arguments '1: :((update install completion list-versions --help --version))' ;;
            \\esac
            \\
        );
    } else if (std.mem.eql(u8, shell, "fish")) {
        try stdout.writeAll(
            \\complete -c diffuse -f
            \\complete -c diffuse -l help -d 'Show help'
            \\complete -c diffuse -l version -d 'Show installed version'
            \\complete -c diffuse -n '__fish_use_subcommand' -a 'update install completion list-versions'
            \\complete -c diffuse -n '__fish_seen_subcommand_from install' -a '(diffuse list-versions 2>/dev/null)'
            \\complete -c diffuse -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish powershell'
            \\
        );
    } else if (std.mem.eql(u8, shell, "powershell")) {
        try stdout.writeAll(
            \\Register-ArgumentCompleter -Native -CommandName diffuse -ScriptBlock {
            \\  param($wordToComplete, $commandAst, $cursorPosition)
            \\  'update','install','completion','list-versions','--help','--version' | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
            \\}
            \\
        );
    } else return error.UnknownShell;
    try stdout.flush();
}
