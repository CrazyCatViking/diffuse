# Diffuse Architecture

This document describes the current implementation through Phase 5 and the first Rust-only Phase 6 ACP slice for contributors. Phase 6 is not complete. The broader workbench design and the remaining ACP, hardening, and fallback-removal phases live in [`agent-workbench-design.md`](agent-workbench-design.md).

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

The in-process core does not remove useful process boundaries. Git commands and language servers remain children of `AppCore`. Optional native Tree-sitter grammars run only in the Rust `diffuse-rpc` helper's private `syntax-runner` mode. The existing Electron/opencode review-agent integration also retains its provider child processes and single-workspace owner. The separate Rust ACP API supervises one child per session, but does not replace or integrate with that desktop runner yet.

## Desktop Boundary

`app/electron/preload.ts` exposes capabilities such as repository picking, typed workbench and workspace snapshots, workspace lifecycle, revisioned UI-state saves, exact attention acknowledgement, input answer/cancel operations, attention navigation, workspace requests, and event subscriptions. Context isolation remains enabled and the renderer does not import Node or the addon.

`app/electron/main.ts` owns the single primary `BrowserWindow`, tray and hide/quit lifecycle, single-instance routing, dialogs, IPC validation, review-agent adapter, and one `CoreBackend`. The request path is:

1. A renderer store calls the typed `DesktopBridge`.
2. Preload forwards the call over a named IPC channel.
3. Electron main validates the sending window, method, workspace ID, workspace generation, request ID, and parameter shape.
4. `NativeCoreBackend` calls the corresponding addon method.
5. `diffuse-node` executes the operation as an N-API `AsyncTask` and returns a Promise.
6. The task dispatches into the application-wide `AppCore`; blocking repository work is moved off the Node main thread.
7. Electron validates lifecycle snapshots and event envelopes before they reach the renderer.

The core contract remains workspace-explicit. Workspace requests contain a stable workspace ID, a generation for the current open lifetime, and a request ID. SQLite reuses the stable ID when the same canonical worktree is reopened, while reopening creates a new generation so stale results cannot mutate the new runtime.

The Phase 5 renderer-facing IPC surface is typed and validated at both preload and Electron main. It adds `workbench:getSnapshot`; `workspace:getSnapshot`, `workspace:close`, `workspace:dismissRestoreFailure`, `workspace:reorder`, and `workspace:saveUiState`; `attention:acknowledge`; and `input:answer`/`input:cancel` alongside the existing open, activate, and workspace-request methods. The internal `CoreBackend` also exposes producer operations for attention creation/notification claims and input creation, acceptance, rejection, expiry, and supersession; these are not general renderer IPC capabilities.

`WorkbenchSnapshot` is the restoration authority and includes ordered workspace summaries, active workspace/snapshot, aggregate attention, individual attention items, input requests, revisioned workspace UI state, legacy import reports, restore diagnostics, and the current event sequence. `WorkspaceSnapshot` remains the repository/runtime projection for one exact workspace generation. Preload validates response shape, identity, generation, and compare-and-swap revision outcomes before returning them to Vue.

`CoreBackend` keeps native and rollback transports behind one whole-backend interface. Requests are never delegated method by method between N-API, Rust RPC, and Zig RPC state.

## Backend Selection

N-API is the default in both development and packaged applications. `DIFFUSE_DESKTOP_CORE` accepts:

- unset, empty, or `napi`: load `diffuse_core.node` and create one `AppCore`.
- `rpc`: instantiate `LegacyCoreBackend` and `LegacyWorkspaceRegistry`, which start one selected JSON-RPC child per workspace.

The legacy registry is only a rollback adapter. It is not part of the normal architecture, reports degraded health, and does not provide durable Phase 5 attention, input, or restore-failure operations. It keeps only its existing in-memory workbench restoration behavior.

On the RPC rollback path, `DIFFUSE_CORE_EXECUTABLE` selects a complete compatible executable. Without that override, development resolution prefers `target/debug/diffuse` and then the Zig development binary; packaged resolution finds the bundled Zig `resources/diffuse`. Set both variables to exercise the packaged Rust compatibility executable explicitly:

```sh
DIFFUSE_DESKTOP_CORE=rpc \
DIFFUSE_CORE_EXECUTABLE=/path/to/diffuse-rpc \
pnpm dev
```

The N-API addon resolves from `app/build/native/diffuse_core.node` during development and `resources/native/diffuse_core.node` when packaged. `DIFFUSE_NATIVE_ADDON` overrides that path and fails startup if the named file is missing.

## AppCore And Persistence

`AppCore` owns the workspace registry, active workspace, workbench and separate ACP event hubs, syntax manager, durable attention/input state, legacy import coordination, and SQLite database. A `WorkspaceRuntime` owns repository state, review access, search coordination, repository watching, repository-scoped LSP sessions, and an ACP `AgentManager`. Registry locks are used for identity lookup rather than held across Git, database, LSP, parsing, or other external work.

Opening a workspace resolves and canonicalizes the Git worktree root, deduplicates an already-open root, obtains its stable UUID from SQLite, creates a fresh generation UUID, imports legacy review archives, starts repository services, and publishes lifecycle events. Every open lifetime has a new generation; core lookups, Electron validation, and renderer activation generations fence delayed results and events from a closed lifetime.

Closing first changes the runtime to `closing` and rejects new work, cancels and drains searches and active operations, then stops LSP and watcher services. A normal close refuses to remove a workspace with `pending` or `response-submitted` input. After user confirmation, a forced close atomically changes those requests to `cancelled`, resolves their attention, persists the closed workspace, emits the resulting input/attention updates, and removes the runtime. The renderer also asks for confirmation when it already knows about pending input, unsaved drafts, or active legacy review work; a pending-input race during close requires a second explicit force confirmation. Explicit application shutdown unloads workspaces without rewriting their persisted open state so startup restoration remains possible.

The normal desktop database is `<Electron userData>/workbench.sqlite3`. It uses foreign keys, WAL mode, a busy timeout, versioned migrations, corruption preservation/recovery, and a cross-process recovery lock. Current schema migration version 3 retains schema 2's device-local workspace identity/order/active state, revisioned UI restoration, input requests and non-secret responses, attention acknowledgement and notification claims, and typed legacy archives. Its conceptual tables are `workspaces`, `app_state`, `workspace_ui_state`, `agent_sessions`, `input_requests`, `attention_items`, `legacy_review_import_ledger`, `legacy_import_runs`, `legacy_import_agents`, `legacy_import_chats`, and `legacy_import_prompts`, plus schema 3's `acp_sessions` snapshots and `acp_activity` history. The SQLite schema is private and is not a manual-editing or integration API.

Portable review configuration, active session, session metadata, progress, reviewed files, and threads remain authoritative under the repository's `.diffuse/reviews` directory. The precise hybrid ownership and migration guarantees are in [`review-spec-v2.md`](review-spec-v2.md); retained file formats are in [`review-spec-v1.md`](review-spec-v1.md).

On workspace open, capability-confined no-follow reads import legacy v1 `runs/*.json`, `agents/*.json`, `chat/messages/*.json`, and `prompts/*.md` into the typed SQLite archive tables with workspace/session/entity/source-path/SHA-256 provenance. Unchanged content is a no-op, changed same-path content replaces its archive entity, and malformed, oversized, or symlinked artifacts leave retryable diagnostics. The importer never modifies source files or creates historical attention.

## Events And Backpressure

`AppCore` assigns every workbench event a monotonic process-local sequence and event ID, keeps a bounded replay window, and publishes explicit workspace ID and generation. Domain state and snapshots remain authoritative.

The N-API event path is bounded at each layer:

- The addon subscribes to `EventHub` with a bounded 256-event channel.
- A dedicated Rust drain thread groups up to 64 events or waits at most 8 ms per batch.
- Batches enter JavaScript through a thread-safe N-API callback with a bounded queue of 16.
- Callback and subscription pressure back up through the dedicated drain thread rather than growing without bound or dropping a terminal event batch.

`NativeCoreBackend` validates event shape and strictly increasing sequence before forwarding a batch. The renderer workbench store serializes event application, ignores duplicates, and requests a fresh authoritative workbench snapshot when it observes a sequence gap. Renderer initialization subscribes before taking its first snapshot and applies later queued events after the snapshot sequence, which closes the startup race.

Phase 5 durable mutations follow transaction-then-event ordering. Input plus attention creation and input plus attention terminal transitions commit in one immediate SQLite transaction. UI state, acknowledgement, notification claims, and input transitions use exact expected revisions. A Phase 5 coordination gate keeps the committed mutation, authoritative summary, and event enqueue in the same process order; publication happens only after locks are released. Snapshots take the same gate, so they do not observe a committed Phase 5 change without either the corresponding queued sequence or the changed snapshot state.

The durable invariants are enforced in validation, transactions, and schema v2 triggers: revisions are positive JavaScript-safe integers; one input links to one same-workspace attention item; one workspace/source/kind identifies an attention stream; new attention starts unread; revisions advance without gaps; acknowledged and notified revisions never consume a newer revision; terminal attention cannot be acknowledged; and secret responses are replaced by a redacted marker before persistence.

Search, repository, review, syntax-install, and LSP event families retain their existing typed payload contracts. Phase 5 adds `workspace/orderChanged`, `workspace/uiStateChanged`, `workspace/attentionChanged`, `input/requested`, `input/responseSubmitted`, and `input/resolved` to the lifecycle events already carried by the workbench envelope. The transport is an in-process batch callback rather than line-delimited JSON-RPC notifications on the normal path.

## Health And Shutdown

The addon exposes `healthy`, `degraded`, `unhealthy`, `stopping`, and `stopped` states. Health records the last native-boundary failure and shutdown timeout state. Rust panics are caught at task, event-drain, initialization, and shutdown boundaries where possible; a task panic makes the native core unhealthy so later work is rejected through stable native error codes.

Shutdown is idempotent and bounded:

1. Electron unsubscribes event forwarding and calls `CoreBackend.shutdown()` once during explicit quit.
2. The addon immediately enters `stopping`, stops the event callback, rejects new work, and drains `AppCore` workspaces.
3. Native shutdown allows five seconds for the caller, records a timeout if exceeded, and remains `stopping` until the detached drain completes and records the actual terminal state.
4. Electron allows seven seconds before logging a timeout and completing application quit.

Closing or hiding the primary window is not core shutdown. The one `AppCore`, its open workspaces, watchers, LSP servers, and allowed background work remain in Electron main until explicit Quit.

The native addon starts restoration asynchronously after construction. Normal native tasks wait for that restoration barrier, while Rust restores the previously active workspace first and restores other persisted-open workspaces with at most four concurrent tasks. Missing, inaccessible, moved, or invalid repositories remain as restore diagnostics rather than disappearing. The Workbench Overview exposes Retry and Dismiss actions for those diagnostics. Dismiss removes the failed-open marker; reopening a moved repository uses the normal Open Workspace flow.

## Renderer State

The Vue app uses Pinia and memory-history Vue Router. `useWorkbenchStore()` owns ordered workspace summaries, aggregate priority counts, attention items, input requests, the presentation-active workspace, event sequence, restore health/diagnostics, and bounded renderer-local restoration records. Feature stores remain one active projection rather than one full store/component tree per workspace.

Routes are `/workbench`, `/w/:workspaceId/review`, `/w/:workspaceId/file/:fileId`, `/w/:workspaceId/folder/:folderPath`, and `/w/:workspaceId/input/:inputRequestId`. Switching captures compact route, selected review session, diff target/layout, search, cursor, review drafts, non-secret input drafts, and focus state, unmounts the heavy workspace view, then restores the selected workspace from an `AppCore` snapshot. A persisted `reviewSessionId` is loaded before its route is presented; if it is no longer accessible, restoration loads the portable active review session and removes only the stale query. Workspace and generation checks reject delayed work from another presentation lifetime. Dirty renderer UI state is generation-bound and resubmitted with compare-and-swap after snapshot recovery rather than overwriting a newer record.

The rail preserves user order and shows the highest priority of `input-required`, `error`, `unread`, `running`, or `idle` with category counts. `running` is derived from SQLite `agent_sessions`; the retained Node runner is process-local in Phase 5 and is not projected into that count. The global overview groups workspaces by priority and exposes exact attention navigation. The input route renders one question, permission, authentication, or conflict request, preserves only non-secret drafts, submits it as `response-submitted`, and remains unresolved until a producer records `accepted`, `rejected`, `expired`, `cancelled`, or `superseded`.

Attention is never cleared by merely switching workspaces. The input surface acknowledges only its exact item/revision while the surface is visible and contains focus; explicit overview or desktop-notification navigation acknowledges only the selected revision after routing to its target. Compare-and-swap prevents a concurrently newer revision from being consumed. Input, error, completion, response-submitted, and terminal updates use a polite live region; progress noise is not announced.

Repository changes come from the Rust `notify` watcher. Normal changes emit `repository/changed`; changes below `.diffuse/reviews` emit `review/changed`. Watcher overflow, backend errors, or rescan flags trigger conservative refresh behavior. Workspace summaries expose watcher health and degrade when the watcher terminates unexpectedly.

## Repository, Diff, Syntax, And LSP

Git remains the repository correctness boundary. `diffuse-core` runs Git child commands to resolve worktrees and refs, list changed files, load source sides, and construct diff models. The renderer virtualizes diff rows, derives adjacent-line display relationships, and requests syntax spans lazily for visible ranges.

Installed native Tree-sitter parsers are not loaded into Electron or the addon. Electron resolves a syntax helper from `target/debug/diffuse` in development or packaged `resources/diffuse-rpc`; `DIFFUSE_SYNTAX_RUNNER` overrides it. The addon passes that executable to `AppCore`, which invokes its bounded `syntax-runner` subcommand. Missing, malformed, oversized, failed, or timed-out helper output produces unavailable syntax instead of loading parser code in-process.

Language servers are child processes owned by the application-wide `AppCore` and scoped to workspace/repository, language, and server. They persist across renderer and workspace presentation changes until restart, process exit, workspace close, or application shutdown. Configuration and lifecycle details are in [`lsp.md`](lsp.md).

## Review Agent Boundary

Portable manual and AI review state continues to use `.diffuse/reviews`. Electron's existing `ReviewAgentRunner` starts opencode through `@opencode-ai/sdk`, sends prompts, and writes the legacy v1 run, agent, chat, and prompt records through workspace-scoped core requests or retained prompt helpers. It permits only one explicit workspace/generation owner at a time and rejects cross-workspace start, stop, or chat operations. Main-process close policy includes review runs and chat setup/prompts even for a background workspace. A forced close closes tool admission, drains admitted tool mutations, aborts provider work, and waits for durable cancellation before core removal; an in-flight chat's `Thinking...` placeholder is replaced with a cancellation response. Natural completion/failure and cancellation claim one terminal outcome before asynchronous persistence, so a completed run is not subsequently rewritten as cancelled. Application shutdown performs the same stop-before-core ordering and still releases provider resources if stopping reports an error.

After the runner durably writes a completed or failed terminal v1 state, an Electron producer creates one revisioned completion or error attention item for that run. Creation uses a stable source ID and bounded retries; cancellation does not create terminal attention. Failure to create attention is logged and does not roll back the already persisted v1 terminal state.

When the primary window is unfocused or hidden and Electron notifications are supported, unread input and error items can produce a desktop notification. Electron first claims the exact notification revision through SQLite compare-and-swap, so startup replay and repeated events do not duplicate it. Notification clicks focus the primary window and enter a bounded, deduplicated main-process queue until the renderer has installed its listener and completed workbench restoration; queued requests are then delivered in order and acknowledged only after exact presentation. The tray tooltip always aggregates input, error, unread, and running counts; its emphasized icon is reserved for input or error. These paths have unit and Electron-level coverage, but current verification does not claim full operating-system notification/tray integration on every platform.

This provider-specific runner is retained behavior, not the ACP implementation below. Phase 5 durable attention, input state, hybrid review migration, workbench restoration, forced-close cancellation, and terminal attention production remain unchanged.

## Rust ACP First Slice

[`acp.rs`](../crates/diffuse-core/src/acp.rs) exposes ACP types through `diffuse_core::acp`; [`AppCore`](../crates/diffuse-core/src/app_core.rs) exposes the following Rust public API only. No ACP methods or events are exposed through N-API, the Diffuse RPC adapters, Electron IPC, or the UI. ACP's own child-process JSON-RPC wire protocol is a separate boundary.

| API | Current contract |
| --- | --- |
| `start_acp_session(context, adapter)` | Unix only; non-Unix starts return an explicit unsupported-platform error. Returns a local session ID after starting asynchronous supervision, not after initialization succeeds. Observe activity or query sessions for the outcome. |
| `prompt_acp_session(context, session_id, text)` | Admits one text prompt only when ready; overlapping turns are rejected. Success is not a durable acknowledgement: wait for committed `turn-started` and `turn-ended` or `session-ended` activity. |
| `cancel_acp_session(context, session_id)` | Signals cancellation of an admitted/running turn; does not synchronously confirm its outcome. |
| `stop_acp_session(context, session_id)` | Signals host/process-group shutdown; accepted workspace close and application shutdown also stop owned hosts before draining background lifetime permits. |
| `acp_sessions(context)` | Returns persisted session snapshots for the workspace, including historical closed/failed sessions. |
| `acp_activity(context, session_id, after)` | Returns up to 100 durable activity records after an exclusive sequence cursor. |
| `acp_events()` | Separate bounded Rust stream for `acp/activity` and ACP-originated `workspace/summaryChanged` events. |

Every session operation uses `WorkspaceRequestContext` and validates the current workspace generation. `AdapterConfig` contains `id`, an absolute `executable`, `args`, and an explicit `environment` map. The adapter ID must be nonempty and at most 256 bytes. There is no adapter discovery or repository configuration integration. The child starts directly without a shell, with its inherited environment cleared, the canonical workspace root as cwd, piped stdin/stdout, and discarded stderr. Each session has a distinct local host ID and its own process, worker thread, and current-thread Tokio runtime; there is no pool or multiplexing.

The client uses newline-delimited ACP v1 JSON-RPC: `initialize` with empty client capabilities, `session/new` with no MCP servers, text-only `session/prompt`, streamed `session/update`, and `session/cancel`. Advertised capabilities and the remote session ID are stored, not used to enable load/resume or image prompts. Framing is bounded at 256 KiB and prompt text at 32 KiB. Writes, initialization responses, and session creation responses have 10-second deadlines; turns have a 30-minute deadline, reset to 3 seconds after sending cancellation. Invalid JSON, response correlation, foreign-session updates, unsupported protocol versions, disconnects, and expired deadlines fail the session.

On Unix, `process_group(0)` creates a dedicated process group for each host. Cleanup sends `SIGKILL` to that group and kills/waits for the direct child; a process-group guard also attempts cleanup on drop. This contains ordinary descendants remaining in the group, including those that outlive the adapter, on explicit stop, timeout (including ignored cancellation), accepted workspace close, and application shutdown. It is lifecycle containment, not an OS sandbox: descendants that escape the group, for example with `setsid()`, are not contained. Non-Unix ACP start is explicitly unsupported in this slice rather than falling back to direct-child-only cleanup. Unix implementation does not imply verified macOS behavior; verification remains Linux-only.

ACP workers hold background lifetime permits separately from foreground operations. Workspace close rejects new operations, cancels/drains searches and admitted foreground mutations, then checks the non-forced pending-input policy before stopping ACP. A refusal for `pending` or `response-submitted` input restores the workspace to ready and preserves the live ACP host, not just its persisted running row. Once close is accepted, the core stops ACP hosts and drains their background permits before service teardown and workspace removal. Application shutdown signals all owned ACP hosts to stop before draining them.

All `session/request_permission` requests receive a cancelled outcome, including requests offering `allow_always`. Other client requests receive method-not-supported. No filesystem or terminal client capabilities are advertised, no MCP tools are attached, and no durable input/permission UI or completion/error attention items are produced by ACP. **Permission denial is not an OS sandbox.** The executable is trusted code running with the application's OS privileges and can access resources independently of ACP. Explicit environment values, prompt text, and peer payloads must be treated accordingly; this slice does not provide transcript secret filtering.

Session snapshot and activity writes commit together and are fenced by the persisted open workspace generation. ACP now shares `AppCore`'s Phase 5 coordination gate: the durable mutation, authoritative absolute running-count summary, and enqueue of `acp/activity` followed by `workspace/summaryChanged` occur under that gate in commit order. Workbench snapshots and Phase 5 mutations use the same gate, preventing concurrent session updates from enqueueing stale absolute counts out of commit order. Event delivery happens only after releasing the gate.

The separate ACP hub still has a 128-event replay window and disconnects a subscriber whose bounded channel fills rather than blocking supervision. Its process-local event sequence is independent of both the normal workbench event sequence and the durable activity cursor; sharing the coordination gate does not merge these streams or their cursors. Recover with a new subscription, `acp_sessions`, paginated `acp_activity`, and workspace/workbench snapshots as needed. ACP session state contributes to the existing SQLite-derived `running` count while a turn runs, but its live summary events are not forwarded to the desktop. Phase 5's existing coordinated mutation/snapshot guarantees and bounded blocking N-API delivery remain intact; the latter delivery policy does not apply to the separate nonblocking ACP stream.

At `AppCore` construction, persisted ACP sessions left `starting`, `ready`, or `running` become `failed`, with one durable `session-ended` record whose reason is `application-restarted`. Recovery is idempotent and preserves history and remote IDs without resuming a host. See [the persistence contract](review-spec-v2.md#acp-session-and-activity-history).

Verification for this slice is limited to the provider-free [`diffuse-acp-fixture`](../crates/diffuse-acp-fixture/tests/lifecycle.rs) on Linux and database recovery tests. Coverage exercises initialization, repeated turns, streaming, permission denial, explicit environment/cwd, colliding remote IDs across workspaces, cancellation deadlines, malformed/disconnected peers, close/shutdown, stale generations, persistence, and slow-subscriber disconnection. Regression fixtures also cover ordinary descendant termination on stop/cancel timeout/close/shutdown, a live responsive host surviving a refused pending-input close before a forced close stops it, and concurrent same-workspace summaries matching committed session states. This does not establish real-provider compatibility, macOS ACP behavior, desktop integration, or Phase 6 completion; non-Unix starts are unsupported. Pooling, discovery, load/resume/reconnect, durable prompt queues, normalized workbench history/UI, MCP tools, and durable permission delivery remain future work.

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
