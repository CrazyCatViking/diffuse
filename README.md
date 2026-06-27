<div align="center">

# Diffuse

**A local-first desktop app for reviewing Git diffs with syntax-aware rendering, LSP feedback, and optional AI review assistance.**

<p>
  <img alt="Status: Work in progress" src="https://img.shields.io/badge/status-work%20in%20progress-f5a524?style=for-the-badge">
  <img alt="Core: Zig" src="https://img.shields.io/badge/core-Zig-f7a41d?style=for-the-badge">
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

| Area | What Diffuse Does |
| --- | --- |
| Local Git review | Opens a repository and lists added, modified, deleted, and renamed files. |
| Flexible diff targets | Review working tree changes, staged changes, unstaged changes, or branch/ref comparisons. |
| Readable diffs | Supports split and inline diff views with diff-only or full-file context. |
| Folder review | Select a folder in the changed-file tree to review all changed files under that folder together. |
| Syntax awareness | Uses Tree-sitter grammars for highlighting where available. |
| LSP support | Shows hover information and diagnostics from language servers. |
| Review state | Stores review sessions, threads, progress, and chat as plain files under `.diffuse/reviews`. |
| AI review | Can run opencode-based review agents and save their findings back into Diffuse. |
| Local-first design | The core works through local Git, local files, and a local JSON-RPC process. |

## How It Works

Diffuse has two main parts:

```text
diffuse/
  core/   Zig core: Git, diff rendering, syntax, LSP, review persistence, JSON-RPC
  app/    Electron + Vue app: desktop UI, settings, review agent bridge
  docs/   GitHub-readable docs, architecture notes, and data-format specs
```

The desktop app starts the Zig core as a child process using `diffuse rpc`. The UI talks to that process over JSON-RPC. The core owns repository operations, diff generation, Tree-sitter integration, LSP sessions, and persisted review data.

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

The release installers download the matching GitHub Release archive for the current platform, install the packaged Electron app into the user environment, and create a `diffuse` command shim. The shim opens the desktop app for normal usage and forwards CLI subcommands such as `diffuse --version` to the bundled Zig core. Linux installs also add a `.desktop` launcher. macOS installs copy `Diffuse.app` to `~/Applications`. Windows installs add a Start Menu shortcut.

Install a specific version by setting `DIFFUSE_VERSION`:

```sh
DIFFUSE_VERSION=v0.1.4 sh -c "$(curl -fsSL https://raw.githubusercontent.com/CrazyCatViking/diffuse/main/scripts/install-release.sh)"
```

PowerShell:

```powershell
$env:DIFFUSE_VERSION = "v0.1.4"; irm https://raw.githubusercontent.com/CrazyCatViking/diffuse/main/scripts/install-release.ps1 | iex
```

## Source Requirements

To build and install Diffuse from source, install:

| Tool | Why It Is Needed |
| --- | --- |
| `git` | Repository access and update/install commands. |
| `just` | Project task runner. |
| `zig` | Builds the native core. Minimum version: `0.16.0`. |
| `node` | Builds and runs the Electron app. |
| `pnpm` | Installs app dependencies. |
| `curl` and `tar` | Used by build/install tooling on Unix systems. |

## Install From Source

Source install is intended for contributors and users who want to build locally. It is separate from the prebuilt release installers above.

Clone the repository and install:

```sh
git clone https://github.com/CrazyCatViking/diffuse.git
cd diffuse
just install
```

`just install` will:

1. Check required tools.
2. Build the Zig core.
3. Install app dependencies with `pnpm install --frozen-lockfile`.
4. Build the Electron/Vue app.
5. Install Diffuse into your user environment.

Default install locations:

| Platform | Install Root | Command Location |
| --- | --- | --- |
| Linux/macOS-style Unix | `~/.local/share/diffuse` | `~/.local/bin/diffuse` |
| Windows | `%LOCALAPPDATA%\Diffuse` | `%USERPROFILE%\bin\diffuse.exe` |

You can override these paths:

```sh
DIFFUSE_INSTALL_ROOT=/path/to/install DIFFUSE_BIN_DIR=/path/to/bin just install
```

On Unix systems, the installer also adds shell completions and a Linux desktop entry when applicable.

## Run Diffuse

Open the app:

```sh
diffuse
```

Open a specific repository:

```sh
diffuse /path/to/repository
```

If Diffuse is already running, another `diffuse /path/to/repository` command opens a new window in the existing Electron app process. Each window has its own isolated Zig core process.

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

Built-in update/install commands only consider GitHub Releases and do not clone the repository. To install a non-release commit or branch, check out the source repository yourself and run `just install`. The GitHub repository defaults to `CrazyCatViking/diffuse` and can be overridden with `DIFFUSE_GITHUB_REPO=owner/repo`.

Developer/debug commands:

```sh
diffuse rpc
diffuse files --repo /path/to/repository
diffuse diff --repo /path/to/repository --file src/example.ts
```

## Reviewing Changes

When no repository is open, Diffuse shows a start screen with an `Open Repository` action and recent repositories. Opening a repository starts or resumes the local review workspace for that repository.

After opening a repository, Diffuse shows a review overview alongside changed files in a collapsible folder tree. The overview summarizes review progress, change totals, review threads, AI activity, and LSP diagnostics for supported changed files. Use the overview to create review sessions and start or stop AI review runs. Diagnostics are checked while the overview is open, so the diff workspace does not spend space on always-visible review controls.

Selecting a file opens that file diff. Selecting a folder opens a virtualized multi-file folder diff for every changed file below that folder. Selecting a review thread from the overview opens its file, scrolls to the anchored review row, and briefly flashes the target.

Use the changed-file search box or the top-bar `Search` action to find files by fuzzy filename/path matches, review state, comments, generated/test/docs classification, extension, status, and line-count filters. `Ctrl+P` or `Cmd+P` opens the global search palette, and matching results can be pinned into an independent right-side search drawer so you can walk through them while reviewing. The global palette streams file, full changed-file content, and persisted comment results from the Zig core with cooperative cancellation; opening a content match automatically switches the diff viewer to full-file mode so the matched line is visible. Symbol extraction is planned next.

The top-bar `Compare` menu controls what Diffuse reviews. Open it to search local or remote branches, choose suggested refs such as `HEAD` or the default upstream, or type a custom branch, tag, SHA, or Git ref.

It supports two main modes:

1. `Working tree against <target>` compares local staged and unstaged changes against a target ref, usually `HEAD`.
2. `<source ref> against <target ref>` compares two Git refs or branches without including working tree changes.

When the source is `Working tree`, use the scope buttons to switch between all local changes, staged changes only, or unstaged changes only. For branch/ref comparisons, use `Swap` to invert source and target quickly.

Diffuse chooses defaults from repository state. Dirty repositories default to working tree changes against `HEAD`. Clean repositories default to `HEAD` against the configured upstream when available, falling back to `origin/main`, `origin/master`, or `HEAD`.

The diff viewer supports split or inline layout, diff-only or full-file context, synchronized split scrolling, lazy syntax highlighting, LSP hover and diagnostics, scan markers for changes, review threads, diagnostics, and search results, and a stale-diff notice when the currently displayed file changes on disk.

Review comments can be anchored to old-side or new-side lines. Selecting text in a diff shows actions for adding a comment or asking AI about the selected code; in split view, text selection stays on the side where the drag starts. Threads can be replied to, resolved, reopened, and used as context for AI chat.

## Development

Build everything:

```sh
just build
```

Run the app in development mode:

```sh
cd core
zig build

cd ../app
pnpm install --frozen-lockfile
pnpm dev
```

The Electron app looks for the core binary in `core/zig-out/bin/diffuse`. You can point it at a custom binary with:

```sh
DIFFUSE_CORE_EXECUTABLE=/path/to/diffuse pnpm dev
```

When no explicit executable is configured, the Electron app checks development paths, packaged resources, and then the installed core under `DIFFUSE_INSTALL_ROOT` or `~/.local/share/diffuse/core/diffuse`.

Build only the app:

```sh
cd app
pnpm build
```

Package the native Electron app for the current platform:

```sh
cd core
zig build -Doptimize=ReleaseSafe

cd ../app
pnpm install --frozen-lockfile
pnpm dist
```

`pnpm dist` copies the built Zig core into Electron resources and runs `electron-builder`. This packaging path is for prebuilt releases; it does not replace `just install`, which continues to install from source.

Publish a release:

```sh
just publish 0.1.5
```

`just publish` updates the version, commits the release, creates and pushes the `v0.1.5` tag, and lets the GitHub Actions release workflow build Linux, macOS, and Windows archives. The workflow creates the GitHub Release and uploads those archives. Use `just publish-dry-run 0.1.5` to preview the local version/tag steps.

Build only the core:

```sh
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

Settings includes syntax theme selection, custom syntax colors stored in browser local storage, language server status and install guidance, installed grammar management, available grammar search, registry sync, install actions, and uninstall actions.

Useful environment variables:

```sh
DIFFUSE_GRAMMARS_DIR=/path/to/grammars
DIFFUSE_TREE_SITTER_REGISTRY_DIR=/path/to/registry
DIFFUSE_TREE_SITTER_REGISTRY_GIT_URL=https://example.com/tree-sitter-registry.git
```

`DIFFUSE_GRAMMARS_DIR` controls where installed parsers and queries live. `DIFFUSE_TREE_SITTER_REGISTRY_DIR` controls where the external registry checkout is stored. `DIFFUSE_TREE_SITTER_REGISTRY_GIT_URL` overrides the registry source used by sync.

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
