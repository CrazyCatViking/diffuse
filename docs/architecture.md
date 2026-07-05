# Diffuse Architecture

This document gives internal contributors a high-level map of how Diffuse is put together. Keep it current when feature work changes process boundaries, data flow, persistence, or major UI/core responsibilities.

## System Shape

Diffuse is split into two cooperating programs:

- `core/` is a Zig executable named `diffuse`. It owns Git access, repository session state, diff parsing, Tree-sitter syntax work, LSP sessions, review persistence, and JSON-RPC handling.
- `app/` is an Electron/Vue desktop app. It owns windows, dialogs, UI state, rendering, settings, provider adapters, and communication with the core process.

The app talks to the core over line-delimited JSON-RPC on each core process `stdin` and `stdout`. Diffuse uses one Electron app process with one Zig core process per open window, so multiple repositories can be reviewed independently without starting multiple Electron app processes.

```text
Vue renderer
  -> window.diffuse preload bridge
  -> Electron ipcMain handlers
  -> CoreRpcClient
  -> spawned Zig process: core/zig-out/bin/diffuse rpc
  -> Zig RPC server
  -> repository, diff, syntax, LSP, review modules
```

## Electron Boundary

The renderer never imports Node APIs directly. `app/electron/preload.ts` exposes a small `window.diffuse` bridge with capabilities such as:

- `pickRepository()` asks Electron main to show a native directory picker.
- `coreRequest(method, params)` sends a whitelisted request to the Zig core.
- `onCoreEvent(listener)` subscribes to core notifications such as repository changes and Tree-sitter install progress.

`app/electron/main.ts` creates browser windows, owns one `CoreRpcClient` per window, and registers IPC handlers.

The main process disables Electron's default application menu before creating windows. It also blocks Chromium/Electron reserved keyboard defaults such as reload, zoom, devtools, fullscreen, and browser back/forward before they reach the page. Window chrome should stay owned by the operating system and Diffuse's renderer UI rather than Electron's built-in menu template.

The renderer owns keyboard defaults outside editable controls. `App.vue` lets app-level shortcuts and `useCursorStore()` process key events first, then prevents any remaining browser default for non-text-entry targets so DOM focus traversal, page scrolling, and native browser navigation cannot compete with the app cursor model. Inputs, textareas, selects, and contenteditable elements keep native text-editing behavior.

`app/electron/coreProcess.ts` resolves the core executable in this order:

- `DIFFUSE_CORE_EXECUTABLE` when set and pointing at an existing file.
- Development build paths such as `core/zig-out/bin/diffuse`.
- Native Electron package resources under `process.resourcesPath`.
- Installed core under `DIFFUSE_INSTALL_ROOT` or `~/.local/share/diffuse/core/diffuse`.

It also resolves the Tree-sitter registry directory from `DIFFUSE_TREE_SITTER_REGISTRY_DIR`, nearby development checkouts named `diffuse-tree-sitter`, or `~/.diffuse/tree-sitter`.

Each window's core is spawned as:

```text
diffuse rpc
```

`app/electron/coreRpcClient.ts` wraps a child process. Each request is serialized as a single JSON line:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "listChangedFiles", "params": {} }
```

The client tracks pending requests by numeric `id`, resolves them when a matching response line arrives, and emits messages without an `id` as events. Timeouts are applied per method. Most timed-out requests kill and restart that window's core; `getSyntaxSpans` can time out without killing the process.

The renderer and Electron process share the TypeScript contract in `app/src/lib/coreContract.ts`. That file defines the `CoreMethods` param/result map, the runtime `coreMethodNames` list used by Electron's whitelist, and the typed core event union consumed by the renderer. Zig remains the runtime authority for validation; TypeScript contracts keep the frontend, preload bridge, and Electron whitelist synchronized.

`scripts/check-rpc-contract.mjs` compares Zig `server.handle(...)` registrations in `core/src/app/*_handlers.zig` with `coreMethodNames` in `app/src/lib/coreContract.ts`. It runs as part of `just build` and `pnpm build` so app/core method drift fails verification early.

Core maps JSON-RPC failures to standard error classes where possible:

- `-32700` for parse errors, returned with `id: null`.
- `-32601` for unknown methods.
- `-32602` for invalid or missing params.
- `-32000` for domain/runtime failures.

RPC params are validated at the core boundary. Omitted optional fields may still use documented defaults, but present invalid enum values or invalid field types are rejected as invalid params. This includes diff `mode`, diff `context`, syntax/LSP `side`, unsigned line/column values, and `DiffTarget` fields.

The Electron RPC client preserves `error.code`, `error.message`, and optional `error.data` in `CoreRpcError`.

Electron uses `app.requestSingleInstanceLock()`. A second `diffuse <path>` invocation is delivered to the existing Electron process through the `second-instance` event, and the main process opens a new `BrowserWindow` with its own core process for that repository.

## Renderer State

The Vue app starts in `app/src/main.ts`, installs Pinia and Vue Router with memory history, and renders `App.vue`.

The main page is organized around stores:

- `useRepoStore()` owns app version, current repository, changed files, active file, loading, and errors.
- `useDiffStore()` owns the current diff model, view mode, context mode, synchronized scrolling, grammar install state, and diff errors.
- `useSearchStore()` owns the renderer-side search query, mode, active filters, grouped results, global palette state, pinned drawer snapshot state, and selected result cursors.
- `useCursorStore()` owns persisted cursor surface state, the active surface id, currently mounted/open surface handlers, geometry-based surface movement, global cursor key parsing, and recorded cursor-position history.

`App.vue` owns the shell around the workspace: top bar, repository picker, settings dialog, changed-file tree, pinned search drawer, global keyboard suppression, and search result routing. The main workspace surface is route-driven through `<RouterView />`. Routes live in `app/src/routes.ts` and currently cover review overview, single-file diff, and folder diff. Routed views read store-backed state directly instead of receiving repository, diff, review, and target state through `App.vue` props.

Cursor surfaces are registered by the mounted Vue components that render them. `ChangedFilesPane.vue`, `DiffViewer.vue`, `SearchResultsDrawer.vue`, `ReviewOverviewView.vue`, and `FolderDiffViewer.vue` each register a surface id, persisted position state, live rectangle lookup, and optional motion/command handlers. The cursor store keeps the persisted surface state in a plain map even after a surface unmounts, while a separate mounted-surface set decides which surfaces participate in geometry-based movement. Surface ids encode enough route information for restoration, such as `diff:<encoded file id>:old`, `diff:<encoded file id>:new`, and `folder-diff:<encoded folder path>`.

Single-file diffs keep their row/column/side cursor math in `useDiffCursor()`, but keyboard dispatch is global through `useCursorStore()`. Diff views register side-specific surfaces for the old and new sides that exist in the rendered model. App surface movement remains separate from diff-side movement: `<C-w>h` and `<C-w>l` move between cursor surfaces and skip the opposite side of the same file, while the dedicated diff-side actions move between old and new sides inside the current diff. Surface movement into an already visible diff restores the old cursor only when it is still visible without scrolling. Reopening a previously opened file restores the cursor location and lets the diff viewer reveal that line instead of restoring an exact scroll offset, while opening a new file starts at the top and prefers the new side in split mode. Significant diff motions record cloned surface snapshots into the cursor store's position history so `<C-o>` and `<C-i>` can restore earlier positions, with multiple entries per file and side and route restoration back to the owning file when the target surface is not currently mounted.

Workspace route helpers live in `app/src/lib/workspaceRoutes.ts`. They normalize route names, catch-all file/folder path params, search-result reveal query parameters, and sidebar path sorting so route-producing surfaces use the same conventions.

The main user flow is:

1. The top bar emits `open-repository`.
2. `repo.pickAndOpenRepository()` asks Electron for a directory.
3. `repo.openRepository(path)` sends `openRepository`, then `listChangedFiles`.
4. `App.vue` routes the workspace to the review overview for the opened repository.
5. Selecting a file or folder updates the workspace route.
6. `DiffViewer.vue` watches the file route param and calls `diff.loadDiff(fileId)`.
7. `diff.loadDiff()` sends `getDiffRenderModel` with the current view/context options.
8. `DiffViewer.vue` renders the returned rows.

Changed-file search is split by surface. `ChangedFilesPane.vue` keeps a local renderer-backed sidebar query/filter state so command-palette searches do not filter the file tree. `SearchPalette.vue` and `SearchResultsDrawer.vue` share the palette result model for file/path hits, full changed-file content hits, comments, and pinned result walking. Palette execution is core-backed: `useSearchStore()` keeps query text, mode, filters, selected index, history, and drawer state locally, then starts a debounced `startSearch` RPC and batches streamed `search/results` notifications for the active `searchId` into renderer updates. Pinning creates an independent frozen result snapshot with its own selected index and removed-result set; later streamed chunks and later searches do not mutate the pinned drawer. The pinned drawer virtualizes its tree rows through `TreeList.vue` so large snapshots only mount visible rows plus overscan. The renderer cancels stale searches with `cancelSearch` and ignores events whose `searchId` no longer matches. Symbol extraction is not implemented yet and currently returns no streamed results.

Core search lives in `core/src/core/search.zig` and `core/src/app/search_handlers.zig`. The core parses forgiving query/filter syntax, applies file metadata filters, ranks deterministic flat result phases, loads reviewed/comment metadata for the supplied review `sessionId`, and scans full changed-file source text directly through `diff.sourceForSide()` instead of `getDiffRenderModel`. Content side selection follows review expectations: added, modified, and renamed files search the new side; deleted files search the old side. Large or binary sources are skipped before scanning. Results stream in ordered batches through `search/results`, with `search/progress`, `search/done`, `search/cancelled`, and `search/error` notifications reporting lifecycle state.

Once a repository is open, filesystem changes under the repository root trigger a changed-file refresh without reopening the repository. If the same file is already displayed, the UI marks the diff as stale and lets the user load the latest version.

The repository watcher currently runs on Linux. Normal repository file changes emit `repository/changed` with changed relative paths. Changes under `.diffuse/reviews` emit `review/changed`, which causes the renderer to refresh review sessions, progress, runs, agent state, threads, and chat messages.

## Core Entry Points

`core/src/main.zig` delegates to `core/src/app/cli.zig`.

The CLI supports commands such as:

- `diffuse version` prints the app name and version.
- `diffuse rpc` starts the JSON-RPC server used by Electron.
- `diffuse files --repo <path>` prints changed files as JSON.
- `diffuse diff --repo <path> --file <path>` prints a diff render model as JSON.

The desktop app uses `diffuse rpc`.

## Core RPC Runtime

`core/src/app/rpc_server.zig` reads newline-delimited JSON-RPC requests from `stdin`. For each valid line it parses a request, dispatches it to a registered handler, and writes one response line to `stdout`.

The server keeps shared runtime state in `core/src/app/rpc_runtime.zig`:

- `session` stores the currently opened repository.
- `session_lock` protects repository session access.
- `review_lock` serializes review persistence writes and read-modify-write updates under `.diffuse/reviews`.
- `search_lock`, `search_jobs`, and `search_group` own active core search jobs and cooperative cancellation state.
- `syntax_cache` stores dynamically loaded Tree-sitter parser libraries and queries.
- `syntax_cache_lock` protects the syntax cache.
- `repo_watcher` watches the opened repository and emits `repository/changed` or `review/changed` notifications on Linux.
- `outbound` queues JSON response and event messages for the writer task.
- `lsp_manager` owns persistent language server sessions.

Requests can run concurrently. Responses and notifications are serialized through the outbound queue so only the writer task writes to `stdout`.

`core/src/app/rpc_handlers.zig` coordinates domain handler registration. Handler implementations are split by responsibility:

- `repository_handlers.zig` owns version, repository open, branch, target-default, and changed-file RPCs.
- `diff_handlers.zig` owns diff render model RPCs.
- `syntax_handlers.zig` owns syntax span and Tree-sitter grammar RPCs.
- `lsp_handlers.zig` owns language-server status, install, hover, diagnostics, and restart RPCs.
- `review_handlers.zig` owns review persistence and agent review state RPCs.
- `search_handlers.zig` owns `startSearch`, `cancelSearch`, and background search job lifecycle.
- `rpc_params.zig` owns shared parameter parsing, JSON conversion, diff target parsing, grammar-root resolution, and review ID validation helpers used by handlers.
- `rpc_events.zig` owns shared event/progress emitters.
- `rpc_repo.zig` owns short-lived repository snapshots used to copy stable repository root/head data under `session_lock` before handlers perform expensive work.

Handlers should avoid holding `session_lock` while running Git, parsing diffs, resolving source text, highlighting, or doing review filesystem work. The normal pattern is to snapshot the opened repository under `session_lock`, release the lock, and then use the snapshot for path/root data. Review write/update handlers acquire `review_lock` after snapshotting so review persistence remains serialized without blocking unrelated session readers.

Important methods include:

- `getVersion`
- `openRepository`
- `getDiffTargetDefaults`
- `listBranches`
- `listChangedFiles`
- `getDiffRenderModel`
- `getSyntaxSpans`
- `getLspConfigInfo`, `getLspStatus`, `getLspHover`, `getLspDiagnostics`, `installLspServer`, and `restartLspServer`
- `installTreeSitterGrammar`
- `listTreeSitterGrammars`, `syncTreeSitterRegistry`, and `uninstallTreeSitterGrammar`
- review/session persistence methods described in [`review-spec-v1.md`](review-spec-v1.md)
- LSP methods described in [`lsp.md`](lsp.md)

## Repository And Diff Pipeline

`core/src/core/repository.zig` is the Git boundary.

Opening a repository runs:

- `git -C <path> rev-parse --show-toplevel`
- `git -C <root> rev-parse --short HEAD`

Changed files are assembled from `git diff` for the active `DiffTarget`:

- `git diff --name-status -M` for paths and status.
- `git diff --numstat` for addition/deletion counts.

The target supports two shapes:

- Ref comparison: `base` and `compare` are set, and the core runs `git diff <base> <compare>`.
- Working tree comparison: `compare` is unset, and `includeStaged`/`includeUnstaged` decide whether the core compares the base ref, the index, the working tree, or no files.

Default targets come from repository state. Dirty repositories use working tree changes against `HEAD`. Clean repositories compare `HEAD` against the configured upstream when available, then `origin/main`, `origin/master`, or `HEAD`.

`core/src/core/diff.zig` builds a `DiffRenderModel` for a file.

For diff-only mode it runs the active target through:

```text
git diff <target args> -- <path>
```

For full-file context mode it runs:

```text
git diff -U999999 <target args> -- <path>
```

The resulting unified diff is parsed into rows:

- `hunk` rows for `@@ ... @@` headers.
- `context` rows for unchanged lines in a hunk.
- `deleted` rows for old-side lines.
- `added` rows for new-side lines.

Each row carries old/new line numbers and old/new text where applicable. After parsing, the core enriches the row model with a conservative diff intelligence pass:

- Adjacent deleted/added blocks are paired as replacement candidates in `annotations.linePairs`.
- Paired replacement lines receive `oldDiffSpans` and `newDiffSpans` token ranges for inserted, deleted, replaced, or whitespace-only text.
- Exact normalized deleted/added runs that are far enough apart are marked as `moved-block` groups in `annotations.changeGroups`; their rows receive `changeGroupId`, `changeRole`, and `changeConfidence`.
- Similar far-apart deleted/added runs are marked as `moved-and-edited-block` when token LCS scoring shows enough shared structure but not exact normalized equality.
- When an installed Tree-sitter grammar is available, the core parses old and new source text and annotates rows with the innermost structural symbol containing each changed line. Git hunk function context remains the fallback when parsing is unavailable, too large, or fails.
- Rows sharing a symbol are grouped as `symbol-change` annotations where available.
- Lightweight semantic classifiers add conservative groups for identifier renames, formatter-only changes, import reorders, wrapper additions, likely extract/inline operations, call-site argument changes, condition changes/inversions, return-value changes, assignment changes, and control-flow additions/removals.
- A bounded target-wide diff scan adds `cross-file-move` hints when significant old/new lines match across different paths.
- `annotations.anchorRemaps` contains advisory old-line to new-line mapping hints for replacements, moves, moved-and-edited lines, renames, and cross-file moves. These hints help future review/comment remapping, but they do not mutate persisted review anchors.
- `annotations.columnUnit` is currently `utf16`; all diff token span columns are emitted as JavaScript string indexes rather than byte offsets so renderer slicing stays correct for non-ASCII text.

Git remains the correctness and fallback layer. These annotations explain relationships for review UI rendering, but they do not replace Git patch semantics or review anchors. The renderer converts token spans into inline highlights, moved rows into side accents, and available group/token metadata into native line tooltips. `core/src/protocol/types.zig` converts the Zig model into the camelCase JSON shape used by TypeScript in `app/src/lib/protocol.ts`.

The renderer requests diff models in two phases so large files can show quickly. The first `getDiffRenderModel` call uses `options.intelligence = "basic"`, which returns parsed Git rows without semantic enrichment. A background call with `options.intelligence = "full"` computes token spans, move detection, structural symbols, semantic groups, cross-file hints, and anchor remaps, then replaces the displayed model if the user is still looking at the same file/target state. Single-file and folder views keep bounded in-memory caches of full models keyed by repository root/head, diff target, file id, file diff signature, view mode, and context mode. Cache hits render the enriched model immediately; signature or target changes naturally select a different key.

Diff intelligence regression fixtures live under `core/src/testdata/diff-intelligence`. They cover renamed identifiers, moved blocks, moved-and-edited blocks, formatter-only changes, wrapper additions, import reorders, non-ASCII text, and larger rewrites. Core tests embed these fixtures so parsing and enrichment failures are caught by `zig build test`.

## Syntax Highlighting

Syntax highlighting is deliberately split into two phases.

First, `getDiffRenderModel` returns syntax status such as detected language, grammar availability, parser path, query path, and missing reason. It does not eagerly highlight the entire diff.

Second, `DiffViewer.vue` requests syntax spans lazily for visible line ranges. It uses `@tanstack/vue-virtual` to render only visible rows and queues `getSyntaxSpans` requests in pages for the viewport plus a small lookaround window. The single-file viewer only builds rendered row models, markers, totals, and syntax requests for the active pane layout: synchronized split, desynchronized old/new panes, or inline. Row model construction is target-aware so split, pane, and inline modes do not construct unused old/new/inline code-line models. Syntax pages are cached per rendered file with bounded eviction so scrolling a very large file does not retain the entire file's highlight data in the renderer.

`getSyntaxSpans` asks the core for either the old or new side. Source resolution follows the active target: refs for branch comparisons, the index for staged/unstaged boundaries, and the working tree for working-tree new-side content.

The core highlights only the requested range, with extra context for languages that use Tree-sitter injections. Syntax handlers resolve repository source text and prepare the requested line chunk before taking `syntax_cache_lock`; the lock protects the dynamic parser/query cache during highlighting instead of serializing repository IO. The syntax cache keeps dynamic libraries and compiled queries loaded across requests, and syntax span grouping/deduping should stay sorted/linear rather than scanning all spans once per output line.

## LSP Integration

Diffuse can show hover information and diagnostics in diffs. LSP configuration and lifecycle details live in [`lsp.md`](lsp.md).

At a high level:

- The app exposes settings and UI actions for language servers.
- The core owns server configuration, process lifecycle, hover requests, diagnostics, install metadata, and session restarts.
- Diagnostics describe the new side of a diff because that is the code that will exist after the change.

LSP sessions are keyed by repository, language, and server id. The core opens or updates in-memory documents for the source side requested by the UI, then asks for hover or diagnostics. Server sessions persist until restart, process exit, or core shutdown.

## Review Persistence And Agent Review

Review state is stored in the opened repository under `.diffuse/reviews`. The data format is documented in [`review-spec-v1.md`](review-spec-v1.md).

The desktop app can start built-in opencode review runs for the active session. Zig core owns review run state in `runs/<agent-run-id>.json`. Electron acts as the opencode provider adapter: it starts opencode through `@opencode-ai/sdk`, creates opencode sessions for the repository directory, sends review prompts asynchronously, and reports status changes back to core.

Review data is intentionally plain JSON and Markdown so external agent harnesses can inspect or update it without linking against Diffuse.

Review IDs that become path segments are validated by the core before path construction. Session ids, thread ids, run ids, agent-run ids, and chat message ids must be non-empty path segments containing only ASCII letters, digits, `.`, `_`, and `-`, with no separators or traversal names.

Manual review comments and AI chat use the same persisted review files. The renderer creates human threads for line/selection comments, writes chat messages for user questions, and asks the Electron provider adapter for opencode responses when the user asks AI about a thread or selection.

The opencode runner writes review prompts under `.diffuse/reviews/sessions/<session-id>/prompts/`, writes temporary opencode tool definitions under `.opencode/tools/`, and starts a localhost bridge that validates tool calls before forwarding them to core RPC methods.

## Tree-Sitter Grammar Installation

If a file language is detected but no grammar is installed, the UI can show an install action.

`installTreeSitterGrammar` resolves install metadata from `core/src/core/tree_sitter_registry.json`. The core clones the grammar repository, checks out the pinned revision, optionally runs `tree-sitter generate`, builds the parser library, and installs highlight/injection queries.

During installation, the core sends JSON-RPC notifications like:

```json
{
  "jsonrpc": "2.0",
  "method": "treeSitter/installProgress",
  "params": { "language": "typescript", "step": "Building parser library" }
}
```

Electron forwards these notifications to the renderer via `core:event`.

Settings can also list installed/available grammars, sync the external registry, and uninstall a grammar. Uninstalling a grammar removes it from the syntax cache before deleting installed files.

## App-Local State

The renderer keeps small UI preferences in browser local storage:

- Recent repositories under `diffuse.recentRepositories`, capped at 10 entries.
- File tree width under `diffuse.fileTreeWidth`.
- Syntax theme id under `diffuse.syntaxTheme`.
- Custom syntax colors under `diffuse.customSyntaxTheme`.
- Single-file diff keybindings under `diffuse.diffKeybindings.v1`.
- Last opened settings section under `diffuse.settings.activeSection`.

This state is UI convenience data only. Review sessions and agent state are stored in the opened repository under `.diffuse/reviews`.

## Build Wiring

The Zig core is built from `core/build.zig`. It produces an executable named `diffuse`.

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

Prebuilt release packaging is separate from source installation. `just install` continues to build from source and run `scripts/install.sh` or `scripts/install.ps1`. The native release path runs `app/scripts/prepare-electron-package.mjs` after the app build, copies the already-built Zig core into Electron resources, and then runs `electron-builder` through `pnpm dist`. Release artifacts are archives only: Linux `tar.gz`, macOS `zip`, and Windows `zip`.

Release installers in `scripts/install-release.sh` and `scripts/install-release.ps1` do not clone the repository. They resolve the requested GitHub Release, download the platform artifact, install the packaged app into the user environment, and create a command shim. The shim launches the Electron app for normal desktop usage and calls the bundled Zig core for CLI subcommands.

The built-in Zig CLI update/install commands also use GitHub Releases. `list-versions` reads release tags from the GitHub Releases API, `update` selects the newest release, and `install <version>` refuses versions that are not releases. Installing a non-release commit or branch is intentionally only available from a checked-out source tree through `just install`.

`just publish` updates version files, commits, tags, and pushes the tag. `.github/workflows/release.yml` is triggered by `v*` tags, builds the Zig core and Electron app on Linux, macOS, and Windows runners, uploads the archive artifacts, and creates the GitHub Release.
