# How Diffuse Works

Diffuse is split into two cooperating programs:

- `core/` is a Zig executable named `diffuse`. It owns Git access, repository session state, diff parsing, and Tree-sitter syntax work.
- `app/` is an Electron/Vue desktop app. It owns windows, dialogs, UI state, rendering, and communication with the core process.

The app talks to the core over line-delimited JSON-RPC on the core process `stdin` and `stdout`.

## Runtime Shape

```text
Vue renderer
  -> window.diffuse preload bridge
  -> Electron ipcMain handlers
  -> CoreRpcClient
  -> spawned Zig process: core/zig-out/bin/diffuse rpc
  -> Zig RPC server
  -> repository, diff, syntax modules
```

The renderer never imports Node APIs directly. `app/electron/preload.ts` exposes a small `window.diffuse` bridge with three capabilities:

- `pickRepository()` asks Electron main to show a native directory picker.
- `coreRequest(method, params)` sends a whitelisted request to the Zig core.
- `onCoreEvent(listener)` subscribes to core notifications, currently used for Tree-sitter install progress.

## Electron Wiring

`app/electron/main.ts` is the Electron main entry point. It creates the browser window, starts the core process, and registers IPC handlers.

The core process is started lazily through `getCore()`. `app/electron/coreProcess.ts` resolves the executable from these locations:

- `core/zig-out/bin/diffuse` during development.
- `process.resourcesPath/diffuse` in a packaged app.

It spawns the executable as:

```text
diffuse rpc
```

`app/electron/coreRpcClient.ts` wraps the child process. Each request is serialized as a single JSON line:

```json
{"jsonrpc":"2.0","id":1,"method":"listChangedFiles","params":{}}
```

The client tracks pending requests by numeric `id`, resolves them when a matching response line arrives, and emits messages without an `id` as events. Timeouts are applied per method. Most timed-out requests kill and restart the core; `getSyntaxSpans` is allowed to time out without killing the process.

The main process also limits renderer access with `allowedCoreMethods`:

- `getVersion`
- `openRepository`
- `listChangedFiles`
- `getDiffRenderModel`
- `getSyntaxSpans`
- `installTreeSitterGrammar`

After `openRepository` succeeds, the Zig core starts a debounced filesystem watcher for the repository root. When the watcher sees a relevant file change, the core sends a `repository/changed` JSON-RPC notification. Electron forwards that notification through the existing `core:event` channel. The renderer handles it by refreshing the changed-file list and marking the currently displayed diff as stale.

## Renderer State

The Vue app starts in `app/src/main.ts`, installs Pinia, and renders `App.vue`.

`App.vue` wires the two main stores to the page:

- `useRepoStore()` owns app version, current repository, changed files, active file, loading, and errors.
- `useDiffStore()` owns the current diff model, view mode, context mode, synchronized scrolling, grammar install state, and diff errors.

The main user flow is:

1. The top bar emits `open-repository`.
2. `repo.pickAndOpenRepository()` asks Electron for a directory.
3. `repo.openRepository(path)` sends `openRepository`, then `listChangedFiles`.
4. The first changed file becomes `activeFileId`.
5. `App.vue` watches `activeFileId` and calls `diff.loadDiff(fileId)`.
6. `diff.loadDiff()` sends `getDiffRenderModel` with the current view/context options.
7. `DiffViewer.vue` renders the returned rows.

Once a repository is open, filesystem changes under the repository root trigger the same changed-file refresh path without reopening the repository. The repo store preserves the active file when it is still present, selects the first changed file when it is not, and increments `changeRevision`. If the same file is already displayed, `App.vue` marks the diff as having new changes rather than reloading it. The user can then click `Load latest` in the diff header to replace the displayed model.

## Core Entry Points

`core/src/main.zig` delegates to `core/src/app/cli.zig`.

The CLI supports several commands:

- `diffuse version` prints the app name and version.
- `diffuse rpc` starts the JSON-RPC server used by Electron.
- `diffuse files --repo <path>` prints changed files as JSON.
- `diffuse diff --repo <path> --file <path>` prints a diff render model as JSON.

The desktop app uses only `diffuse rpc`.

## Core RPC Server

`core/src/app/rpc_server.zig` reads newline-delimited JSON-RPC requests from `stdin`. For each valid line it parses a request, dispatches it to a registered handler, and writes one response line to `stdout`.

The server keeps shared runtime state in `core/src/app/rpc_runtime.zig`:

- `session` stores the currently opened repository.
- `session_lock` protects repository session access.
- `syntax_cache` stores dynamically loaded Tree-sitter parser libraries and queries.
- `syntax_cache_lock` protects the syntax cache.
- `repo_watcher` watches the opened repository and emits `repository/changed` notifications.
- `outbound` queues JSON response and event messages for the writer task.

Requests can run concurrently. Responses and notifications are serialized through the outbound queue so only the writer task writes to `stdout`.

Handlers are registered in `core/src/app/rpc_handlers.zig`:

- `getVersion` returns static version info from `protocol/types.zig`.
- `openRepository` opens a Git repository and stores it in the session.
- `listChangedFiles` reads changed files from the current repository.
- `getDiffRenderModel` builds rows for one file diff.
- `getSyntaxSpans` returns highlighted spans for a line range.
- `installTreeSitterGrammar` clones/builds a grammar and emits progress events.

## Repository Model

`core/src/core/repository.zig` is the Git boundary.

Opening a repository runs:

- `git -C <path> rev-parse --show-toplevel`
- `git -C <root> rev-parse --short HEAD`

Changed files are assembled from:

- `git status --porcelain=v1 -uall` for paths and status.
- `git diff --numstat` for addition/deletion counts.

Each changed file gets an `id`. Today the ID is the new path, and that same value is used as the path when requesting a diff or syntax spans.

## Diff Pipeline

`core/src/core/diff.zig` builds a `DiffRenderModel` for a file.

For diff-only mode it runs:

```text
git diff -- <path>
```

For full-file context mode it runs:

```text
git diff -U999999 -- <path>
```

The resulting unified diff is parsed into rows:

- `hunk` rows for `@@ ... @@` headers.
- `context` rows for unchanged lines in a hunk.
- `deleted` rows for old-side lines.
- `added` rows for new-side lines.

Each row carries old/new line numbers and old/new text where applicable. `core/src/protocol/types.zig` converts the Zig model into the camelCase JSON shape used by TypeScript in `app/src/lib/protocol.ts`.

## Syntax Highlighting

Syntax highlighting is deliberately split into two phases.

First, `getDiffRenderModel` only returns syntax status:

- detected language
- whether the grammar is installed
- parser path
- highlight query path
- missing reason, if any

It does not eagerly highlight the entire diff.

Second, `DiffViewer.vue` requests syntax spans lazily for visible line ranges. It uses `@tanstack/vue-virtual` to render only visible rows and queues `getSyntaxSpans` requests in pages of 128 lines. Visible pages are high priority; lookahead/prefetch pages are lower priority.

`getSyntaxSpans` asks the core for either the old or new side:

- Old side source comes from `git show :<path>`.
- New side source comes from the working tree file.

The core highlights only the requested range, with extra context for languages that use Tree-sitter injections. The syntax cache keeps dynamic libraries and compiled queries loaded across requests.

`HighlightedCode.vue` maps returned Tree-sitter scopes to inline styles for display.

## Grammar Installation

If a file language is detected but no grammar is installed, the UI shows an install action.

`installTreeSitterGrammar` resolves install metadata from `core/src/core/tree_sitter_registry.json`. The core then:

1. Creates grammar and source directories.
2. Clones the grammar repository.
3. Checks out the pinned revision.
4. Optionally runs `tree-sitter generate`.
5. Runs `tree-sitter build` to create the parser library.
6. Installs a highlights query.
7. Installs an injections query when available.

During this process, the core sends JSON-RPC notifications like:

```json
{"jsonrpc":"2.0","method":"treeSitter/installProgress","params":{"language":"typescript","step":"Building parser library"}}
```

Electron forwards these notifications to the renderer via `core:event`. `useDiffStore()` listens for `treeSitter/installProgress` events and updates the install status if the event language matches the current file.

The grammar root is resolved from `DIFFUSE_GRAMMARS_DIR` when set. Otherwise it defaults to `$HOME/.diffuse/grammars` from RPC/CLI callers that provide an environment map.

## Build Wiring

The Zig core is built from `core/build.zig`. It produces an executable named `diffuse` and imports the `tree-sitter` Zig dependency.

The Electron app is configured in `app/electron.vite.config.ts` with separate builds for:

- Electron main: `app/electron/main.ts`
- Electron preload: `app/electron/preload.ts`
- Renderer: `app/index.html` and `app/src/main.ts`

Useful commands:

```sh
cd core && zig build
cd app && pnpm dev
cd app && pnpm build
```

For development, build the core first so `app/electron/coreProcess.ts` can find `core/zig-out/bin/diffuse`.

## End-to-End Request Example

Opening a repository and viewing a diff crosses the system like this:

```text
TopBar click
  -> repo.pickAndOpenRepository()
  -> window.diffuse.pickRepository()
  -> ipcMain repo:pickDirectory
  -> native directory dialog
  -> repo.openRepository(path)
  -> window.diffuse.coreRequest('openRepository', { path })
  -> ipcMain core:request
  -> CoreRpcClient writes JSON line to diffuse rpc stdin
  -> rpc_handlers.openRepository()
  -> Session.openRepository()
  -> repository.open()
  -> git rev-parse calls
  -> JSON-RPC response
  -> repo.listChangedFiles()
  -> activeFileId changes
  -> App.vue watcher
  -> diff.loadDiff(fileId)
  -> getDiffRenderModel
  -> git diff parsing
  -> DiffViewer renders virtualized rows
  -> visible rows trigger getSyntaxSpans pages
  -> HighlightedCode renders syntax spans
```
