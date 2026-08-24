# Diffuse Architecture

This document describes the current implementation for contributors. The broader workbench design and the status of later attention, ACP, hardening, and fallback-removal phases live in [`agent-workbench-design.md`](agent-workbench-design.md).

## System Shape

The desktop app uses one in-process Rust core by default:

```text
Vue renderer
  -> context-isolated window.diffuse preload bridge
  -> validated Electron IPC handlers
  -> CoreBackend
  -> NativeCoreBackend
  -> diffuse_core.node N-API addon
  -> one application-wide Rust AppCore
       -> WorkspaceRegistry and WorkspaceRuntime instances
       -> SQLite workbench database
       -> repository, diff, review, search, syntax, watcher, and LSP modules
```

Electron main lazily loads the addon once and constructs one `AppCore`. Every open repository is a workspace inside that core; the normal desktop path does not start a Diffuse core child process per workspace or for the application. The renderer remains unaware of N-API and depends only on the typed `DesktopBridge`.

The main source areas are:

- `app/`: Electron main/preload and the Vue renderer.
- `crates/diffuse-core/`: transport-neutral `AppCore` and domain implementation.
- `crates/diffuse-node/`: thin N-API boundary loaded by Electron main.
- `crates/diffuse-cli/`: Rust JSON-RPC compatibility executable and isolated syntax-runner entry point.
- `core/`: retained Zig CLI and complete legacy RPC implementation.

The in-process core does not remove useful process boundaries. Git commands and language servers remain children of `AppCore`. Optional native Tree-sitter grammars run only in the Rust `diffuse-rpc` helper's private `syntax-runner` mode. The existing Electron/opencode review-agent integration also retains its provider child processes and single-workspace owner; replacing that runner with ACP supervision is a later phase, not current behavior.

## Desktop Boundary

`app/electron/preload.ts` exposes capabilities such as repository picking, workbench snapshots, workspace lifecycle, workspace requests, and event subscriptions. Context isolation remains enabled and the renderer does not import Node or the addon.

`app/electron/main.ts` owns the single primary `BrowserWindow`, tray and hide/quit lifecycle, single-instance routing, dialogs, IPC validation, review-agent adapter, and one `CoreBackend`. The request path is:

1. A renderer store calls the typed `DesktopBridge`.
2. Preload forwards the call over a named IPC channel.
3. Electron main validates the sending window, method, workspace ID, workspace generation, request ID, and parameter shape.
4. `NativeCoreBackend` calls the corresponding addon method.
5. `diffuse-node` executes the operation as an N-API `AsyncTask` and returns a Promise.
6. The task dispatches into the application-wide `AppCore`; blocking repository work is moved off the Node main thread.
7. Electron validates lifecycle snapshots and event envelopes before they reach the renderer.

The core contract remains workspace-explicit. Workspace requests contain a stable workspace ID, a generation for the current open lifetime, and a request ID. SQLite reuses the stable ID when the same canonical worktree is reopened, while reopening creates a new generation so stale results cannot mutate the new runtime.

`CoreBackend` keeps native and rollback transports behind one whole-backend interface. Requests are never delegated method by method between N-API, Rust RPC, and Zig RPC state.

## Backend Selection

N-API is the default in both development and packaged applications. `DIFFUSE_DESKTOP_CORE` accepts:

- unset, empty, or `napi`: load `diffuse_core.node` and create one `AppCore`.
- `rpc`: instantiate `LegacyCoreBackend` and `LegacyWorkspaceRegistry`, which start one selected JSON-RPC child per workspace.

The legacy registry is only a rollback adapter. It is not part of the normal architecture.

On the RPC rollback path, `DIFFUSE_CORE_EXECUTABLE` selects a complete compatible executable. Without that override, development resolution prefers `target/debug/diffuse` and then the Zig development binary; packaged resolution finds the bundled Zig `resources/diffuse`. Set both variables to exercise the packaged Rust compatibility executable explicitly:

```sh
DIFFUSE_DESKTOP_CORE=rpc \
DIFFUSE_CORE_EXECUTABLE=/path/to/diffuse-rpc \
pnpm dev
```

The N-API addon resolves from `app/build/native/diffuse_core.node` during development and `resources/native/diffuse_core.node` when packaged. `DIFFUSE_NATIVE_ADDON` overrides that path and fails startup if the named file is missing.

## AppCore And Persistence

`AppCore` owns the workspace registry, active workspace, event hub, syntax manager, and SQLite database. A `WorkspaceRuntime` owns repository state, review access, search coordination, repository watching, and repository-scoped LSP sessions. Registry locks are used for identity lookup rather than held across Git, database, LSP, parsing, or other external work.

Opening a workspace resolves and canonicalizes the Git worktree root, deduplicates an already-open root, obtains its stable UUID from SQLite, creates a fresh generation UUID, starts repository services, and publishes lifecycle events. Closing first rejects new work, then drains active durable operations, cancels search, stops the watcher and LSP children, updates SQLite, and removes the runtime. `AppCore::shutdown` applies that lifecycle to every loaded workspace.

The normal desktop database is `<Electron userData>/workbench.sqlite3`. It uses foreign keys, WAL mode, a busy timeout, versioned migrations, corruption preservation/recovery, and a cross-process recovery lock. It currently owns workspace identity, open/active state, and schema reserved for later work. The presence of agent, input, and attention tables does not mean Phase 5 durable attention or Phase 6 ACP behavior is implemented.

Portable review state remains under the repository's `.diffuse/reviews` directory. [`review-spec-v1.md`](review-spec-v1.md) remains authoritative; Phase 4 did not change durable review ownership or formats.

## Events And Backpressure

`AppCore` assigns every workbench event a monotonic process-local sequence and event ID, keeps a bounded replay window, and publishes explicit workspace ID and generation. Domain state and snapshots remain authoritative.

The N-API event path is bounded at each layer:

- The addon subscribes to `EventHub` with a bounded 256-event channel.
- A dedicated Rust drain thread groups up to 64 events or waits at most 8 ms per batch.
- Batches enter JavaScript through a thread-safe N-API callback with a bounded queue of 16.
- Callback and subscription pressure back up through the dedicated drain thread rather than growing without bound or dropping a terminal event batch.

`NativeCoreBackend` validates event shape and strictly increasing sequence before forwarding a batch. The renderer workbench store serializes event application, ignores duplicates, and requests a fresh authoritative workbench snapshot when it observes a sequence gap. Renderer initialization subscribes before taking its first snapshot and applies later queued events after the snapshot sequence, which closes the startup race.

Search, repository, review, syntax-install, and LSP event families retain their existing typed payload contracts. The transport is now an in-process batch callback rather than line-delimited JSON-RPC notifications on the normal path.

## Health And Shutdown

The addon exposes `healthy`, `degraded`, `unhealthy`, `stopping`, and `stopped` states. Health records the last native-boundary failure and shutdown timeout state. Rust panics are caught at task, event-drain, initialization, and shutdown boundaries where possible; a task panic makes the native core unhealthy so later work is rejected through stable native error codes.

Shutdown is idempotent and bounded:

1. Electron unsubscribes event forwarding and calls `CoreBackend.shutdown()` once during explicit quit.
2. The addon immediately enters `stopping`, stops the event callback, rejects new work, and drains `AppCore` workspaces.
3. Native shutdown allows five seconds for the caller, records a timeout if exceeded, and remains `stopping` until the detached drain completes and records the actual terminal state.
4. Electron allows seven seconds before logging a timeout and completing application quit.

Closing or hiding the primary window is not core shutdown. The one `AppCore`, its open workspaces, watchers, LSP servers, and allowed background work remain in Electron main until explicit Quit.

## Renderer State

The Vue app uses Pinia and memory-history Vue Router. `useWorkbenchStore()` owns ordered workspace summaries, the presentation-active workspace, event sequence, restore health, and bounded renderer-local restoration records. Feature stores remain one active projection rather than one full store/component tree per workspace.

Routes are `/workbench`, `/w/:workspaceId/review`, `/w/:workspaceId/file/:fileId`, and `/w/:workspaceId/folder/:folderPath`. Switching captures compact route, diff target/layout, search, cursor, draft, and focus state, unmounts the heavy workspace view, then restores the selected workspace from an `AppCore` snapshot. Workspace and generation checks reject delayed work from another presentation lifetime.

Repository changes come from the Rust `notify` watcher. Normal changes emit `repository/changed`; changes below `.diffuse/reviews` emit `review/changed`. Watcher overflow, backend errors, or rescan flags trigger conservative refresh behavior. Workspace summaries expose watcher health and degrade when the watcher terminates unexpectedly.

## Repository, Diff, Syntax, And LSP

Git remains the repository correctness boundary. `diffuse-core` runs Git child commands to resolve worktrees and refs, list changed files, load source sides, and construct diff models. The renderer virtualizes diff rows, derives adjacent-line display relationships, and requests syntax spans lazily for visible ranges.

Installed native Tree-sitter parsers are not loaded into Electron or the addon. Electron resolves a syntax helper from `target/debug/diffuse` in development or packaged `resources/diffuse-rpc`; `DIFFUSE_SYNTAX_RUNNER` overrides it. The addon passes that executable to `AppCore`, which invokes its bounded `syntax-runner` subcommand. Missing, malformed, oversized, failed, or timed-out helper output produces unavailable syntax instead of loading parser code in-process.

Language servers are child processes owned by the application-wide `AppCore` and scoped to workspace/repository, language, and server. They persist across renderer and workspace presentation changes until restart, process exit, workspace close, or application shutdown. Configuration and lifecycle details are in [`lsp.md`](lsp.md).

## Review Agent Boundary

Manual and AI review state continues to use `.diffuse/reviews`. Electron's existing `ReviewAgentRunner` starts opencode through `@opencode-ai/sdk`, sends prompts, and writes state through workspace-scoped core requests. It permits only one explicit workspace/generation owner at a time and rejects cross-workspace start, stop, or chat operations.

This provider-specific runner is retained behavior, not the planned ACP architecture. Durable attention, revision-based acknowledgement, ACP host pooling, MCP tool scoping, and review v2 migration are not implemented by Phase 4.

## Native Artifacts And Packaging

Native staging gives each artifact a distinct role:

- `diffuse_core.node`: the normal in-process desktop core.
- `diffuse-rpc` or `diffuse-rpc.exe`: the Rust JSON-RPC compatibility executable and isolated syntax helper.
- `diffuse` or `diffuse.exe`: the Zig user CLI used by release command shims for version, update, install, completion, files, and diff commands; it is also the packaged executable found by the RPC rollback path.

`app/scripts/stage-native-artifacts.mjs` copies the platform Rust library to `app/build/native/diffuse_core.node`, copies the Rust CLI under the `diffuse-rpc` name, and writes a SHA-256 manifest. `prepare-electron-package.mjs` requires a fresh release manifest, verifies source and staged hashes, and copies the addon, Rust helper, and Zig CLI into Electron resources.

`electron-builder` packages those resources into Linux `tar.gz`, macOS `zip`, and Windows `zip` artifacts. Native binaries flow through the normal platform packaging and signing hooks when signing is configured. The repository workflows contain no signing credentials or notarization configuration, so current CI/release smokes verify resources and loading, not signing or notarization.

## Development And Verification

Prerequisites are Git, Zig 0.16.0, the pinned Rust 1.90.0 toolchain, Node 22 for parity with CI, pnpm, and `just` for repository-wide tasks.

Build and stage a debug addon, then run the app:

```sh
cd app
pnpm install --frozen-lockfile
pnpm native:build
pnpm dev
```

If the Cargo workspace is already built, `pnpm native:stage` only refreshes `app/build/native`. Run all native Node, integration, and Electron-runtime checks with:

```sh
cd app
pnpm test:native:all
```

Repository-wide verification remains:

```sh
just build
```

It runs Rust formatting, strict Clippy, tests and build; Zig tests and build; native staging and smokes; complete Rust/Zig RPC parity; contract checks; and app tests/builds. CI runs the native staging and test sequence on Linux x64, macOS arm64, and Windows x64.

Build an unpacked app or distributable archive after building the retained Zig CLI:

```sh
cd core
zig build -Doptimize=ReleaseSafe

cd ../app
pnpm install --frozen-lockfile
pnpm package
# or
pnpm dist
```

Both package commands build and stage the release Rust workspace, build the Electron/Vue app, verify package resources, and invoke `electron-builder`; `package` produces an unpacked application and `dist` produces the platform archive. Release CI additionally executes `pnpm smoke:native:packaged` against the unpacked app before archiving it.

Useful overrides are:

```sh
DIFFUSE_DESKTOP_CORE=rpc
DIFFUSE_NATIVE_ADDON=/absolute/path/to/diffuse_core.node
DIFFUSE_SYNTAX_RUNNER=/absolute/path/to/diffuse-rpc
DIFFUSE_CORE_EXECUTABLE=/absolute/path/to/a/rollback-rpc-executable
DIFFUSE_GRAMMARS_DIR=/path/to/grammars
DIFFUSE_TREE_SITTER_REGISTRY_DIR=/path/to/registry
CARGO_TARGET_DIR=/path/to/target
```

`DIFFUSE_NATIVE_ADDON` and `DIFFUSE_SYNTAX_RUNNER` accept relative paths resolved from the app's current working directory, but absolute paths are less ambiguous. `CARGO_TARGET_DIR` is honored by native staging. The standalone Rust RPC adapter also honors `DIFFUSE_WORKBENCH_DATABASE`; the normal Electron N-API backend deliberately passes its database path from Electron `userData` instead.

The Phase 0 Electron startup, idle-memory, large-diff interaction, renderer event-throughput, and provider-backed agent measurements have not been captured or automated. Packaging and functional smokes therefore verify correctness and artifact loading, not a performance comparison with the former Zig desktop default; that measurement remains deferred to the performance phase documented in [`phase-0-baselines.md`](phase-0-baselines.md).
