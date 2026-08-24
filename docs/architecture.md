# Diffuse Architecture

This document gives internal contributors a high-level map of how Diffuse is put together. Keep it current when feature work changes process boundaries, data flow, persistence, or major UI/core responsibilities.

This document describes the current implementation. The proposed single-window Electron/Vue workbench, application-wide Rust core, N-API boundary, multi-workspace attention model, ACP integration, and migration sequence are specified in [`agent-workbench-design.md`](agent-workbench-design.md). Update this document phase by phase as that design becomes implemented behavior.

## System Shape

Diffuse currently has two complete core implementations behind the same desktop JSON-RPC contract:

- `core/` is the packaged Zig executable named `diffuse`. It owns Git access, repository session state, diff parsing, Tree-sitter syntax work, LSP sessions, review persistence, and JSON-RPC handling.
- `crates/diffuse-core/` is the transport-neutral Rust `AppCore`. It owns durable multi-workspace identity and lifecycle, Git and diff operations, review persistence, search, event-driven watching, LSP sessions, syntax management, and SQLite workbench state.
- `crates/diffuse-cli/` exposes the complete Rust core through the temporary line-delimited JSON-RPC executable seam used by development and differential testing.
- `app/` is an Electron/Vue desktop app. It owns windows, dialogs, UI state, rendering, settings, provider adapters, and communication with the core process.

The app talks to the selected core over line-delimited JSON-RPC on each core process `stdin` and `stdout`. Diffuse creates one primary Electron window and currently uses one selected core process per open workspace. Electron main owns the transitional workspace registry, so multiple repositories remain independently addressable while only one workspace is rendered. The Rust library itself supports all workspaces in one `AppCore`; Electron begins using that application-wide instance at the Phase 4 N-API boundary.

Development executable discovery prefers `target/debug/diffuse`, then falls back to `core/zig-out/bin/diffuse`. Packaged releases still include and select Zig. `DIFFUSE_CORE_EXECUTABLE` overrides discovery. Selection always applies to the complete workspace backend; method-level Zig/Rust proxying is unsupported.

```text
Vue renderer
  -> renderer-owned DesktopBridge implemented by window.diffuse preload bridge
  -> Electron ipcMain handlers
  -> LegacyWorkspaceRegistry
  -> workspace-owned CoreRpcClient
  -> workspace-owned selected process: target/debug/diffuse rpc or core/zig-out/bin/diffuse rpc
  -> Rust or Zig RPC server
  -> repository, diff, syntax, LSP, review modules
```

## Electron Boundary

The renderer never imports Node APIs directly. `app/electron/preload.ts` exposes a small `window.diffuse` bridge with capabilities such as:

- `pickRepository()` asks Electron main to show a native directory picker.
- `openWorkspace(path)` creates or activates a canonical Git-worktree workspace.
- `workspaceRequest(context, method, params)` sends a whitelisted request with an explicit workspace ID, generation, and request ID.
- `getWorkbenchSnapshot()` restores open workspace summaries and the active workspace after renderer recreation.
- `onWorkbenchEvent(listener)` subscribes to validated workspace lifecycle and workspace-tagged core events.

`app/electron/main.ts` creates at most one primary `BrowserWindow`, owns the application-wide legacy workspace registry, and registers validated IPC handlers. `app/electron/legacyWorkspaceRegistry.ts` maps each ready workspace to one selected `CoreRpcClient`, canonicalizes returned Git roots for deduplication, and assigns an opaque facade workspace ID plus a new generation for every close/reopen lifetime. The facade IDs remain stable only for the running application. Rust also persists its own stable IDs across restarts; Electron will consume those identities directly after the Phase 4 N-API cutover.

The registry checks identity before and after every awaited request. Closing a workspace marks it unavailable before disposing its process, immediately rejects pending client requests, and prevents delayed results or events from the closed generation from being forwarded. If a fatal request timeout restarts a workspace core, the registry reopens that workspace root before retrying the request. Registry events carry a monotonically increasing in-memory sequence, event ID, workspace ID, workspace generation, kind, and payload.

The main process disables Electron's default application menu before creating windows. It also blocks Chromium/Electron reserved keyboard defaults such as reload, zoom, devtools, fullscreen, and browser back/forward before they reach the page. Window chrome should stay owned by the operating system and Diffuse's renderer UI rather than Electron's built-in menu template.

The renderer owns keyboard defaults outside editable controls. `App.vue` lets app-level shortcuts and `useCursorStore()` process key events first, then prevents any remaining browser default for non-text-entry targets so DOM focus traversal, page scrolling, and native browser navigation cannot compete with the app cursor model. Inputs, textareas, selects, and contenteditable elements keep native text-editing behavior.

`app/electron/coreProcess.ts` resolves the core executable in this order:

- `DIFFUSE_CORE_EXECUTABLE` when set and pointing at an existing file.
- Rust development paths such as `target/debug/diffuse`, followed by Zig development paths such as `core/zig-out/bin/diffuse`.
- Native Electron package resources under `process.resourcesPath`.
- Installed core under `DIFFUSE_INSTALL_ROOT` or `~/.local/share/diffuse/core/diffuse`.

It also resolves the Tree-sitter registry directory from `DIFFUSE_TREE_SITTER_REGISTRY_DIR`, nearby development checkouts named `diffuse-tree-sitter`, or `~/.diffuse/tree-sitter`.

Each workspace's temporary selected core is spawned as:

```text
diffuse rpc
```

`app/electron/coreRpcClient.ts` wraps one raw core child process. Each request is serialized as a single JSON line:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "listChangedFiles", "params": {} }
```

The client tracks pending requests by numeric `id`, resolves them when a matching response line arrives, and emits only validated, known notifications as events. JSON-RPC errors with `id: null` use a separate error channel and are never forwarded as renderer events. Disposing a client rejects all pending requests immediately. Timeouts are applied per method. Most timed-out requests kill and restart that workspace's core; syntax and selected LSP read requests can time out without killing the process.

The renderer owns the shell-neutral `DesktopBridge` interface in `app/src/lib/desktopBridge.ts`; Electron preload implements that interface and exposes it as `window.diffuse`. `app/src/lib/coreContract.ts` is the shared raw method/event contract. `app/src/lib/workbenchContract.ts` defines the workspace-aware desktop facade: workspace references and request contexts, summaries and snapshots, contextual responses, lifecycle events, tagged core-event envelopes, and runtime validators. Required domain parameters remain required after workspace context is added. The selected core validates raw method parameters, while Electron validates facade method names and workspace/request identity.

`scripts/check-rpc-contract.mjs` rejects duplicate RPC names, compares Zig `server.handle(...)` registrations with both `coreMethodNames` and `CoreMethods`, and compares Zig event producers with both `coreEventNames` and `CoreEventMap`. It runs as part of `just build` and `pnpm build` so method-map and event-name drift fail verification early.

Core maps JSON-RPC failures to standard error classes where possible:

- `-32700` for parse errors, returned with `id: null`.
- `-32601` for unknown methods.
- `-32602` for invalid or missing params.
- `-32000` for domain/runtime failures.

RPC params are validated at the core boundary. Omitted optional fields may still use documented defaults, but present invalid enum values or invalid field types are rejected as invalid params. This includes diff `mode`, diff `context`, syntax/LSP `side`, unsigned line/column values, and `DiffTarget` fields.

The Electron RPC client preserves `error.code`, `error.message`, and optional `error.data` in `CoreRpcError`.

Electron uses `app.requestSingleInstanceLock()`. A second `diffuse <path>` invocation is delivered to the existing Electron process through the `second-instance` event. Main shows the existing primary window and asks the registry to add or activate the canonical workspace; it never creates another workspace window.

Closing the primary window hides it when the tray is available instead of disposing renderer-independent workspace runtimes. Tray Show and a second invocation restore and focus the same window. Only tray Quit or another explicit application quit sets the quitting state, allows window destruction, and disposes the review runner plus registry. If tray creation fails, close falls back to quitting rather than leaving an invisible process.

## Renderer State

The Vue app starts in `app/src/main.ts`, installs Pinia and Vue Router with memory history, and renders `App.vue`.

The main page is organized around stores:

- `useRepoStore()` owns app version, the active workspace reference, current repository, changed files, active file, loading, and errors.
- `useDiffStore()` owns the current diff model, view mode, context mode, synchronized scrolling, grammar install state, and diff errors.
- `useSearchStore()` owns the renderer-side search query, mode, active filters, grouped results, global palette state, pinned drawer snapshot state, and selected result cursors.
- `useCursorStore()` owns persisted cursor surface state, the active surface id, currently mounted/open surface handlers, geometry-based surface movement, global cursor key parsing, and recorded cursor-position history.
- `useWorkbenchStore()` owns ordered workspace summaries, the presentation-active workspace, event sequence, restore health, and bounded renderer-local UI records keyed by workspace ID.

The existing feature stores remain one active projection rather than one Pinia instance per workspace. `useWorkbenchStore()` retains compact route, diff-target/layout, search/pinned-result, cursor-history, review-draft, and logical-focus records in versioned local storage. Repository arrays, full diff models, review entities, live search streams, syntax/LSP state, timers, queues, and DOM registrations are cleared on switch and reloaded only for the active workspace. Renderer activation epochs prevent an A to B to A sequence from accepting work started during the first A presentation.

`App.vue` coordinates the shell around the workbench: top bar, workspace rail, settings, changed-file tree, pinned search drawer, switcher, keyboard commands, active-store capture/restore, and search-result routing. It captures compact outgoing state before activation, unmounts the heavy workspace surface, restores the incoming active projection, and mounts content only when the route workspace ID agrees with the loaded repository. A `pagehide` capture preserves current UI state across renderer reload.

Routes are `/workbench`, `/w/:workspaceId/review`, `/w/:workspaceId/file/:fileId`, and `/w/:workspaceId/folder/:folderPath`. Route producers require explicit workspace identity. Direct navigation to another known workspace activates it before rendering its saved route.

Cursor surfaces are registered by the mounted Vue components that render them. `ChangedFilesPane.vue`, `DiffViewer.vue`, `SearchResultsDrawer.vue`, `ReviewOverviewView.vue`, and `FolderDiffViewer.vue` each register a surface id, persisted position state, live rectangle lookup, and optional motion/command handlers. The cursor store keeps the persisted surface state in a plain map even after a surface unmounts, while a separate mounted-surface set decides which surfaces participate in geometry-based movement. Surface ids encode enough route information for restoration, such as `diff:<encoded file id>:old`, `diff:<encoded file id>:new`, and `folder-diff:<encoded folder path>`.

Single-file diffs keep their row/column/side cursor math in `useDiffCursor()`, but keyboard dispatch is global through `useCursorStore()`. Diff views register side-specific surfaces for the old and new sides that exist in the rendered model. App surface movement remains separate from diff-side movement: `<C-w>h` and `<C-w>l` move between cursor surfaces and skip the opposite side of the same file, while the dedicated diff-side actions move between old and new sides inside the current diff. Surface movement into an already visible diff restores the old cursor only when it is still visible without scrolling. Reopening a previously opened file restores the cursor location and lets the diff viewer reveal that line instead of restoring an exact scroll offset, while opening a new file starts at the top and prefers the new side in split mode. Significant diff motions record cloned surface snapshots into the cursor store's position history so `<C-o>` and `<C-i>` can restore earlier positions, with multiple entries per file and side and route restoration back to the owning file when the target surface is not currently mounted.

Workspace route helpers live in `app/src/lib/workspaceRoutes.ts`. They normalize route names, catch-all file/folder path params, search-result reveal query parameters, and sidebar path sorting so route-producing surfaces use the same conventions.

The main user flow is:

1. The top bar or rail opens the workspace switcher or native directory picker.
2. `useWorkbenchStore.openWorkspace(path)` sends the global command and records the returned summary in stable rail order.
3. `App.vue` restores that workspace's compact UI record and asks `useRepoStore()` to load target defaults, branches, and changed files under its explicit workspace identity.
4. The router restores the workspace's last review, file, or folder route, defaulting to review overview.
5. Selecting a file or folder updates the workspace route.
6. `DiffViewer.vue` watches the file route param and calls `diff.loadDiff(fileId)`.
7. `diff.loadDiff()` sends `getDiffRenderModel` with the current view/context options.
8. `DiffViewer.vue` renders the returned rows.

Changed-file search is split by surface. `ChangedFilesPane.vue` keeps a local renderer-backed sidebar query/filter state so command-palette searches do not filter the file tree. `SearchPalette.vue` and `SearchResultsDrawer.vue` share the palette result model for file/path hits, full changed-file content hits, comments, and pinned result walking. Palette execution is core-backed: `useSearchStore()` keeps query text, mode, filters, selected index, history, and drawer state locally, then starts a debounced `startSearch` RPC and batches streamed `search/results` notifications for the active `searchId` into renderer updates. Pinning creates an independent frozen result snapshot with its own selected index and removed-result set; later streamed chunks and later searches do not mutate the pinned drawer. The pinned drawer virtualizes its tree rows through `TreeList.vue` so large snapshots only mount visible rows plus overscan. The renderer cancels stale searches with `cancelSearch` and ignores events whose `searchId` no longer matches. Symbol extraction is not implemented yet and currently returns no streamed results.

Core search lives in `core/src/core/search.zig` for Zig and `crates/diffuse-core/src/search.rs` for Rust. The core parses forgiving query/filter syntax, applies file metadata filters, ranks deterministic flat result phases, loads reviewed/comment metadata for the supplied review `sessionId`, and scans full changed-file source text without constructing render models. Content side selection follows review expectations: added, modified, and renamed files search the new side; deleted files search the old side. Large or binary sources are skipped before scanning. Results stream in ordered batches through `search/results`, with `search/progress`, `search/done`, `search/cancelled`, and `search/error` notifications reporting lifecycle state.

Once a repository is open, filesystem changes under the repository root trigger a changed-file refresh without reopening the repository. Electron tags the raw event with its owning workspace ID and generation; renderer stores ignore events that do not belong to the active workspace. If the same file is already displayed, the UI marks the diff as stale and lets the user load the latest version.

The Rust repository watcher uses the cross-platform `notify` backend and registers non-ignored directories without recursively subscribing to generated or high-churn trees. Normal repository file changes emit `repository/changed` with changed relative paths. Changes under `.diffuse/reviews` emit `review/changed`, which causes the renderer to refresh review sessions, progress, runs, agent state, threads, and chat messages. Queue overflow, backend errors, and backend rescan flags trigger a conservative repository and review rescan. The packaged Zig watcher retains its platform-specific implementation until Zig is removed.

## Core Entry Points

`core/src/main.zig` delegates to `core/src/app/cli.zig`.

The CLI supports commands such as:

- `diffuse version` prints the app name and version.
- `diffuse rpc` starts the JSON-RPC server used by Electron.
- `diffuse files --repo <path>` prints changed files as JSON.
- `diffuse diff --repo <path> --file <path>` prints a diff render model as JSON.

The desktop app uses `diffuse rpc`.

## Rust Phase 3 Core

The root Cargo workspace contains the production core and CLI crates plus a native grammar test fixture:

- `diffuse-core` exposes the transport-neutral `AppCore`, `WorkspaceRegistry`, `WorkbenchDatabase`, bounded `EventHub`, repository operations, and domain DTOs. It has no Electron, N-API, or JSON-RPC dependency.
- `diffuse-cli` exposes a binary named `diffuse`. Its `rpc` command maps the legacy process-local repository protocol onto explicit Rust workspace request contexts only at this temporary transport boundary; its internal `syntax-runner` subcommand isolates optional native parsers.
- `diffuse-syntax-fixture` builds a real native grammar used only by isolation integration tests.

`AppCore` can load multiple repositories in one process. Opening resolves the Git worktree root, canonicalizes it for deduplication, obtains or creates its stable workspace UUID in SQLite, and creates a fresh generation UUID for that loaded lifetime. Repository work runs through Tokio blocking tasks without holding the registry lock. Requests resolve a workspace by both ID and generation; a close/reopen cycle therefore rejects stale contexts even though the durable workspace ID is reused.

The Rust event hub assigns monotonic process-local sequences, retains a bounded replay window, and reports when a requested sequence requires a snapshot. Live subscribers use bounded queues without losing or duplicating events when they lag beyond replay capacity. Domain records and SQLite remain authoritative rather than the event queue.

The Rust JSON-RPC compatibility adapter implements all 44 methods and forwards all 10 event families. It keeps stdout reserved for protocol output and preserves current error codes and omission of absent optional fields. Requests execute concurrently, while input size, queued requests, in-flight tasks, Git output, event replay, and subscriber queues are bounded. The selected executable owns the whole workspace backend. Method-level Zig/Rust fallback is intentionally unsupported.

Each `WorkspaceRuntime` owns its repository, review store, search coordinator, watcher, and repository-scoped LSP manager. Workspace summaries include repository-watcher health as `running`, `stopped`, or `failed`; unexpected worker or forwarding termination changes an accepting workspace to `degraded`, and subsequent snapshots expose that state. A close barrier rejects new work, waits for active durable operations, cancels owned searches, stops the watcher and LSP processes, and only then removes the runtime. Search coordinators are workspace-local, so cancelling an identifier in one workspace cannot cancel the same identifier in another. `AppCore::shutdown` drains every loaded workspace.

### Workbench Database

The Rust database defaults to the platform application-data directory as `workbench.sqlite3`. `DIFFUSE_WORKBENCH_DATABASE` overrides the path for tests and development. Connections enable foreign keys, a busy timeout, WAL mode, and transactional versioned migrations.

Each loaded database holds a cross-process shared recovery lock. Confirmed corruption is moved aside with its SQLite sidecars and replaced only after an exclusive lock proves that no other process is using the database. A failed sidecar move rolls the rename back. Schema versions newer than the binary supports are rejected without modifying or replacing the database. Tests launch a separate operating-system process to verify that the lifetime shared lock blocks exclusive recovery and that dropping the database releases it.

Schema migration v1 creates:

- `workspaces` and `app_state` for canonical roots, stable IDs, generations, rail order, open state, and active workspace.
- `workspace_ui_state` for future core-owned restoration snapshots.
- `agent_sessions`, `input_requests`, and `attention_items` for later Phase 5 and Phase 6 state machines.
- Supporting indexes and foreign-key cleanup rules.

Workspace lifecycle records are written today. The other tables establish the migration boundary but do not imply that durable attention or ACP behavior is implemented yet.

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
- `git diff --binary -- <path>` hashed with SHA-256 for each changed-file `signature`.

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

Each row carries old/new line numbers and old/new text where applicable. `getDiffRenderModel` is the cheap display path used by the renderer and is requested with `options.intelligence = "basic"` for interactive views. It returns parsed Git rows and syntax availability without running token, move, semantic, structural, cross-file, or background analysis.

The renderer composes display-only relationships from the returned rows. Adjacent deleted/added runs are paired into `modified` rows in `app/src/components/diff/reviewRows.ts`, and `app/src/components/diff/diffRenderedRows.ts` computes whole-token `diff-deleted` and `diff-inserted` highlights from the paired old/new text. These highlights are renderer state, not persisted review data and not part of the core JSON contract.

Git remains the correctness and fallback layer. The render model does not include analysis annotations, move groups, semantic groups, anchor remaps, or analysis cache state. `core/src/protocol/types.zig` converts the Zig model into the camelCase JSON shape used by TypeScript in `app/src/lib/protocol.ts`.

## Syntax Highlighting

Syntax highlighting is deliberately split into two phases.

First, `getDiffRenderModel` returns syntax status such as detected language, grammar availability, parser path, query path, and missing reason. It does not eagerly highlight the entire diff.

Second, `DiffViewer.vue` requests syntax spans lazily for visible line ranges. It uses `@tanstack/vue-virtual` to render only visible rows and queues `getSyntaxSpans` requests in pages for the viewport plus a small lookaround window. The single-file viewer only builds rendered row models, markers, totals, and syntax requests for the active pane layout: synchronized split, desynchronized old/new panes, or inline. Row model construction is target-aware so split, pane, and inline modes do not construct unused old/new/inline code-line models. Syntax pages are cached per rendered file with bounded eviction so scrolling a very large file does not retain the entire file's highlight data in the renderer.

`getSyntaxSpans` asks the core for either the old or new side. Source resolution follows the active target: refs for branch comparisons, the index for staged/unstaged boundaries, and the working tree for working-tree new-side content.

The core highlights only the requested range, with extra context for languages that use Tree-sitter injections. Syntax handlers resolve repository source text and prepare the requested line chunk before taking `syntax_cache_lock`; the lock protects the dynamic parser/query cache during highlighting instead of serializing repository IO. The syntax cache keeps dynamic libraries and compiled queries loaded across requests, and syntax span grouping/deduping should stay sorted/linear rather than scanning all spans once per output line.

The packaged Zig backend loads installed native parser libraries in its core process. The Rust backend instead validates parser and query paths in `AppCore`, then starts its own executable with the private `syntax-runner` subcommand. Only that bounded child loads optional native code, parses source, and returns syntax spans; malformed, oversized, failed, or timed-out runner output becomes an unavailable syntax result without loading the library into the RPC process.

## LSP Integration

Diffuse can show hover information and diagnostics in diffs. LSP configuration and lifecycle details live in [`lsp.md`](lsp.md).

At a high level:

- The app exposes settings and UI actions for language servers.
- The core owns server configuration, process lifecycle, hover requests, diagnostics, install metadata, and session restarts.
- Diagnostics describe the new side of a diff because that is the code that will exist after the change.

LSP sessions are keyed by repository, language, and server id. The core opens or updates in-memory documents for the source side requested by the UI, then asks for hover or diagnostics. Server sessions persist until restart, process exit, or core shutdown.

## Review Persistence And Agent Review

Review state is stored in the opened repository under `.diffuse/reviews`. The data format is documented in [`review-spec-v1.md`](review-spec-v1.md).

The desktop app can start built-in opencode review runs for the active session. Zig core owns review run state in `runs/<agent-run-id>.json`. Electron acts as the opencode provider adapter: it starts opencode through `@opencode-ai/sdk`, creates opencode sessions for the repository directory, sends review prompts asynchronously, and reports status changes back to core. During the workspace-facade migration, the legacy runner has one explicit workspace/generation owner at a time; cross-workspace start, stop, or chat calls are rejected rather than expanding its process-global bridge routing model.

Review data is intentionally plain JSON and Markdown so external agent harnesses can inspect or update it without linking against Diffuse.

Review IDs that become path segments are validated by the core before path construction. Session ids, thread ids, run ids, agent-run ids, and chat message ids must be non-empty path segments containing only ASCII letters, digits, `.`, `_`, and `-`, with no separators or traversal names.

Manual review comments and AI chat use the same persisted review files. The renderer creates human threads for line/selection comments, writes chat messages for user questions, and asks the Electron provider adapter for opencode responses when the user asks AI about a thread or selection.

The opencode runner writes review prompts under `.diffuse/reviews/sessions/<session-id>/prompts/`, writes temporary opencode tool definitions under `.opencode/tools/`, and starts a localhost bridge that validates tool calls before forwarding them to core RPC methods.

## Tree-Sitter Grammar Installation

If a file language is detected but no grammar is installed, the UI can show an install action.

`installTreeSitterGrammar` resolves install metadata from the shared registry embedded from `core/src/core/tree_sitter_registry.json`. The core clones the grammar repository, checks out the pinned revision, optionally runs `tree-sitter generate`, builds the parser library, and installs highlight/injection queries.

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

The Phase 3 Rust core is built from the root `Cargo.toml`. `cargo build --workspace` produces the compatibility executable at `target/debug/diffuse`; it is a development and parity artifact, not a packaged release artifact yet.

The Electron app is configured in `app/electron.vite.config.ts` with separate builds for:

- Electron main: `app/electron/main.ts`
- Electron preload: `app/electron/preload.ts`
- Renderer: `app/index.html` and `app/src/main.ts`

Useful commands:

```sh
(cd core && zig build)
cargo test --workspace --all-targets --locked
cargo build --workspace --locked
(cd app && pnpm dev)
(cd app && pnpm build)
```

For normal development, build the Cargo workspace so `app/electron/coreProcess.ts` finds `target/debug/diffuse`, then run `pnpm dev` from `app/`. Set `DIFFUSE_CORE_EXECUTABLE` to select a specific complete backend explicitly. Build Zig when testing the packaged path or running parity tests.

`just build` and CI run Rust formatting, strict Clippy, unit/integration tests, compilation, Zig tests/builds, the complete Zig/Rust method-event-persistence parity suite, RPC contract checks, and app checks. Release packaging continues to copy only the Zig executable until the Phase 4 N-API cutover is ready.

Prebuilt release packaging is separate from source installation. `just install` continues to build from source and run `scripts/install.sh` or `scripts/install.ps1`. The native release path runs `app/scripts/prepare-electron-package.mjs` after the app build, copies the already-built Zig core into Electron resources, and then runs `electron-builder` through `pnpm dist`. Release artifacts are archives only: Linux `tar.gz`, macOS `zip`, and Windows `zip`.

Release installers in `scripts/install-release.sh` and `scripts/install-release.ps1` do not clone the repository. They resolve the requested GitHub Release, download the platform artifact, install the packaged app into the user environment, and create a command shim. The shim launches the Electron app for normal desktop usage and calls the bundled Zig core for CLI subcommands.

The built-in Zig CLI update/install commands also use GitHub Releases. `list-versions` reads release tags from the GitHub Releases API, `update` selects the newest release, and `install <version>` refuses versions that are not releases. Installing a non-release commit or branch is intentionally only available from a checked-out source tree through `just install`.

`just publish` updates version files, commits, tags, and pushes the tag. `.github/workflows/release.yml` is triggered by `v*` tags, builds the Zig core and Electron app on Linux, macOS, and Windows runners, uploads the archive artifacts, and creates the GitHub Release.
