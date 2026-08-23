# Diffuse Agent Workbench Design Specification

## Status

| Field | Value |
| --- | --- |
| Status | Proposed |
| Last updated | 2026-08-23 |
| Target shell | Electron and Vue |
| Target core | One application-wide Rust core loaded through N-API |
| Window model | One primary workbench window with multiple workspaces |
| Agent protocol | Agent Client Protocol (ACP) with Diffuse tools exposed through MCP |

This document defines the target architecture and user experience. It is not a description of the current Zig and per-window core implementation. The current implementation remains documented in [`architecture.md`](architecture.md) until each migration phase is complete.

## Executive Summary

Diffuse will become a single-window Agent Workbench for reviewing changes, running coding agents, and moving between multiple repositories without losing context.

The application will create one primary `BrowserWindow`. Opening another repository adds or activates a workspace inside that window instead of creating another window. A compact workspace rail and a searchable workbench overview will show all open workspaces, their background activity, and whether any workspace requires user input.

The long-term backend will be a transport-neutral Rust library loaded into Electron main through N-API. One application-wide `AppCore` will own all workspace runtimes, repository intelligence, persisted workbench state, and agent supervision. ACP agents, language servers, and Git commands remain child processes because they are external failure and trust boundaries; there is no separate Diffuse core daemon.

The architecture must satisfy these central rules:

- There is one primary workbench window, not one window per repository.
- Only one workspace is rendered as the active workspace at a time.
- Inactive workspaces may continue watching files, running agents, and waiting for input.
- Every workspace-bound command, result, and event carries explicit workspace identity.
- Selecting a workspace never accidentally acknowledges or resolves its pending attention.
- SQLite owns local workbench and ACP state; `.diffuse/reviews` owns portable review artifacts.
- The Vue renderer depends on a shell-neutral typed bridge, not directly on Electron or N-API.

## Terminology

| Term | Definition |
| --- | --- |
| Application | The single running Diffuse desktop application instance, including Electron main, the Vue renderer, and the Rust `AppCore`. Electron and its web renderer may still use multiple operating-system processes. |
| Workbench | The global UI that contains the workspace rail, overview, active workspace, settings, and global agent status. |
| Workspace | A Git worktree root opened in Diffuse. A workspace owns repository, diff, review, search, LSP, and agent context. |
| Workspace ID | An opaque stable UUID assigned by Diffuse and stored in local application data. It is not derived directly from a path. |
| Workspace generation | A unique ID for one loaded lifetime of a workspace. It changes after close and reopen so stale asynchronous results can be rejected. |
| Active workspace | The one workspace currently rendered in the workbench content area. Background workspaces remain loaded but are not mounted as workspace DOM. |
| Review session | A repository-portable review target and its findings, threads, reviewed-file state, and progress summary. |
| Agent host | A supervised ACP adapter process or connection that may own multiple independent ACP sessions. |
| Agent session | A persistent conversation associated with one workspace and optionally one review session. |
| Agent turn | One submitted prompt and its streamed response, tool calls, permission requests, and terminal outcome. |
| Input request | A durable request that cannot continue without the user, such as an ACP permission, question, authentication action, or conflict decision. |
| Attention item | A local durable record saying that a workspace has unresolved or unread information. Acknowledgement and resolution are separate states. |

A Git worktree is a distinct workspace even when it shares a Git common directory with another worktree. The same canonical worktree root must not be opened twice.

## Goals

- Let users keep many repository workspaces available inside one desktop window.
- Make pending input visible even when it originates from an inactive workspace.
- Preserve each workspace's route, review target, selection, cursor, search, drafts, and focus context when switching.
- Let agents and repository services continue while their workspace is inactive or the window is closed.
- Keep the active diff responsive while background workspaces and agents are busy.
- Recover useful state after renderer reload, application restart, agent crash, sleep, or temporary repository unavailability.
- Keep the Vue UI independent of the desktop shell and native transport.
- Keep repository-shareable review artifacts inspectable outside Diffuse.
- Support Windows, macOS, and Linux without platform-specific workspace behavior.

## Non-Goals

- Diffuse will not create a separate desktop window for each workspace.
- Diffuse will not support dragging a workspace into another window.
- Diffuse will not render two workspaces side by side in the first implementation.
- Diffuse will not introduce a network-accessible Diffuse daemon.
- Diffuse will not make Tauri, Electron, JSON-RPC, or N-API part of the domain-core API.
- Diffuse will not add cloud synchronization or cross-device attention state in this design.
- Diffuse will not add a general plugin or extension-host system in this design.
- Diffuse will not persist a general event-sourcing journal when normal domain records and snapshots are sufficient.
- Diffuse will not expose hidden model reasoning. Only protocol-provided user-visible activity summaries may be shown or persisted.

## Design Principles

### Explicit Scope

The Rust core must never infer a workspace from whichever workspace the UI currently displays. Every workspace-bound operation includes `workspaceId` and `workspaceGeneration`. Long-running requests also include a request or job ID.

This prevents a response started for workspace A from being applied to workspace B after a switch. It also prevents a delayed response from resurrecting workspace A after that workspace was closed and reopened with a new generation.

### One Authority Per Entity

Each durable entity has one canonical owner. SQLite and `.diffuse/reviews` may reference one another, but they must not both independently own the same message, finding, or state transition.

### Background Work Is Not UI State

Agents, watchers, LSP servers, searches, and persistence belong to `AppCore`. Closing or reloading the renderer removes presentation, not the underlying work.

### Attention Is Durable, Activity Is Transient

Running activity is a live status. Pending input, errors, and unread completions are durable attention. A running spinner must not be represented as an unread notification, and viewing an item must not imply that its underlying problem is resolved.

### Isolation Follows Risk

Repository orchestration, diff logic, review coordination, and persistence live in the Rust modular monolith. ACP agents, LSP servers, Git commands, and untrusted parser code remain isolated by process or WASM boundaries.

## User Experience

### Single-Window Model

Diffuse creates exactly one workspace-capable `BrowserWindow`.

Native directory dialogs, operating-system permission prompts, an external authentication browser, and detached developer tools do not count as workspace windows. Settings, review views, agent sessions, and input requests open inside the primary workbench window.

Opening a repository behaves as follows:

1. Diffuse canonicalizes the selected path and resolves the Git worktree root.
2. If that worktree is already open, Diffuse activates its existing workspace.
3. If it is known but closed, Diffuse restores it and activates it.
4. Otherwise Diffuse creates a new workspace, appends it to the workspace rail, and activates it.

A second `diffuse <path>` invocation, file association, or deep link is delivered to the existing application. It shows the existing window and adds or activates the requested workspace. It never creates another workspace window.

Closing the primary window hides or destroys the renderer presentation according to platform needs, but leaves Electron main and `AppCore` running. Launching Diffuse again recreates or shows the same workbench and rehydrates it from an authoritative snapshot. Only the explicit Quit action shuts down background work.

### Workbench Layout

The desktop layout has four horizontal regions:

```text
+----------------+------------------+--------------------------------+------------------+
| Workspace rail | Changed files    | Active workspace route         | Optional drawer  |
| and overview   | for active repo  | review, diff, folder, or agent | search or input  |
+----------------+------------------+--------------------------------+------------------+
```

The workspace rail is the leftmost application-level surface. It remains visually distinct from the changed-file tree, which belongs only to the active workspace.

The rail contains:

- A Workbench Overview button.
- An Open Workspace button.
- One item per open workspace in stable user-controlled order.
- A searchable All Workspaces action for overflow and recent closed workspaces.
- An aggregate attention count when one or more workspaces require input.

Attention must not reorder rail items automatically because unexpected movement makes switching error-prone. The Workbench Overview may sort workspaces by attention priority while the rail preserves user order.

Each workspace item shows a compact repository identity, selected state, highest-priority status, and relevant count. Hover and keyboard focus expose the full repository name, disambiguated path, branch or target summary, active-agent count, and attention summary.

The rail stays compact at normal widths and narrows to its minimum tokenized width near the existing `900px` layout boundary. Long workspace lists scroll within the rail. The active diff reading surface remains the primary allocation of space.

### Workbench Overview

The Workbench Overview is a global route outside any individual workspace. It provides a scannable list of open and recently closed workspaces.

Its default groups are:

1. Needs input.
2. Errors requiring attention.
3. Unread completions.
4. Running agents and background operations.
5. Ready and recent workspaces.

Each row shows repository name, path disambiguation, branch or review target, last activity, agent status, pending-input count, unread count, and failure summary where applicable.

Selecting a row activates that workspace at its last route. Selecting a specific attention item activates the workspace and navigates directly to the owning agent session, review thread, conflict, or settings action.

The first implementation should navigate to the workspace for responses rather than duplicating full permission and question forms in the overview. This keeps input handling in one canonical surface.

Opening the Workbench Overview sets the active workspace to `null`. All open workspaces then have background presentation priority until the user activates one again.

### Workspace Attention Model

Workspace status is an aggregate over durable attention and transient activity.

| Priority | Summary state | Examples | Clearing rule |
| --- | --- | --- | --- |
| 1 | `input-required` | ACP permission, agent question, authentication, conflict decision | Clears only after the exact request is accepted, cancelled, expires, or is superseded. |
| 2 | `error` | Agent crash, failed Git operation, restore failure, unrecoverable LSP failure | Clears when resolved; acknowledgement only removes unread emphasis. |
| 3 | `unread` | Agent completed, review produced findings, background task finished | Clears when the exact revision is explicitly viewed or acknowledged. |
| 4 | `running` | Agent turn, indexing, refresh, search, install | Derived live state; it is not acknowledged. |
| 5 | `idle` | No activity or attention | No action. |

The rail displays the highest-priority summary state while retaining category counts. A workspace with one pending permission and three running agents displays `input-required`, not merely `running`.

An attention item contains at least:

```ts
type AttentionItem = {
  id: string;
  workspaceId: string;
  sourceId: string;
  kind: 'input' | 'error' | 'completion';
  revision: number;
  status: 'unread' | 'acknowledged' | 'resolved' | 'expired' | 'superseded';
  target: WorkspaceNavigationTarget;
  createdAt: string;
  updatedAt: string;
};
```

Acknowledgement rules are intentionally strict:

- Activating a workspace does not acknowledge all its attention.
- Viewing the exact owning surface while the window is focused may acknowledge that exact revision.
- Answering an input request resolves it only after the ACP peer accepts the response.
- Acknowledging an error does not resolve the error.
- A newer revision of an acknowledged item becomes unread again.
- Replayed provider or watcher events must be deduplicated by stable identity and revision.
- Concurrent acknowledgement uses compare-and-swap semantics so a newly arrived revision cannot be marked read accidentally.
- Acknowledged but unresolved input and errors remain discoverable in the workspace and overview.

When the window is hidden or unfocused, Diffuse may issue one operating-system notification for a new input request or terminal failure. Notifications are deduplicated by attention item and revision. High-frequency running activity is never announced.

### Workspace Switching

Switching workspaces changes presentation only. It does not stop agents, LSP servers, repository watchers, or review jobs.

The switch sequence is:

1. Save the active workspace's current route, selection, draft, cursor, and logical focus target.
2. Set the new active workspace ID in the renderer and core.
3. Unmount the previous workspace content so many workspaces do not retain large DOM trees.
4. Restore or request the new workspace snapshot.
5. Navigate to its last route and restore logical focus and cursor when still valid.
6. Prioritize the new foreground workspace in the native resource manager.

Per-workspace UI state includes:

- Last route and route parameters.
- Diff target and review session selection.
- Selected file or folder.
- Diff layout and context mode.
- Cursor, visual selection, and meaningful scroll anchor.
- Search query, mode, pinned result snapshot, and selected result.
- Open review or agent surface.
- Unsaved comment, chat, and input-response drafts.
- Last logical focus target.

Global UI state includes theme, keybindings, application settings, rail order, rail width, and the active workspace ID.

Workspace routes use a workspace prefix:

```text
/workbench
/w/<workspace-id>/review
/w/<workspace-id>/file/<path>
/w/<workspace-id>/folder/<path>
/w/<workspace-id>/agents/<agent-session-id>
/w/<workspace-id>/input/<input-request-id>
```

The renderer must not keep one Pinia store instance or Vue component tree per workspace. Stores use workspace-keyed state where restoration is required and bounded active-view state for heavy models.

Default navigation commands are:

- `Ctrl+Tab` activates the next workspace.
- `Ctrl+Shift+Tab` activates the previous workspace.
- `Ctrl+1` through `Ctrl+9` activate the corresponding visible rail slot.
- The command palette provides Open Workspace, Workbench Overview, Next Workspace, Previous Workspace, and searchable Switch Workspace commands.

These commands remain configurable through the normal keybinding system.

### Accessibility

The compact rail uses vertical tab-list semantics because exactly one workspace or the overview controls the central content panel. The overflow switcher uses listbox semantics.

Accessibility requirements are:

- Workspace items expose full name, disambiguated path, selected state, status text, and attention count.
- Status never relies only on color, animation, or a tooltip.
- The rail supports roving focus, arrow keys, Home, End, Enter, and Space.
- Normal Tab navigation must work inside and out of the rail; global keyboard suppression must preserve this focus model.
- New input, failure, and completion announcements include the workspace name and occur once per revision.
- High-frequency progress changes are not announced.
- Switching restores logical focus when possible and otherwise focuses the active workspace heading.
- Closing a workspace moves focus to the next stable rail item.
- The UI remains usable with keyboard only, high contrast, reduced motion, 200 percent zoom, and the narrow desktop layout.

## Workspace Lifecycle

Workspace load state and presentation state are separate.

### Load States

| State | Meaning |
| --- | --- |
| `restoring` | Diffuse is restoring a persisted workspace during application startup. |
| `opening` | The root is being canonicalized and repository services are starting. |
| `ready` | Normal repository and workbench operations are available. |
| `degraded` | The workspace remains usable, but one or more services failed. |
| `closing` | New work is rejected while jobs and services are being stopped. |
| `closed` | The runtime is unloaded but its recent-workspace record may remain. |
| `restore-failed` | The root is missing, inaccessible, or no longer a repository. Retry and remove actions remain available. |

### Presentation States

| State | Meaning |
| --- | --- |
| `foreground` | The workspace is active and receives interactive priority. |
| `background` | The workspace is open but not rendered. Agents and watchers may continue. |

Opening the same canonical worktree root twice activates the existing workspace. Path canonicalization must account for symlinks, case-insensitive filesystems, Windows path normalization, and Git worktrees.

Closing a workspace is different from switching away from it or closing the application window.

If a workspace has active agents, pending input, or unsaved drafts, Close Workspace presents these choices:

- Return to workspace.
- Stop work and close.
- Keep workspace open in the background.

There is no state in which a workspace is removed from all workbench surfaces while Diffuse-owned agents continue invisibly. A user may hide the application window while agents continue because the tray, operating-system notification, and next launch restore the workbench.

Startup restores the previously active workspace first. Other open workspaces restore with bounded parallelism. A failed restore remains visible with Retry, Locate, and Remove actions instead of silently disappearing.

After system sleep or wake, each workspace revalidates its repository root, watcher, LSP processes, ACP hosts, and pending operations. Watcher overflow or uncertainty triggers a full repository rescan.

## Target System Architecture

```text
Single Vue workbench renderer
  -> typed DesktopBridge in preload
  -> validated Electron IPC in main
  -> N-API binding
  -> application-wide Rust AppCore
       WorkspaceRegistry
         -> WorkspaceRuntime A
         -> WorkspaceRuntime B
         -> WorkspaceRuntime N
       AgentManager
       AttentionService
       WorkbenchDatabase
       EventHub
       ResourceManager

Workspace runtimes
  -> Git child commands
  -> LSP child processes
  -> repository watchers
  -> diff, syntax, search, and review modules

AgentManager
  -> ACP agent host processes
  -> multiple ACP sessions per capable host
  -> session-scoped Diffuse MCP tools
```

### Process Boundaries

| Process or component | Responsibility |
| --- | --- |
| Vue renderer | Presentation, local interaction state, virtualized rows, and typed bridge calls. |
| Electron preload | Minimal context-isolated API exposed to Vue. |
| Electron main | One-window lifecycle, dialogs, tray, single-instance routing, N-API loading, and IPC validation. |
| Rust `AppCore` | All authoritative workbench, workspace, repository, review, persistence, and agent orchestration. |
| ACP agent host | External agent implementation and provider authentication. |
| LSP process | Language-specific analysis and diagnostics. |
| Git command | Repository operation and correctness boundary. |
| Optional parser WASM | Sandboxed dynamically installed Tree-sitter grammar. |

Electron main must load the native addon exactly once. The renderer never imports the addon or Node APIs.

### Rust Shape

Start with a small Cargo workspace:

```text
crates/
  diffuse-core/   transport-neutral AppCore and domain modules
  diffuse-node/   thin N-API binding for Electron main
  diffuse-cli/    CLI and temporary JSON-RPC compatibility adapter
```

Domain modules remain in `diffuse-core` until a concrete reuse or build boundary justifies another crate. The target is a modular monolith, not a large graph of one-crate-per-concept abstractions.

### Core Components

| Component | Responsibility |
| --- | --- |
| `AppCore` | Top-level lifecycle and access to shared services. |
| `WorkspaceRegistry` | Stable IDs, canonical-root deduplication, generations, load state, and runtime lookup. |
| `WorkspaceRuntime` | One worktree's repository snapshot, watcher, target, diff cache, LSP sessions, searches, and review adapter. |
| `AgentManager` | ACP host pool, sessions, turns, cancellation, reconnect, and process supervision. |
| `AttentionService` | Durable attention creation, acknowledgement, resolution, aggregation, and navigation targets. |
| `WorkbenchDatabase` | SQLite migrations and local workbench, agent, input, attention, and UI state. |
| `EventHub` | Typed ordered event delivery, bounded replay, snapshot fallback, and event coalescing. |
| `ResourceManager` | Foreground priority, bounded CPU and Git work, background fairness, and idle-resource eviction. |

## Identity And Request Scoping

Every workspace-bound request includes:

```ts
type WorkspaceRequestContext = {
  workspaceId: string;
  workspaceGeneration: string;
  requestId: string;
};
```

Every asynchronous result and event includes enough context to apply it without consulting the active workspace.

IDs must be distinct for:

- Workspace.
- Workspace generation.
- Review session.
- Agent host.
- Agent session.
- Agent turn.
- Input request.
- Attention item.
- Search or background job.
- Request.

The global registry lock is held only for lookup and replacement. Work occurs through per-workspace state after lookup. Closing a workspace changes its state to `closing`, rejects new requests, cancels owned jobs, and increments or discards its generation before removal.

## Desktop Contract

The renderer uses a shell-neutral `DesktopBridge`. The same Vue code must not know whether a method is currently served by Zig JSON-RPC, Rust JSON-RPC, or Rust N-API during migration.

Initial workbench commands are:

| Command | Purpose |
| --- | --- |
| `getWorkbenchSnapshot` | Return open workspaces, active workspace, aggregate attention, and event sequence. |
| `listWorkspaces` | Return summaries in rail order. |
| `openWorkspace` | Resolve a path, deduplicate it, create or restore the workspace, and return its snapshot. |
| `activateWorkspace` | Persist and prioritize one workspace as foreground. |
| `getWorkspaceSnapshot` | Rehydrate one workspace after switch, reload, or sequence gap. |
| `closeWorkspace` | Validate close policy, stop owned work when approved, and remove the runtime. |
| `reorderWorkspaces` | Persist user-controlled rail order. |
| `acknowledgeAttention` | Acknowledge one exact attention item revision. |
| `answerInputRequest` | Compare-and-swap an answer against one pending input request revision. |
| `cancelInputRequest` | Cancel one pending input request when supported. |

Existing repository, diff, LSP, review, grammar, and search methods gain required workspace context. Agent commands additionally require agent session or turn identity.

Events use an envelope:

```ts
type WorkbenchEvent<T> = {
  sequence: number;
  eventId: string;
  kind: string;
  workspaceId?: string;
  workspaceGeneration?: string;
  payload: T;
};
```

Required workbench event families include:

- `workspace/added`.
- `workspace/summaryChanged`.
- `workspace/attentionChanged`.
- `workspace/removed`.
- `workspace/restoreFailed`.
- `agent/sessionChanged`.
- `agent/turnChanged`.
- `agent/messageDelta`.
- `input/requested`.
- `input/resolved`.
- Existing repository, review, search, syntax, and LSP events with workspace context.

The event sequence supports a bounded in-memory replay window. Persistent domain entities, not the event stream itself, remain authoritative. If the renderer reports a sequence gap outside the replay window, it requests a new snapshot.

N-API events are delivered through a thread-safe callback and batched before entering JavaScript. Rust must never call JavaScript while holding a lock or access V8 values from a Rust worker thread.

## Persistence Design

### Local SQLite

The application database lives in the platform application-data directory. It uses versioned migrations, WAL mode, foreign keys, and transactionally consistent updates.

SQLite is authoritative for:

- Known workspaces, canonical roots, display names, rail order, and last-opened state.
- Per-workspace local UI restoration state.
- ACP host metadata and capabilities.
- Agent sessions, turns, messages, and resumable remote session IDs.
- Queued prompts and terminal outcomes.
- Tool-call summaries and user-visible activity.
- Pending input requests and non-secret response state.
- Attention items, revisions, acknowledgement, and resolution.
- Rebuildable indexes over local workbench history.

Secrets, provider tokens, and authentication credentials do not belong in SQLite or `.diffuse`. Authentication remains owned by the ACP harness or the platform credential store.

Database writes that create input or attention state are transactional. For example, persisting a pending permission and its attention item occurs in one transaction before the UI event is published.

### Repository Review Artifacts

`.diffuse/reviews` remains authoritative for portable review data:

- Repository review configuration.
- Review sessions and targets.
- Review progress summary.
- Reviewed-file state.
- Findings and discussion threads.

Workbench-only ACP transcripts, run telemetry, permission requests, unread state, and local UI state move to SQLite in the future v2 format. Existing v1 `runs`, `agents`, `chat`, and `prompts` data receives an idempotent importer because it is already persisted user data. Legacy files are not deleted automatically during migration.

The current [`review-spec-v1.md`](review-spec-v1.md) remains authoritative until the persistence migration is implemented. That implementation must introduce and document a v2 specification before cutover.

External review artifact writes remain atomic. Rust serializes local read-modify-write operations per repository and uses stable revisions or compare-and-swap where external writers may race. Watcher events are deduplicated so Diffuse's own writes do not produce duplicate attention.

### Attention Persistence

Attention is device-local and must not be committed into `.diffuse/reviews`.

Acknowledgement is revision-based rather than timestamp-based. An acknowledgement transaction identifies the attention item and exact revision. If a newer revision already exists, the operation does not mark it read.

Input responses persist only the data needed for delivery and recovery. Secret values are never retained by default. A response changes an input request to resolved only after the ACP peer confirms acceptance; rejected, stale, timed-out, and superseded requests retain explicit terminal states.

## Agent Architecture

### ACP Hosts And Sessions

ACP supports multiple independent sessions on one agent connection. Diffuse therefore does not default to one process per session.

`AgentManager` owns a host pool keyed by adapter, authentication profile, executable configuration, and compatibility constraints. A capable host multiplexes sessions. The pool expands when an adapter serializes turns, becomes saturated, or requires workspace isolation. An adapter that cannot safely multiplex may opt into one process per session.

This is a resource policy, not a user-visible agent-count limit. Persisted and open sessions are not capped by an arbitrary product constant.

Each agent session stores:

- Workspace and optional review session association.
- Adapter and authentication profile reference.
- Remote ACP session ID.
- Advertised capabilities.
- Current mode and permission policy.
- Pending and completed turns.
- Reconnect or resume state.

On restart, Diffuse uses `session/resume` or `session/load` only when advertised. Otherwise it starts a new remote session and clearly marks continuity limitations instead of pretending the old process was resumed.

### Input Request Flow

The input flow is:

1. An ACP host requests permission, asks a question, or reports another blocking input.
2. `AgentManager` assigns a stable input ID and revision.
3. SQLite transactionally stores the input and its attention item.
4. `EventHub` publishes workspace summary and input events.
5. The rail and overview show `input-required` even if the workspace is inactive or the window is hidden.
6. The user opens the exact input surface and submits a response against the current revision.
7. `AgentManager` sends the response exactly once to the owning ACP session.
8. The input and attention resolve only after acceptance, cancellation, expiry, or supersession.

Closing or switching a workspace cannot reroute an input response to another workspace or session. Draft responses are scoped to input ID and revision.

### Diffuse MCP Tools

Diffuse exposes repository and review capabilities to ACP sessions through session-scoped MCP tools. Tool scope is bound server-side to workspace, generation, review session, and agent turn.

Initial tools cover:

- List assigned changed files.
- Read diff metadata or requested diff ranges.
- Add a validated review finding.
- Update review progress.
- Update user-visible agent activity.
- Read selected review threads when explicitly included as context.

This replaces generated repository tool files and process-global environment routing. An agent cannot select a different workspace by submitting another path or ID in its tool payload.

Review mode denies file edits and unrestricted terminal use by default. Interactive coding mode follows the configured ACP permission policy and routes undecided permissions to durable input requests.

## Concurrency And Resource Management

Rust uses Tokio for asynchronous process and filesystem I/O and a bounded CPU pool for parsing or other CPU-heavy analysis.

The initial resource model uses simple priority classes:

| Priority | Work |
| --- | --- |
| Interactive | Active diff loads, syntax viewport ranges, navigation, input responses, and user commands. |
| Foreground agent | Agent work explicitly being viewed or awaited in the active workspace. |
| Background agent | Turns running in inactive workspaces. |
| Maintenance | Indexing, cache cleanup, restore, and speculative analysis. |

The resource manager reserves capacity for interactive requests. It bounds CPU-heavy and Git subprocess work, but it does not impose a fixed user-visible limit on workspaces or agent sessions.

Concurrency rules are:

- The registry lock is never held during repository, database, LSP, ACP, or parsing work.
- Per-workspace locks use a documented order and are never held across unrelated external I/O.
- Every long operation has cancellation and a deadline where meaningful.
- Closing a workspace rejects new work before cancelling existing work.
- Watcher and activity events may be coalesced.
- Input requests, failures, terminal transitions, messages, and acknowledgement changes are never dropped.
- Event and callback queues are bounded; sequence gaps trigger snapshots rather than unbounded memory growth.
- Inactive workspace caches and idle LSP sessions may be evicted without closing the workspace or agent sessions.
- Only the active workspace mounts expensive diff DOM and viewport syntax state.

## Failure And Recovery

| Failure | Required behavior |
| --- | --- |
| Renderer reload or crash | `AppCore` and agents continue; the renderer obtains a workbench snapshot and resumes events from a sequence. |
| Stale asynchronous result | The workspace generation or request ID mismatch causes the result to be discarded. |
| ACP host crash | Affected sessions enter reconnecting or failed state; Diffuse attempts capability-based resume and creates error attention if user action is needed. |
| Rust task panic | Catch at task and N-API boundaries where possible, mark the owning service or workspace degraded, and preserve the rest of `AppCore`. |
| Native process crash | The application exits; on the next launch, SQLite recovery and ACP capability-based resume restore durable state. |
| Repository moved or removed | Keep a `restore-failed` workspace entry with Locate, Retry, and Remove actions. |
| Permission loss | Mark the workspace degraded and create actionable attention. |
| Watcher overflow | Perform a full rescan and re-establish the watcher. |
| Sleep or wake | Revalidate roots and supervised processes before trusting previous running state. |
| Database migration failure | Preserve the original database, report a recoverable startup error, and avoid partial schema use. |
| Corrupt local database | Move the corrupt file aside, recover what can be read, rebuild caches, and retain repository review artifacts. |
| Stale input response | Reject it by revision and refresh the owning input instead of sending it. |

N-API removes the current ability to kill and restart only the Diffuse core process after a timeout. This is an accepted tradeoff of the unified core. The implementation must keep blocking work off Electron main, catch Rust panics at native entry points, expose service health, and avoid loading downloaded native parser libraries into the application process.

Common trusted Tree-sitter parsers may be linked or shipped as vetted native code. Optional downloaded grammars use Tree-sitter WASM support or another explicit isolation boundary.

## Security Requirements

- Keep `contextIsolation` enabled and Node integration disabled in the renderer.
- Expose only the typed `DesktopBridge` through preload.
- Validate command names, payloads, workspace IDs, generations, and navigation targets in Electron main and Rust.
- Scope MCP tools to the session's effective workspace roots.
- Keep credentials in the harness or platform keychain.
- Redact secrets, prompt bodies where configured, and sensitive environment values from logs.
- Pass only explicitly allowed environment variables to ACP and LSP child processes.
- Never treat renderer-provided paths as authority after workspace creation.
- Require explicit confirmation for destructive workspace, worktree, and agent actions.

## Observability

Structured native logs include workspace, generation, agent session, turn, request, and job IDs where relevant. They do not include hidden reasoning or secrets.

The workbench exposes enough health state to distinguish:

- Workspace opening or restore.
- Repository watcher health.
- LSP health.
- ACP host and session health.
- Pending input delivery.
- Database or migration failure.
- Backpressure and cancelled work.

Metrics and logs must preserve the distinction between slow foreground interaction and expected long-running background work.

## Architectural Invariants

The implementation is not complete unless these invariants hold:

1. Diffuse creates one primary workspace window.
2. Exactly zero or one workspace is active in that window.
3. Inactive workspaces can run without retaining mounted workspace DOM.
4. Every workspace-bound command, result, callback, event, and tool call has explicit workspace identity.
5. A closed workspace generation cannot receive new state.
6. Switching workspaces does not stop background work or acknowledge attention.
7. Acknowledging attention does not resolve its underlying input or error.
8. A removed workspace cannot own invisible Diffuse-managed agents.
9. Renderer loss does not imply core or agent loss.
10. SQLite and `.diffuse/reviews` do not both own the same durable entity.
11. Background work cannot starve active diff interaction.
12. Optional downloaded native parser code does not execute in the application process.

## Implementation Plan

The migration keeps a runnable application at the end of every phase. A phase does not remove its fallback until its exit criteria pass on all supported platforms.

### Phase 0: Baseline And Contract Guardrails

Purpose: make current behavior measurable and create a safe boundary for all later transport and workspace changes.

Implementation status: Complete with performance capture deferred. The renderer-owned bridge, required-parameter typing, runtime event validation, null-ID error handling, contract drift checks, app tests, deterministic RPC fixture, and CI test wiring are implemented. The correctness observations and deferred cross-platform performance capture are tracked in [`phase-0-baselines.md`](phase-0-baselines.md).

Work:

- Add a renderer-owned `DesktopBridge` interface and make the current Electron preload implement it.
- Harden `app/src/lib/coreContract.ts` so methods with required params cannot be called without them.
- Add a runtime list and validator for every core event.
- Distinguish JSON-RPC errors with `id: null` from notifications in `CoreRpcClient`.
- Extend `scripts/check-rpc-contract.mjs` to detect duplicate methods, method-map drift, and event-name drift.
- Add app unit-test infrastructure and mocked `DesktopBridge` fixtures.
- Add deterministic repository fixtures for RPC methods, errors, defaults, events, and review persistence.
- Run `zig build test` in normal CI and release CI.
- Record Electron startup, idle memory, large-diff interaction, event throughput, and current agent-run baselines.

Exit criteria:

- The current single-workspace application still behaves the same.
- The bridge can be replaced without changing feature components.
- Method and event contract drift fails CI.
- Baseline tests cover repository opening, diff rendering, review persistence, search streaming, and agent-run lifecycle.

### Phase 1: Workspace-Aware Electron Facade

Purpose: remove per-window identity assumptions before replacing Zig.

Implementation status: Complete. The shared workbench contract, explicit request contexts, application-wide legacy workspace registry, canonical-root deduplication, generation rejection, contextual event envelopes, single primary window, second-instance activation, renderer snapshot restoration, and isolated single-owner legacy review runner are implemented. Workspace IDs remain in-memory until Phase 3 adds SQLite persistence.

Work:

- Introduce `WorkspaceId`, `WorkspaceGeneration`, request context, summaries, snapshots, and event envelopes in the shared contract.
- Make every workspace-bound renderer request explicitly select a workspace.
- Add an Electron-main legacy workspace registry that temporarily maps each workspace to its own current Zig `CoreRpcClient`.
- Tag legacy core events with workspace ID and generation before forwarding them.
- Cancel and reject stale requests when a legacy workspace closes.
- Change second-instance repository opens to add or activate a workspace in the existing window.
- Keep the legacy opencode runner isolated behind the facade; do not expand its process-global routing model.

The per-workspace Zig processes are a temporary migration adapter, not the target architecture.

Exit criteria:

- Two repositories can be addressed independently through one Electron main process without relying on an active global repository.
- Rapidly interleaved requests and events cannot cross workspace IDs.
- Closing and reopening a root changes its generation and rejects stale callbacks.

### Phase 2: Single-Window Workbench UI

Purpose: deliver and validate the final workspace interaction model while the legacy backend remains available.

Implementation status: Complete. `useWorkbenchStore()` owns summaries, stable rail order, active presentation, event sequence, restore state, and bounded workspace-keyed UI records. The `76px` rail compacts to `52px` near the `900px` boundary; changed files and pinned search become drawers there. Workspace-prefixed routes, global overview, searchable switcher, roving tablist focus, configurable navigation commands, one active heavy component tree, route/diff/search/cursor/draft/focus restoration, renderer reload capture, and hide/reopen/tray lifecycle are implemented. Full input/error/unread attention counts remain Phase 5 because Phase 1 does not yet expose those durable entities.

Work:

- Add `useWorkbenchStore()` for workspace summaries, active ID, rail order, global attention, and restore state.
- Refactor repository, diff, review, search, and cursor state to be explicitly workspace-scoped.
- Prefix workspace routes with `/w/:workspaceId` and add `/workbench`.
- Add feature components under a workbench or workspace feature directory:
  - `WorkspaceRail.vue`.
  - `WorkspaceRailItem.vue`.
  - `WorkspaceSwitcher.vue`.
  - `WorkbenchOverview.vue`.
  - `WorkspaceAttentionBadge.vue`.
- Preserve route, cursor, search, drafts, and focus independently for at least two workspaces.
- Unmount inactive workspace content while retaining bounded restoration state.
- Add next, previous, direct-slot, overview, and switcher commands to the keybinding system.
- Add one-window close, hide, reopen, and tray behavior.
- Add component and keyboard tests for rail, overflow, focus restoration, and narrow layouts.

Exit criteria:

- Opening another repository never creates a workspace window.
- Switching repeatedly does not reset or leak route, review target, diff, cursor, search, or draft state.
- Inactive repository and agent events update only their workspace summary.
- The rail and overview work with keyboard, screen reader labels, high contrast, reduced motion, and 200 percent zoom.
- Renderer reload restores the workbench without reopening repositories manually.

### Phase 3: Rust Core And Workbench Database

Purpose: create the transport-neutral application core and durable workspace model.

Implementation status: In progress. The Cargo workspace, `diffuse-core`, and `diffuse-cli` are implemented. The first complete domain slice covers product version, repository opening and canonicalization, diff-target defaults, and local/remote branch listing. `AppCore` owns an explicit multi-workspace registry with stable SQLite workspace IDs, per-open generations, stale-generation rejection, bounded event replay, snapshots, and asynchronous Git execution. Schema migration v1 creates local workspace, UI restoration, agent session, input request, and attention tables. A focused differential suite runs the selected RPC slice against both Zig and Rust on the same deterministic repositories. Zig remains the packaged desktop backend while the remaining slices below are ported; selecting the Rust executable is whole-backend and unported methods return method-not-found rather than falling back to Zig.

Work:

- Add the Cargo workspace and `diffuse-core` plus `diffuse-cli` crates.
- Implement `AppCore`, `WorkspaceRegistry`, generations, snapshots, cancellation, event sequencing, and service health.
- Add SQLite migrations for workspaces, UI restoration, agent sessions, input requests, and attention.
- Implement a line-delimited JSON-RPC adapter in `diffuse-cli` so Electron can opt into the Rust backend through the existing executable seam.
- Port complete domain slices in this order:
  1. Protocol, version, repository opening, branch listing, and diff targets.
  2. Changed files, source resolution, and diff render models.
  3. Review persistence and v1 compatibility reads.
  4. Search and cancellation.
  5. Cross-platform repository watching.
  6. LSP configuration and lifecycle.
  7. Tree-sitter syntax and safe grammar loading.
- Run Zig and Rust against normalized differential fixtures until the selected slice matches.
- Select one whole backend implementation for a workspace; never proxy individual methods between Zig and Rust state.

Exit criteria:

- Rust passes the method, event, persistence, and CLI parity suite.
- One Rust `AppCore` manages multiple workspace runtimes without ambient active-repository state.
- SQLite migration and recovery tests pass across supported platforms.
- Cross-workspace race and cancellation tests pass.

### Phase 4: In-Process N-API Core

Purpose: remove the separate Diffuse core process while retaining the proven Electron/Vue shell.

Work:

- Add the thin `diffuse-node` N-API crate.
- Load one native addon instance in Electron main and initialize one `AppCore`.
- Map typed Electron requests to asynchronous Rust calls without blocking Node's main thread.
- Deliver batched native events through a thread-safe callback.
- Add bounded shutdown and health reporting.
- Package and sign the addon for the supported operating-system and architecture matrix.
- Keep the Rust JSON-RPC executable temporarily available for differential and rollback testing.
- Compare Electron plus N-API against the captured Electron plus Zig baselines.

Exit criteria:

- The normal desktop app does not spawn a Diffuse core child process.
- Closing and reopening the renderer preserves Rust workspace and background state.
- Native calls do not block Electron main during large Git, diff, syntax, LSP, or database operations.
- Addon packaging, updates, and clean installs pass on Windows, macOS, and Linux.

### Phase 5: Durable Attention And Hybrid Review Migration

Purpose: implement the exact needs-input and unread behavior defined by this specification.

Work:

- Implement input and attention state machines with revision-based compare-and-swap.
- Make input creation, attention creation, and event publication transactionally ordered.
- Persist rail order, active workspace, restoration state, and exact acknowledgement revisions.
- Add aggregate workspace summaries and attention navigation targets.
- Add one-time idempotent import for current v1 run, agent, chat, and prompt records.
- Introduce `review-spec-v2.md` before changing canonical storage ownership.
- Keep portable review sessions, progress, reviewed files, and threads under `.diffuse/reviews`.
- Add OS notifications and tray aggregation for pending input and terminal failures.

Exit criteria:

- The acknowledgement truth table has exhaustive unit tests.
- A new revision racing with acknowledgement remains unread.
- Viewing, answering, rejecting, expiring, superseding, and cancelling input produce distinct correct states.
- Device-local attention never modifies repository review artifacts.
- Legacy review data imports once without deletion or duplication.

### Phase 6: ACP Agent Workbench

Purpose: replace the provider-specific Electron runner with reusable Rust ACP supervision.

Work:

- Implement ACP adapter configuration, discovery, initialization, and capability storage.
- Implement host pooling and multiple sessions per capable connection.
- Implement session new, load, resume, close, prompt queue, cancellation, and reconnect behavior.
- Normalize streamed messages, tool calls, modes, plans, and user-visible activity into domain records.
- Route ACP permission and question requests through durable input requests.
- Attach workspace-scoped Diffuse MCP review tools to each session.
- Add direct chat, review runs, and session history to the active workspace routes.
- Remove process-global review bridge environment routing.
- Keep the existing Node runner only until equivalent start, stop, chat, finding, progress, and recovery behavior passes.

Exit criteria:

- Multiple workspaces can run concurrent agent turns without routing collisions.
- A capable host can serve multiple sessions, and a host crash affects only its mapped sessions.
- Pending input in an inactive workspace appears in the rail, overview, tray, and restored snapshot.
- Agents continue after the workbench window closes and stop on explicit Quit.
- Review mode cannot write files or run unrestricted terminal commands without an explicit policy change.

### Phase 7: Performance, Fault Injection, And Cross-Platform Hardening

Purpose: prove the architecture under realistic workbench load before removing fallbacks.

Work:

- Profile one, eight, and thirty-two active agent sessions plus at least one thousand persisted sessions. These are stress profiles, not product limits.
- Verify the active diff remains responsive under background agent, watcher, LSP, search, and database load.
- Add bounded cache eviction and idle LSP cleanup based on measurements.
- Add diff-range or pagination APIs only where profiling shows full models are a bottleneck.
- Test rapid workspace switching during diff loads, search streams, syntax requests, and review writes.
- Test renderer crash and reload, ACP crash, N-API panic boundaries, application restart, sleep and wake, repository removal, watcher overflow, and database corruption recovery.
- Test Linux, macOS, and Windows path canonicalization, watchers, tray behavior, notifications, LSP, and packaging.
- Audit accessibility with keyboard-only operation and supported screen readers.

Exit criteria:

- Background work does not produce unbounded memory, process, callback, or event queues.
- Interactive latency remains within the benchmark budget established in Phase 0.
- Every documented failure path has an automated or repeatable manual test.
- No supported platform has a blocking workspace, attention, lifecycle, or packaging defect.

### Phase 8: Cutover And Legacy Removal

Purpose: make the Rust Agent Workbench the only supported architecture.

Work:

- Make N-API `AppCore` the default and remove the Zig desktop runtime.
- Remove per-workspace legacy core processes and JSON-RPC desktop routing after the rollback period.
- Remove `ReviewAgentRunner`, generated opencode tools, and the localhost bridge after ACP parity.
- Update build requirements, installers, release CI, versioning, signing, command shims, and completions.
- Keep the separate Rust CLI linked to `diffuse-core`.
- Update [`architecture.md`](architecture.md), [`README.md`](../README.md), [`lsp.md`](lsp.md), the review specification, and the design system to describe implemented behavior rather than the migration.
- Remove transitional contract fields and adapters rather than preserving them indefinitely.

Exit criteria:

- A clean checkout builds, tests, packages, installs, updates, and uninstalls on all supported platforms.
- No production code assumes one repository per process or one workspace per window.
- No current documentation describes Zig, per-window core processes, or the Node provider runner as current behavior.
- Persisted v1 review data and known workspaces still restore through documented migration paths.

## Verification Matrix

### Unit Tests

- Workspace root canonicalization and worktree deduplication.
- Workspace load-state transitions and generation rejection.
- Attention priority, acknowledgement, resolution, and revision races.
- Input accepted, rejected, stale, expired, cancelled, and superseded states.
- Resource priority and cancellation.
- SQLite migrations and v1 import idempotence.
- ACP capability gating and host-pool assignment.

### Integration Tests

- Interleaved requests and events for two or more repositories.
- Switch away during a long diff and apply the result only to its owning workspace.
- Close and reopen a workspace while stale callbacks are in flight.
- Start an agent in workspace A, switch to B, and answer A's input without routing it to B.
- Acknowledge one completion while a newer revision arrives.
- Reload the renderer while agents continue.
- Close the workbench window and reopen it from the tray or a second invocation.
- Import existing review data while an external review artifact writer is active.

### End-To-End Tests

- Open, switch, reorder, close, restore, locate, and remove workspaces.
- Navigate the rail, overview, and input surfaces using only the keyboard.
- Preserve file, folder, review, agent, search, cursor, and draft context across switches.
- Show input-required, error, unread, running, and idle states without relying on color.
- Install and update a packaged build with the N-API addon.

### Performance Tests

- Large changed-file lists and large split or inline diffs.
- High-rate agent message and activity streams.
- Many persisted workspaces and sessions at startup.
- Concurrent Git, search, watcher, syntax, LSP, and agent load.
- Renderer memory after switching through many workspaces.
- Native callback and event-queue backpressure.

## Deferred Decisions

These choices do not block the architecture and should be resolved from prototypes and measurements:

- Whether optional grammar WASM ships in the first Rust release or follows bundled trusted parsers.
- Exact idle time before evicting LSP sessions and native caches.
- Adapter-specific ACP host pooling policies.
- Notification defaults when the workbench window is hidden.

They must not change the single-window model, explicit workspace identity, attention semantics, or persistence ownership defined by this specification.
