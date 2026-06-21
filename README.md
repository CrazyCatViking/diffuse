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

## Highlights

| Area | What Diffuse Does |
| --- | --- |
| Local Git review | Opens a repository and lists added, modified, deleted, and renamed files. |
| Flexible diff targets | Review working tree changes, staged changes, unstaged changes, or branch/ref comparisons. |
| Readable diffs | Supports split and inline diff views with diff-only or full-file context. |
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
  docs/   Implementation notes and data-format specs
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

See [`docs/review-spec-v1.md`](docs/review-spec-v1.md) for the review file format and [`docs/lsp.md`](docs/lsp.md) for language server details.

## Requirements

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

Useful CLI commands:

```sh
diffuse --version
diffuse update
diffuse install <version>
diffuse list-versions
diffuse completion <bash|zsh|fish|powershell>
```

Developer/debug commands:

```sh
diffuse rpc
diffuse files --repo /path/to/repository
diffuse diff --repo /path/to/repository --file src/example.ts
```

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

Build only the app:

```sh
cd app
pnpm build
```

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
  "servers": {
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

Optional overrides:

```sh
DIFFUSE_OPENCODE_MODEL=provider/model
DIFFUSE_OPENCODE_AGENT=agent-name
```

This workflow is still evolving. Treat AI findings as review assistance, not as a replacement for human judgment.

## Tree-Sitter Grammars

Diffuse uses Tree-sitter for syntax-aware diff rendering. Installed grammars are resolved from `~/.diffuse/grammars` by default, and the app can install missing grammars where supported.

Useful environment variables:

```sh
DIFFUSE_GRAMMARS_DIR=/path/to/grammars
DIFFUSE_TREE_SITTER_REGISTRY_DIR=/path/to/registry
```

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
