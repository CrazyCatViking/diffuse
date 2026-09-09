# Diffuse Architecture

This document describes the delivered Phase 6 native ACP workbench and retained Phase 5 guarantees. The Rust first slice in `82adf08` has expanded into native sessions, bounded review waves, immutable scopes, queues, explicit reconnect, pooling, input forms and MCP tools; the desktop Node runner is retired. Feature delivery is distinct from real-provider/manual platform verification and later hardening. The broader design and verification limits live in [`agent-workbench-design.md`](agent-workbench-design.md).

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

The in-process core does not remove useful process boundaries. Git commands and language servers remain children of `AppCore`. Optional native Tree-sitter grammars run only in the Rust `diffuse-rpc` helper's private `syntax-runner` mode. Rust supervises ACP hosts with optional workspace-local multiplexing. Electron main owns bounded review-wave scheduling, not provider execution. The Node/opencode provider, SDK, private runner IPC and environment-routed tool bridge have been removed from the desktop.

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

Desktop close first checks main-owned review waves; queued/running waves reject non-forced close, and forced close cancels their plans and scoped sessions before core removal. Core close changes the runtime to `closing`, rejects new work and drains foreground mutations before checking `pending` or `response-submitted` input. Refusal restores readiness without stopping live ACP hosts. Accepted close stops/drains background agent/tool work, then LSP/watcher services; remaining input is cancelled transactionally with workspace close, while session-owned unresolved input may already have expired during cleanup. Renderer confirmation covers known pending input, drafts and ACP work; a close-policy race requires explicit force confirmation. Quit disposes the wave scheduler before core shutdown, which unloads workspaces without rewriting persisted open state.

The normal desktop database is `<Electron userData>/workbench.sqlite3`. It uses foreign keys, WAL mode, a busy timeout, versioned migrations, corruption preservation/recovery, and a cross-process recovery lock. Current schema version 7 retains Phase 5 state, prior ACP queues/history/input delivery and schema 5 incarnations. Schema 6 introduced the compatibility barrier for immutable `reviewFileIds` stored in session JSON; schema 7 adds `acp_legacy_quoted_scopes` to block ambiguous pre-v7 display-quoted assignments from reconnecting under literal-path semantics. It preserves session IDs, stored assignments and history rather than rewriting them. Main-owned review-wave plans still use `workspace_ui_state`. The schema is private, not a manual-editing API; see [the persistence contract](review-spec-v2.md#acp-session-and-activity-history).

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

Routes are `/workbench`, `/w/:workspaceId/review`, `/w/:workspaceId/file/:fileId`, `/w/:workspaceId/folder/:folderPath`, `/w/:workspaceId/agents/:agentSessionId?`, and `/w/:workspaceId/input/:inputRequestId`. Switching captures compact route, selected review session, diff target/layout, search, cursor, review drafts, non-secret input drafts, and focus state, unmounts the heavy workspace view, then restores the selected workspace from an `AppCore` snapshot. Agent prompt drafts/request IDs, review adapter selection, and ACP review/chat bindings are device-local UI restoration state. A persisted `reviewSessionId` is loaded before its route is presented; if it is no longer accessible, restoration loads the portable active review session and removes only the stale query. Workspace and generation checks reject delayed work from another presentation lifetime. Dirty renderer UI state is generation-bound and resubmitted with compare-and-swap after snapshot recovery rather than overwriting a newer record.

The rail preserves user order and shows the highest priority of `input-required`, `error`, `unread`, `running`, or `idle` with category counts. `running` is derived from SQLite `agent_sessions`; review-wave state separately represents not-yet-launched shards. The global overview groups workspaces by priority and exposes exact attention navigation. The input route renders questions, permission choices, supported forms and retained generic input kinds, preserves only permitted non-secret drafts, submits as `response-submitted`, and remains unresolved until its producer records a terminal outcome.

Attention is never cleared by merely switching workspaces. The input surface acknowledges only its exact item/revision while the surface is visible and contains focus; explicit overview or desktop-notification navigation acknowledges only the selected revision after routing to its target. Compare-and-swap prevents a concurrently newer revision from being consumed. Input, error, completion, response-submitted, and terminal updates use a polite live region; progress noise is not announced.

Repository changes come from the Rust `notify` watcher. Normal changes emit `repository/changed`; changes below `.diffuse/reviews` emit `review/changed`. Watcher overflow, backend errors, or rescan flags trigger conservative refresh behavior. Workspace summaries expose watcher health and degrade when the watcher terminates unexpectedly.

## Repository, Diff, Syntax, And LSP

Git remains the repository correctness boundary. `diffuse-core` runs Git child commands to resolve worktrees and refs, list changed files, load source sides, and construct diff models. The renderer virtualizes diff rows, derives adjacent-line display relationships, and requests syntax spans lazily for visible ranges.

Rust changed-file metadata uses `git diff --name-status -z -M` and `--numstat -z`. NUL-separated path fields preserve actual UTF-8 filenames, including tabs/newlines, rather than Git's C-quoted display strings; rename metadata carries old and new paths separately, with counts matched to the canonical new ID. This is NUL-delimited metadata, not permission for NUL bytes inside IDs or a claim of arbitrary non-UTF-8 filename support. Exact-file diffs and binary diff signatures use `:(top,literal)<path>` plus `:(top,exclude,literal)<path>/` to exclude descendants during file/directory transitions. Exact-file Git calls clear inherited `GIT_LITERAL_PATHSPECS`, `GIT_GLOB_PATHSPECS`, `GIT_NOGLOB_PATHSPECS` and `GIT_ICASE_PATHSPECS`; general Git calls are unchanged. Wildcards and pathspec magic in an assigned filename therefore cannot expand its scope to other files.

Installed native Tree-sitter parsers are not loaded into Electron or the addon. Electron resolves a syntax helper from `target/debug/diffuse` in development or packaged `resources/diffuse-rpc`; `DIFFUSE_SYNTAX_RUNNER` overrides it. The addon passes that executable to `AppCore`, which invokes its bounded `syntax-runner` subcommand. Missing, malformed, oversized, failed, or timed-out helper output produces unavailable syntax instead of loading parser code in-process.

Language servers are child processes owned by the application-wide `AppCore` and scoped to workspace/repository, language, and server. They persist across renderer and workspace presentation changes until restart, process exit, workspace close, or application shutdown. Configuration and lifecycle details are in [`lsp.md`](lsp.md).

Non-UTF-8 Git filenames cannot be represented by the current JSON file-ID contract. Metadata is parsed as bytes and decoded per entry: an unrepresentable entry is omitted with an aggregate diagnostic, rather than failing the entire listing or inventing a lossy authorization ID. A rename is omitted if either path is unrepresentable; other files remain available.

## Review Agent Boundary

Portable findings, progress, reviewed files, review targets and threads continue to use `.diffuse/reviews`; ACP turns/transcripts do not. The picker selects a configured ACP adapter only. `useReviewAcpStore` presents main-owned review waves and inline selection/thread chat bound to workspace generation, portable review session, adapter and core-assigned ACP session IDs. Repository `promptInstructions` feed review/chat prompts, and `maxParallelAgents` controls review-wave concurrency. Legacy provider/model/agent overrides are preserved but never automatically translated; users configure supported adapter arguments explicitly.

The historical Phase 5 `ReviewAgentRunner`, its opencode SDK dependency, `review-agent:start/stop/chat` IPC, single-owner lifecycle and private environment bridge are no longer desktop execution paths. Legacy run/chat files and compatibility APIs remain for persisted history, not a runnable fallback. Migration does not delete old generated `.opencode/tools/diffuse_review.ts` or repository package files. Users whose adapters auto-load that obsolete tool must explicitly disable/remove it; the former bridge endpoints and `DIFFUSE_REVIEW_BRIDGE_*` routing no longer exist in the desktop.

When the primary window is unfocused or hidden and Electron notifications are supported, unread input and error items can produce a desktop notification. Electron first claims the exact notification revision through SQLite compare-and-swap, so startup replay and repeated events do not duplicate it. Notification clicks focus the primary window and enter a bounded, deduplicated main-process queue until the renderer has installed its listener and completed workbench restoration; queued requests are then delivered in order and acknowledged only after exact presentation. The tray tooltip always aggregates input, error, unread, and running counts; its emphasized icon is reserved for input or error. These paths have unit and Electron-level coverage, but current verification does not claim full operating-system notification/tray integration on every platform.

Phase 5 durable input/attention revisions, hybrid import, restoration and exact acknowledgement guarantees remain. Provider-specific lifecycle descriptions in historical phase records describe that earlier implementation; current terminal attention comes from ACP and failed wave plans, not the retired Node producer.

## Native ACP Workbench

[`acp.rs`](../crates/diffuse-core/src/acp.rs) owns sessions, turns and inputs, [`acp_transport.rs`](../crates/diffuse-core/src/acp_transport.rs) owns one bounded dispatcher per host, and [`acp_mcp.rs`](../crates/diffuse-core/src/acp_mcp.rs) serves review tools. The typed [desktop ACP contract](../app/src/lib/acpContract.ts) runs through validated `acp:<method>` IPC, `NativeCoreBackend`, and N-API asynchronous tasks into `AppCore`. RPC rollback explicitly returns `UNSUPPORTED_METHOD`; the ACP child's own JSON-RPC protocol is not a new Diffuse RPC adapter API.

| Desktop API | Current contract |
| --- | --- |
| `saveAcpAdapter`, `discoverAcpAdapters` | Persist explicit definitions and report executable-file availability and Unix/Windows implementation support. No PATH scan, installer, registry search, provider probe or runtime certification. |
| `openAcpSession` | Start or explicitly reconnect by local session ID; initialization outcome arrives through snapshots/events. Review scope and interactive policy cannot be combined; reconnect cannot change stored review/file scope, policy or authentication profile. |
| `queueAcpPrompt` | Durably queue text with `(sessionId, context.requestId)` idempotency; different text for the same key fails. Maximum 64 queued turns per session and 32 KiB per prompt. |
| `cancelAcpTurn`, `cancelAcpSession`, `closeAcpSession` | Cancel a still-queued turn, signal active-turn cancellation, or close the session and cancel its queued work. These are distinct operations. |
| `setAcpMode` | Set an advertised mode while ready; overlapping prompt/mode work is rejected. |
| `getAcpSnapshot` | Workspace-scoped sessions, recent turns, pending input metadata, summary, ACP `sequence`, and separate `workbenchSequence`. |
| `getAcpHistory`, `getAcpActivity` | Independent durable cursor reads, at most 100 records per page. |
| `readAcpEvents`, `onAcpEventBatch` | Bounded replay and live native batches, with explicit `requiresSnapshot` recovery. |
| `startAcpReviewWaves`, `getAcpReviewWaves`, `cancelAcpReviewWaves` | Validated desktop `acp-review:*Waves` calls into Electron main's scheduler, which uses the native session API. These are not new Rust RPC methods. |

The direct Rust `start_acp_session(AdapterConfig)` and immediate `prompt_acp_session` APIs remain available for callers/fixtures; immediate prompt admission is not a durable queue acknowledgement. Desktop callers use saved `AdapterDefinition` metadata and the durable queue instead.

### Adapters And Hosts

Settings / Agent Adapters persists `id`, absolute `executable`, literal `args`, `environmentKeys`, optional `authenticationProfile`, and opt-in `multiplex`. Environment values are resolved from the native process at launch, not stored in adapter definitions. Profiles are compatibility references, not credentials or a keychain integration. Arguments are not shell-parsed; the UI rejects common credential flags but callers must still keep secrets out of persisted arguments and profile names. The child starts with inherited environment cleared, allowlisted values, canonical workspace cwd, piped stdin/stdout, and discarded stderr.

Pools are workspace-local and keyed by full invocation configuration (including resolved environment) and authentication profile. Multiplexing defaults off and must be enabled only for adapters known to support concurrent sessions. A host reserves up to eight local sessions before the pool grows; this is queue headroom, not a global session limit. Each connection initializes once, rewrites/correlates request IDs, and routes remote-session updates and request-scoped forms to the owning worker. A crash affects sessions mapped to that host, not every workspace. Closing one pooled session attempts cancellation and advertised `session/close` without killing siblings; failed or timed-out cleanup stops the shared host, so its siblings may fail too. Last-owner teardown stops the host.

Host startup is implemented on Unix and Windows. Unix process groups contain ordinary descendants on host teardown; direct children are killed/reaped, but descendants escaping the group (for example via `setsid()`) are not contained. [`windows_job.rs`](../crates/diffuse-core/src/windows_job.rs) starts ACP hosts and cancellable MCP Git children suspended, assigns them to a non-inheritable kill-on-close Job Object without breakaway flags, verifies the primary thread's ownership and resumes only after assignment. Assignment/identity/resume failures kill/reap the child instead of running uncontained; dropping the Job handle terminates its process tree. Windows code is cross-target Clippy verified, not runtime verified. Other platforms remain unsupported. **Trusted adapters are required: lifecycle containment and protocol permissions are not an OS sandbox.** No client filesystem or terminal capabilities are exposed, but adapters retain OS privileges.

ACP v1 uses bounded newline-delimited JSON-RPC (256 KiB messages), text prompts, streamed updates, and form elicitation capability. Host writes/initialization and session control responses have deadlines; turns have a 30-minute bound and cancellation a 3-second response bound. Startup and protocol failures are surfaced, not silently retried.

### Reconnect And History

Reconnect is an explicit user operation, not automatic crash retry. It preserves the local session identity and selects advertised `session/resume`, otherwise `session/load`, otherwise `session/new` with continuity `reset` and a visible loss-of-continuity notice. Resume/load rejection fails rather than silently retrying an interrupted turn. Only queued, never admitted, work continues after successful reconnect. Reconnect is rejected until the old worker has completed actual resource cleanup; schema 5 incarnation tokens fence late writes/queue claims even within the same workspace generation.

Session snapshots include continuity, modes, review binding and `historyRevision`. Normalized history contains user/agent messages, tool updates, plans, modes and activity. `agent_thought_chunk` is discarded, not displayed or newly persisted. Transcript presentation and outgoing prompts are text-only; stored peer content is not a promise of multimodal rendering or general secret redaction. A successful load atomically replaces the replayable transcript projection from staged replay and increments `historyRevision`; a failed load leaves the prior projection intact. Durable activity and turn records remain separate from that replacement. See [schema and recovery details](review-spec-v2.md#acp-session-and-activity-history).

### Scoped Review Waves

[`AcpReviewWaves`](../app/electron/acpReviewWaves.ts) owns automatic review scheduling in Electron main. It enumerates the saved review target, sorts/deduplicates file IDs, partitions them using `maxParallelAgents`, and splits oversized partitions into successive bounded scopes. Each scope has at most 1,024 unique canonical IDs, at most 4,096 UTF-8 bytes per ID and at most 128 KiB total ID bytes; planning also keeps encoded scope JSON below 240 KiB for envelope headroom. Prompts are small instructions to enumerate the server-bound assignment, not a giant embedded file list. At most the run's configured parallel count is launched at once; this is distinct from per-host pooling capacity and is not a global cap across runs.

`reviewFileIds` is an optional immutable session authorization scope stored in its snapshot. New scoped sessions require a review binding and current changed-file IDs. Omission on reconnect preserves the stored assignment; a different explicit list or invalid/null/empty scope is rejected rather than widening it. Older sessions with no field retain whole-review scope. MCP enumeration, diffs, findings, progress, reviewed-file mutations/results and thread reads are confined to the assignment intersected with the current target. Scoped progress validates disjoint file-state lists/counts and merges into review-wide progress without overwriting sibling assignments.

Schema 7 conservatively marks sessions present at migration whose stored `reviewFileIds` contain any string starting with a double quote. Such pre-v7 IDs may be Git display quoting rather than literal names; reconnect fails with an instruction to start a new session using current changed-file IDs. Neither automatic unquoting nor matching that old string to a different literal filename is allowed. Session identities, scope strings and historical data stay intact and readable. Ordinary legacy scopes and unscoped sessions are not marked by this migration; newly created scopes can use real quote/backslash filenames. These checks supplement, rather than replace, immutable-scope and incarnation fencing.

Wave plans persist via compare-and-swap in `workspace_ui_state.state.acpReviewWaves`: run identity, workspace/generation, review/adapter, prompt, parallel count, status/error and per-shard IDs/request/session/state. This is main-owned scheduler metadata, not renderer-owned state or transcripts. Renderer saves cannot replace/delete that key. The scheduler polls while work remains, survives renderer loss, closes completed shard sessions before admitting further waves, and persists cancellation before stopping sessions. Failed/interrupted waves fail the run, cancel unstarted work and create error attention; they are not automatically replayed. Restart reconstructs plans, but does not reconnect interrupted ACP sessions. A still-unlaunched shard can be admitted as new work; an interrupted existing session requires explicit inspection/reconnect or a new review. Quit stops scheduling before Rust shutdown.

### Inputs And Review Tools

Review-bound sessions always use `deny-all` permissions. Other sessions can explicitly enable `interactive` permission choices; ACP `elicitation/create` form questions are supported in either policy. The workspace input drawer renders advertised permission labels/options and a supported form subset (text, booleans, numbers, enums and string multi-select), validates responses, and supports decline/cancel. Unsupported schemas are not turned into arbitrary free-text grants; secret/write-only forms and URL elicitation are not a credential flow.

Input plus attention creation is durable. Existing revisioned answer/cancel APIs wake the owning ACP worker; a delivery claim prevents replayed answers. A response remains `response-submitted` after wire delivery and becomes `accepted` when the enclosing prompt/session/mode operation succeeds, not via a separate ACP response-ack RPC. Turn cancellation cancels inputs, peer request cancellation is scoped to its owner, and unresolved inputs expire on session termination/restart. Non-cancelled completed turns create completion attention; failed sessions create error attention, resolved on successful explicit reconnect. These feed rail, overview, input navigation, tray and notification snapshots without relaxing exact-revision acknowledgement.

Review sessions require advertised `mcpCapabilities.http`; without it initialization fails. The session gets a loopback, bearer-authenticated MCP Streamable HTTP endpoint (2025-06-18, POST JSON responses, no SSE). Tools are `listChangedFiles`, `readDiff`, `addFinding`, `updateProgress`, `updateReviewedFiles`, `readThreads`, and `reportActivity`. Workspace/generation, review target, immutable file assignment, session endpoint and active turn are bound server-side, not chosen in tool arguments. Findings must intersect changed lines in the assigned target; findings/progress/reviewed-file mutations use portable review storage. Unknown/out-of-scope arguments, browser Origins and missing authentication are rejected. Requests are serial, bounded, and have a 10-second operation deadline; close/turn end cancels and drains admitted tool work and its contained Git subprocesses before releasing scope. This is a narrow review capability, not unrestricted file or terminal access.

### Events And Lifecycle

ACP commits, authoritative running-count summaries and event enqueue share the Phase 5 mutation/snapshot gate; delivery occurs after releasing it. Session/activity/turn/history writes commit together, while terminal attention is a subsequent durable mutation under that gate, not one combined SQLite transaction. The ACP hub remains separate with a 128-event replay window and disconnect-on-overflow subscriptions. Its native drain resubscribes after overflow and emits `requiresSnapshot`; bounded N-API callback delivery waits only on the dedicated drain thread. The normal Phase 5 stream keeps its existing delivery guarantees.

`useAcpStore` subscribes before recovery, serializes batches, replays sequence gaps, and falls back to workspace ACP snapshots when replay is unavailable. Its retained inbox is bounded at 64 batches. ACP and workbench watermarks, durable activity/history cursors, workspace generations, view epochs, and history revisions are distinct fences; none may be substituted for another. Electron and the renderer refresh authoritative workbench attention/summary snapshots for ACP changes instead of applying ACP sequence numbers to the workbench stream. The Agents surface acknowledges only the selected session's exact attention revisions after history loads and the owning visible surface has focus.

Workers and MCP tools hold background lifetime permits. Close rejects new operations and drains foreground input mutations before checking pending-input policy; a refused non-forced close preserves the live host. Accepted close cancels/drains agent and tool work before removal. Startup marks interrupted sessions/admitted turns failed and expires unresolved ACP inputs, but preserves never-admitted queued turns for explicit reconnect. Hiding/reloading the renderer does not stop hosts; explicit Quit does.

### Verification And Residual Work

The Phase 6 feature scope is delivered, including desktop runner retirement and bounded sharded reviews. [Fake-peer lifecycle](../crates/diffuse-acp-fixture/tests/lifecycle.rs), [workbench fixtures](../crates/diffuse-acp-fixture/tests/workbench.rs), native integration and app tests exercise queues/pooling, reconnect, forms, history/fencing, immutable scope, MCP mutations and lifecycle. The [native review-wave fixture](../app/electron/nativeCoreIntegration.test.ts) executes exactly 1,034 files as two bounded scopes with parallelism one, no renderer, closed terminal sessions and persisted scheduler state. This is over the 1,024-file scope limit, not a claim of unbounded throughput. Windows Job Objects have cross-target Clippy verification and runtime tests in source, but no Windows runtime result is claimed. Real-provider/manual Windows/macOS, notification/tray and later performance hardening remain unverified here. Text-only presentation and explicit adapter-argument migration are deliberate current limits. The Node desktop runner is removed; the degraded Git/review RPC rollback remains and provides no agent execution.

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
