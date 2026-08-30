<div align="center">

# Diffuse

**A local-first desktop app for reviewing Git diffs with syntax-aware rendering, LSP feedback, and optional AI review assistance.**

<p>
  <img alt="Status: Work in progress" src="https://img.shields.io/badge/status-work%20in%20progress-f5a524?style=for-the-badge">
  <img alt="Core: Rust through N-API" src="https://img.shields.io/badge/core-Rust%20%2B%20N--API-f7a41d?style=for-the-badge">
  <img alt="App: Vue and Electron" src="https://img.shields.io/badge/app-Vue%20%2B%20Electron-42b883?style=for-the-badge">
</p>

</div>

---

## What Is Diffuse?

Diffuse is a desktop code review tool for local repositories. It opens a Git repository, shows the files that changed, renders readable diffs, and lets you review those changes without leaving your machine.

It is designed around a simple idea: code review should work well before a pull request exists. Diffuse focuses on local changes, branch comparisons, staged changes, unstaged changes, review comments, diagnostics, and agent-assisted review workflows.

> Diffuse is a work in progress. Expect rough edges, missing polish, and active changes to commands, UI, and review workflows.

## Install

Linux/macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/CrazyCatViking/diffuse/main/scripts/install-release.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/CrazyCatViking/diffuse/main/scripts/install-release.ps1 | iex
```

These scripts are hosted directly in this repository and served by GitHub through `raw.githubusercontent.com`. They detect the current platform, download the matching GitHub Release archive, install Diffuse into the user environment, and create the `diffuse` command.

## Highlights

| Area                  | What Diffuse Does                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Local Git review      | Opens a repository and lists added, modified, deleted, and renamed files.                        |
| Flexible diff targets | Review working tree changes, staged changes, unstaged changes, or branch/ref comparisons.        |
| Readable diffs        | Supports split and inline diff views with diff-only or full-file context.                        |
| Folder review         | Select a folder in the changed-file tree to review all changed files under that folder together. |
| Syntax awareness      | Uses Tree-sitter grammars for highlighting where available.                                      |
| Token highlights      | Shows cheap Git diffs immediately and computes precise token highlights for partial line edits. |
| LSP support           | Shows hover information and diagnostics from language servers.                                   |
| Review state          | Stores review sessions, threads, progress, and chat as plain files under `.diffuse/reviews`.     |
| AI review             | Can run opencode-based review agents and save their findings back into Diffuse.                  |
| Local-first design    | One in-process Rust core works through local Git, local files, and local helper processes.       |

## How It Works

Diffuse has these main source areas:

```text
diffuse/
  core/   Zig user CLI and legacy RPC rollback implementation
  crates/ Rust AppCore, N-API addon, RPC compatibility CLI, and syntax helper
  app/    Electron + Vue app: desktop UI, settings, review agent bridge
  docs/   GitHub-readable docs, architecture notes, and data-format specs
```

The renderer calls a typed preload bridge, Electron main validates IPC, and one native addon hosts one application-wide Rust `AppCore`. Normal desktop use does not start a Diffuse core child per workspace. Git commands, language servers, the isolated syntax helper, and the existing review-agent provider remain child-process boundaries. SQLite provides stable local workspace identity and `.diffuse/reviews` remains the portable review store.

Review data is intentionally easy to inspect and integrate with:

```text
your-repo/
  .diffuse/
    reviews/
      active-session
      sessions/
        <session-id>/
          review.json
          progress.json
          threads/
          runs/
          agents/
          chat/
```

See [`docs/`](docs/) for the documentation index, [`docs/architecture.md`](docs/architecture.md) for internal architecture notes, [`docs/review-spec-v1.md`](docs/review-spec-v1.md) for the review file format, and [`docs/lsp.md`](docs/lsp.md) for language server details.

## Install Prebuilt Release

Prebuilt releases are the recommended install path for users. They do not require cloning the repository or installing Zig, Node, pnpm, or just.

Linux/macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/CrazyCatViking/diffuse/main/scripts/install-release.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/CrazyCatViking/diffuse/main/scripts/install-release.ps1 | iex
```

The release installers download the matching GitHub Release archive for the current platform, install the packaged Electron app, and create a `diffuse` command shim. The desktop app uses the bundled Rust N-API addon by default; CLI subcommands such as `diffuse --version` continue to use the bundled Zig CLI. Linux installs also add a `.desktop` launcher. macOS installs copy `Diffuse.app` to `~/Applications`. Windows installs add a Start Menu shortcut.

Install a specific version by setting `DIFFUSE_VERSION`:

```sh
DIFFUSE_VERSION=v0.1.4 sh -c "$(curl -fsSL https://raw.githubusercontent.com/CrazyCatViking/diffuse/main/scripts/install-release.sh)"
```

PowerShell:

```powershell
$env:DIFFUSE_VERSION = "v0.1.4"; irm https://raw.githubusercontent.com/CrazyCatViking/diffuse/main/scripts/install-release.ps1 | iex
```

## Source Requirements

To build Diffuse from source, install:

| Tool             | Why It Is Needed                                                        |
| ---------------- | ----------------------------------------------------------------------- |
| `git`            | Repository access and local Git fixtures.                               |
| `just`           | Repository-wide build and verification tasks.                           |
| `zig`            | Builds the retained CLI and RPC rollback. Minimum version: `0.16.0`.    |
| `rustup`/`cargo` | Builds `AppCore`, the N-API addon, and the Rust helper. Rust is `1.90.0`. |
| `node`           | Builds and runs Electron. CI uses Node 22.                              |
| `pnpm`           | Installs app dependencies and runs native/app/package tasks.            |
| `curl` and `tar` | Used by Unix release and install tooling.                               |

## Build From Source

Source builds are intended for contributors. Prebuilt releases remain the recommended installation path.

Clone the repository and run the complete build:

```sh
git clone https://github.com/CrazyCatViking/diffuse.git
cd diffuse
just build
```

`just build` will:

1. Check required tools.
2. Build and test the retained Zig CLI/RPC implementation.
3. Format, lint, test, and build the Rust workspace.
4. Stage and smoke the N-API addon in Node and Electron.
5. Run the complete Zig/Rust method, event, persistence, and CLI parity suite.
6. Install app dependencies and build the Electron/Vue app.

For a runnable unpacked N-API application, build the package from `app/` as described under [Development](#development). The older `just install` checkout installer remains available for its Zig CLI launcher and source-tree workflow, but it does not create the packaged Electron native-resource layout.

## Run Diffuse

Open the app:

```sh
diffuse
```

Open a specific repository:

```sh
diffuse /path/to/repository
```

If Diffuse is already running, another `diffuse /path/to/repository` command adds or activates that repository in the existing primary window. All open workspaces share the application's one in-process Rust `AppCore` while keeping explicit workspace IDs and per-open generations.

The desktop app also accepts the packaged-app launch argument `--open-repository <path>`.

Diffuse disables Electron's default application menu so the desktop window only shows the app UI.

Useful CLI commands:

```sh
diffuse --version
diffuse update
diffuse install <version>
diffuse list-versions
diffuse list-versions --cached
diffuse completion <bash|zsh|fish|powershell>
```

`diffuse update` resolves the newest GitHub Release and installs the matching prebuilt artifact for the current platform. `diffuse install <version>` accepts released versions with or without a leading `v` and prints the closest/latest available release when the requested release cannot be found. Version discovery is cached under the platform cache directory and `diffuse list-versions --cached` reads only that cache.

Built-in update/install commands only consider GitHub Releases and do not clone the repository. To run a non-release commit or branch, check out the source and use the development or package commands below. The GitHub repository defaults to `CrazyCatViking/diffuse` and can be overridden with `DIFFUSE_GITHUB_REPO=owner/repo`.

Developer/debug commands:

```sh
diffuse rpc
diffuse files --repo /path/to/repository
diffuse diff --repo /path/to/repository --file src/example.ts
```

## Reviewing Changes

When no repository is open, Diffuse shows a start screen with an `Open Repository` action and recent repositories. Opening a repository starts or resumes the local review workspace for that repository. Opening another repository reuses the primary Diffuse window and keeps the previous workspace loaded in the background; invoking `diffuse <path>` again activates or adds that repository in the existing application instead of opening another workspace window.

The workspace rail keeps open repositories in stable order and provides the Workbench Overview, native open action, and searchable All Workspaces switcher. `Ctrl+Tab` and `Ctrl+Shift+Tab` move through workspaces, `Ctrl+1` through `Ctrl+9` select visible rail slots, `Ctrl+Shift+O` opens the overview, `Ctrl+O` opens a repository, and `Ctrl+K` opens the switcher. These workbench shortcuts are configurable under Keyboard settings. Each workspace restores its last review/file/folder route, diff target and layout, search and pinned results, cursor history, unsaved review draft, and logical focus while retaining only one heavy workspace view in renderer memory.

Closing the primary window hides Diffuse while open workspaces and background work remain available. Use the tray icon to show the workbench again or explicitly quit the application. At narrow desktop widths, the rail compacts and changed files plus pinned search results open as drawers so the diff remains the primary reading surface.

After opening a repository, Diffuse shows a review overview alongside changed files in a collapsible folder tree. The overview summarizes review progress, change totals, review threads, AI activity, and LSP diagnostics for supported changed files. Use the overview to create review sessions and start or stop AI review runs. Diagnostics are checked while the overview is open, so the diff workspace does not spend space on always-visible review controls.

Selecting a file opens that file diff. Selecting a folder opens a virtualized multi-file folder diff for every changed file below that folder. Selecting a review thread from the overview opens its file, scrolls to the anchored review row, and briefly flashes the target.

Use the changed-file search box or the top-bar `Search` action to find files by fuzzy filename/path matches, review state, comments, generated/test/docs classification, extension, status, and line-count filters. `Ctrl+P` or `Cmd+P` opens the global search palette, and matching results can be pinned into an independent right-side search drawer so you can walk through them while reviewing. Pinned search results are a frozen snapshot of the matches that existed when you clicked `Pin results`; later streaming search chunks or new searches do not change that pinned list. The global palette streams file, full changed-file content, and persisted comment results from the selected core with cooperative cancellation; opening a content match automatically switches the diff viewer to full-file mode so the matched line is visible. Symbol extraction is planned next.

The top-bar `Compare` menu controls what Diffuse reviews. Open it to search local or remote branches, choose suggested refs such as `HEAD` or the default upstream, or type a custom branch, tag, SHA, or Git ref.

It supports two main modes:

1. `Working tree against <target>` compares local staged and unstaged changes against a target ref, usually `HEAD`.
2. `<source ref> against <target ref>` compares two Git refs or branches without including working tree changes.

When the source is `Working tree`, use the scope buttons to switch between all local changes, staged changes only, or unstaged changes only. For branch/ref comparisons, use `Swap` to invert source and target quickly.

Diffuse chooses defaults from repository state. Dirty repositories default to working tree changes against `HEAD`. Clean repositories default to `HEAD` against the configured upstream when available, falling back to `origin/main`, `origin/master`, or `HEAD`.

Opening a repository starts on the review overview, then the changed-file tree, search results, and review threads route the main workspace to file and folder diffs as needed. The diff viewer supports split or inline layout, diff-only or full-file context, synchronized split scrolling, lazy syntax highlighting, LSP hover and diagnostics, scan markers for changes, review threads, diagnostics, and search results, and a stale-diff notice when the currently displayed file changes on disk.

Single-file diffs also support a Vim-style cursor for keyboard review. Defaults include `h`/`j`/`k`/`l` and arrow keys for movement, `w`/`b`/`e` for word movement, `0`/`^`/`$` for line movement, `gg`/`G` for file boundaries, `<C-d>`/`<C-u>` for half-page movement, `/`, `n`, and `N` for file search, `[c`/`]c` for changes, `[d`/`]d` for diagnostics, `<C-o>`/`<C-i>` for recorded cursor positions, `<C-w>h`/`<C-w>l` for app surface movement, `<C-w><Left>`/`<C-w><Right>` for old/new split-side movement inside a diff, `v` and `V` for visual selections, `K` for LSP hover, `gc` for a comment draft, `ga` for an AI draft, and `Esc` to clear cursor modes. Surface movement walks currently open cursor surfaces by screen geometry, including the changed-file tree, routed review or diff view, the current single-file diff, and pinned search results when the drawer is open. Re-entering an already visible diff restores the previous cursor only when it is still visible without scrolling; reopening a previously opened file restores its cursor and reveals that line instead of restoring an exact scroll offset; opening a new file starts at the top, preferring the new side in split mode. Significant diff jumps such as file opens, old/new side movement, `gg`, `G`, search-result movement, change movement, diagnostic movement, and review-row movement are recorded for `<C-o>` and `<C-i>` with multiple entries per file and side. Keybinding settings accept both Vim token syntax such as `<C-l>` and human-entered aliases such as `Ctrl+L`. Outside text-entry controls, Diffuse suppresses browser and Electron keyboard defaults so navigation belongs to the app cursor model rather than DOM focus traversal, page scrolling, browser history, reload, zoom, or devtools shortcuts.

Review comments can be anchored to old-side or new-side lines. Selecting text in a diff shows actions for adding a comment or asking AI about the selected code; in split view, text selection stays on the side where the drag starts. Keyboard visual selections use the same comment and AI actions. Threads can be replied to, resolved, reopened, and used as context for AI chat.

## Development

Build and verify everything:

```sh
just build
```

For the normal N-API development path, build the Rust workspace, stage the addon and helper, then start Electron:

```sh
cd app
pnpm install --frozen-lockfile
pnpm native:build
pnpm dev
```

`pnpm native:build` stages `diffuse_core.node`, the Rust `diffuse-rpc` helper, and a hash manifest under `app/build/native`. If Cargo is already built, refresh only the staged files with `pnpm native:stage`.

Run the Node-load, native integration, and Electron-runtime native checks:

```sh
cd app
pnpm test:native:all
```

Run the broader core, app, and deterministic RPC suites:

```sh
cd core
zig build test
zig build

cd ..
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
cargo build --workspace --locked

cd app
pnpm install --frozen-lockfile
pnpm test
pnpm test:integration
pnpm test:rust-integration
```

The desktop backend defaults to one in-process N-API `AppCore`. Useful overrides are:

```sh
DIFFUSE_DESKTOP_CORE=rpc pnpm dev
DIFFUSE_NATIVE_ADDON=/absolute/path/to/diffuse_core.node pnpm dev
DIFFUSE_SYNTAX_RUNNER=/absolute/path/to/diffuse-rpc pnpm dev
```

`DIFFUSE_DESKTOP_CORE=rpc` selects the whole legacy process backend for rollback; it never mixes methods between backends. `DIFFUSE_NATIVE_ADDON` overrides addon discovery. `DIFFUSE_SYNTAX_RUNNER` overrides the isolated helper used for optional native Tree-sitter grammars. On the RPC path, `DIFFUSE_CORE_EXECUTABLE=/path/to/diffuse` selects a specific Rust or Zig compatibility executable.

The normal Electron backend stores `workbench.sqlite3` under Electron's platform `userData` directory. The standalone Rust RPC adapter supports `DIFFUSE_WORKBENCH_DATABASE` for isolated tests.

Build only the app:

```sh
cd app
pnpm build
```

Build an unpacked application or distributable archive for the current platform:

```sh
cd core
zig build -Doptimize=ReleaseSafe

cd ../app
pnpm install --frozen-lockfile
pnpm package
# or
pnpm dist
```

Both commands build and stage release Rust artifacts, build the app, verify staged hashes, and run `electron-builder`. `pnpm package` creates an unpacked app; `pnpm dist` creates the platform archive. Packages contain:

- `diffuse_core.node`: the default in-process desktop core.
- `diffuse-rpc`: the Rust RPC compatibility executable and isolated syntax helper.
- `diffuse`: the Zig user CLI and packaged RPC rollback executable.

These native files flow through normal platform packaging and signing when signing is configured. The repository does not include signing credentials or a notarization guarantee.

Publish a release:

```sh
just publish 0.1.5
```

`just publish` updates the version, commits the release, creates and pushes the `v0.1.5` tag, and lets GitHub Actions build Linux x64, macOS arm64, and Windows x64 archives. Release jobs smoke the unpacked native resources before archiving. Use `just publish-dry-run 0.1.5` to preview the local version/tag steps.

Build only the Rust workspace or retained Zig CLI/RPC implementation:

```sh
cargo build --workspace --locked

cd core
zig build
```

## Language Servers

Diffuse can show LSP hover information and diagnostics in diffs. User configuration lives at:

```text
~/.diffuse/lsp.json
```

Example:

```json
{
  "lsp": {
    "zig": {
      "command": "/home/user/bin/zls",
      "args": []
    }
  }
}
```

Built-in defaults exist for TypeScript/JavaScript, Rust, Python, Go, Zig, and Lua. See [`docs/lsp.md`](docs/lsp.md) for details.

## AI Review

Diffuse includes an experimental opencode review runner. When started from the review bar, the Electron app creates opencode sessions for the opened repository, sends review prompts, and persists findings through the Diffuse core.

The review bar also shows recent review sessions and agent runs. Agent progress, run state, comments, and chat are persisted under `.diffuse/reviews` so the UI can recover state after refreshes or restarts.

Agent behavior can be configured per repository in `.diffuse/reviews/config.json`. If the file does not exist, Diffuse uses this default:

```json
{
  "provider": "opencode",
  "maxParallelAgents": 1,
  "promptInstructions": "Prefer high-signal correctness, security, data-loss, race, and test-coverage findings. Do not comment on non-actionable observations."
}
```

Optional overrides:

```sh
DIFFUSE_OPENCODE_MODEL=provider/model
DIFFUSE_OPENCODE_AGENT=agent-name
```

This workflow is still evolving. Treat AI findings as review assistance, not as a replacement for human judgment.

## Tree-Sitter Grammars

Diffuse uses Tree-sitter for syntax-aware diff rendering. Installed grammars are resolved from `~/.diffuse/grammars` by default, and the app can install missing grammars where supported.

Settings is organized by area instead of one long page. Use Appearance for syntax themes and custom colors, Keyboard for single-file diff keybindings, Language Servers for LSP status/install guidance/config access, and Syntax Grammars for installed and available Tree-sitter grammars, registry sync, install actions, and uninstall actions. Diffuse remembers the last opened settings section locally.

Useful environment variables:

```sh
DIFFUSE_GRAMMARS_DIR=/path/to/grammars
DIFFUSE_TREE_SITTER_REGISTRY_DIR=/path/to/registry
DIFFUSE_TREE_SITTER_REGISTRY_GIT_URL=https://example.com/tree-sitter-registry.git
```

`DIFFUSE_GRAMMARS_DIR` controls where installed parsers live. `DIFFUSE_TREE_SITTER_REGISTRY_DIR` controls where the external registry and highlight queries are stored. `DIFFUSE_TREE_SITTER_REGISTRY_GIT_URL` overrides the registry source used by sync. If a parser is installed but its highlight query is missing, the diff offers a Sync highlights action instead of reinstalling the parser.

## Uninstall

Unix:

```sh
just uninstall
```

Windows PowerShell:

```powershell
just uninstall
```

## Project Status

Diffuse is early and actively under development. The repository already contains working pieces for local diff viewing, review persistence, LSP integration, and opencode-assisted reviews, but the overall product should be considered experimental.

Expect changes in:

1. UI flows and visual design.
2. Review session formats.
3. Agent review behavior.
4. Tree-sitter grammar installation.
5. Packaging and distribution.

If something feels incomplete, it probably is. That is part of the current state of the project.
