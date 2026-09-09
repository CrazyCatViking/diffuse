# Diffuse Review Spec v2

This specification defines the durable ownership and migration boundary introduced by Phase 5 and extended by the delivered Phase 6 ACP workbench. It remains a **hybrid v2 boundary**, not a complete move of portable review data into SQLite. The document version, SQLite schema version (currently 7), and ACP protocol version (1) are distinct. Feature delivery does not imply real-provider/manual platform verification. Legacy formats and the retired runner's historical contract remain in [`review-spec-v1.md`](review-spec-v1.md).

## Authority

Each durable entity has one authoritative store.

| Store | Authoritative data |
| --- | --- |
| Repository-local `.diffuse/reviews` | `config.json`, `active-session`, each session's `review.json`, `progress.json`, `reviewed-files.json`, and `threads/*.json`. |
| Device-local `<Electron userData>/workbench.sqlite3` | Workspace identity, canonical root, rail order, open/active state, UI restoration and main-owned review-wave plans, input requests/non-secret responses, attention lifecycle/revisions, typed legacy archives, ACP adapters, sessions/immutable file scopes/incarnations, queues, history/activity and input delivery claims. |

The portable files may be committed, copied with a repository, or consumed by integrations. SQLite is local to one Diffuse installation and must not be copied into the repository. Device-local attention, acknowledgement, notification delivery, input state, and UI state are never written into `.diffuse/reviews`.

## Portable Review Layout

The authoritative portable subset is:

```text
.diffuse/
  reviews/
    config.json
    active-session
    sessions/
      <session-id>/
        review.json
        progress.json
        reviewed-files.json
        threads/
          <thread-id>.json
```

The formats and atomic-write requirements for these files remain those in [`review-spec-v1.md`](review-spec-v1.md). Phase 5 does not duplicate these entities into SQLite as a second authority.

## Device-Local SQLite

The normal desktop database is `<Electron userData>/workbench.sqlite3`. Current schema migration version 7 retains the Phase 5 tables and incrementally extends ACP persistence:

- `workspaces`: stable device-local workspace identity, canonical location, open state, generation, and rail order.
- `app_state`: application-wide state including the active workspace.
- `workspace_ui_state`: revisioned per-workspace UI restoration records.
- `agent_sessions`: device-local agent-session metadata and state, now populated by Rust ACP supervision; the existing source for running counts.
- `input_requests`: revisioned input requests, non-secret response state, and distinct lifecycle outcomes.
- `attention_items`: durable input, error, and completion attention with acknowledgement and notification-claim revisions.
- `legacy_review_import_ledger`: import identity, status, provenance, and retryable diagnostics.
- `legacy_import_runs`, `legacy_import_agents`, `legacy_import_chats`, and `legacy_import_prompts`: typed read-only archives of the four legacy v1 device-local artifact families.
- `acp_sessions`: schema 3 JSON snapshots linked one-to-one to `agent_sessions` with cascading deletion.
- `acp_activity`: schema 3 append-only activity records linked to ACP sessions with cascading deletion, indexed by session and sequence.
- `acp_adapters`: schema 4 invocation definitions, environment key names and authentication profile references, not environment values or credentials.
- `acp_turns`: schema 4 ordered durable prompts, unique by session/request ID, with admission and terminal state.
- `acp_history`: schema 4 normalized message, tool, plan, mode, input-request and activity records.
- `acp_replay_history`: schema 4 staging for successful `session/load` transcript replacement.
- `acp_input_delivery`: schema 4 response delivery claims linked to the existing durable input records.
- `acp_session_incarnations`: schema 5 local worker ownership tokens bound to session, workspace and generation.
- `acp_legacy_quoted_scopes`: schema 7 session markers for potentially display-quoted pre-v7 file assignments, linked to `acp_sessions` with cascading deletion.

Schema 6 introduced immutable shard-scope compatibility with a migration-version marker: older cores must reject the database instead of silently discarding `reviewFileIds`. Scope lives in `acp_sessions.snapshot_json`. Schema 7 adds a reconnect guard for ambiguous legacy display-quoted assignments when switching to literal Git file IDs; it does not rewrite old session IDs, scope JSON or history. Existing snapshots without the scope field retain whole-review semantics. Main-owned review waves still use `workspace_ui_state` and its revision checks.

These names describe the current ownership model; they are not a public SQL API. Private columns, indexes, triggers, quarantine tables, and migrations may change. Integrations must use documented Diffuse contracts and must not edit the database manually.

## Legacy v1 Import

Four v1 families are transitional device-local artifacts rather than portable v2 authorities:

```text
sessions/<session-id>/runs/*.json
sessions/<session-id>/agents/*.json
sessions/<session-id>/chat/messages/*.json
sessions/<session-id>/prompts/*.md
```

Diffuse imports these artifacts when a workspace opens. The importer has the following guarantees:

- Reads are capability-confined below the opened repository and use no-follow directory and file access. Symlinked directories or artifacts are not traversed.
- JSON artifacts are limited to 8 MiB and prompts to 1 MiB. JSON must be a UTF-8 object with a non-empty `id`; prompt identity comes from the filename.
- Every archived entity records workspace ID, review session ID, entity ID, relative source path, SHA-256 content hash, and import time. The ledger records the same source identity and either imported provenance or a diagnostic.
- An unchanged artifact at the same source path is a no-op. Changed content at that path replaces the prior archive entity. Reusing an entity ID at another path also replaces that entity, so the typed archive does not accumulate duplicates.
- Malformed, oversized, non-UTF-8, non-regular, symlinked, or otherwise unreadable artifacts produce durable diagnostics. The importer runs again on a later workspace open, so correcting the source makes the failure retryable.
- Importing or diagnosing an artifact never creates historical attention. Old completions and failures do not become newly unread simply because migration ran.
- Source files are never modified or deleted by the importer.

Each artifact and its ledger update are committed transactionally. Database failures can fail workspace opening; an invalid individual artifact is recorded as a diagnostic and does not prevent other artifacts from being considered.

## Retired Runner Migration

The Electron/Node opencode runner, SDK dependency, private runner IPC and environment-routed bridge are retired from desktop execution. Its v1 `runs`, `agents`, `chat/messages`, and `prompts` files remain historical data. The importer is still a read-only compatibility archive, not a write-through replacement for legacy file APIs. No historical artifacts are deleted or rewritten as ACP transcripts.

ACP sessions, turns, transcripts, inputs and history live in device-local SQLite, never in legacy runner files. MCP findings, merged shard progress, reviewed-file state and threads use the portable files above. Review/chat bindings, adapter selection, retry request IDs and main-owned wave plans are device-local `workspace_ui_state`, not a second transcript authority. `maxParallelAgents` and `promptInstructions` now drive native review waves; preserved legacy provider/model/agent fields and environment overrides are not auto-translated into adapter settings. Users must configure supported invocation arguments explicitly. Migration preserves old generated `.opencode/tools/diffuse_review.ts`; disable/remove it explicitly if an adapter auto-loads it, since its retired Node bridge is unavailable.

## ACP Session And Activity History

The current model is exposed through the [native desktop ACP API](architecture.md#native-acp-workbench) and Rust methods, not through the Diffuse RPC rollback adapters.

### Sessions And Queues

`SessionSnapshot` uses camelCase fields: `id`, `hostId`, `workspaceId`, `workspaceGeneration`, `adapterId`, `remoteSessionId`, `capabilities`, `state`, `turnId`, `permissionPolicy`, `reviewSessionId`, optional `reviewFileIds`, `modes`, `authenticationProfile`, `historyRevision`, and `continuity`. Session states remain `starting`, `ready`, `running`, `failed`, and `closed`. Continuity is `unknown`, `new`, `resumed`, `loaded`, or `reset`. Local session, host, turn, workspace generation and worker incarnation identities are distinct; pooled sessions may share a host ID. Review-bound sessions must use `deny-all`; non-review sessions may explicitly choose `interactive`.

`reviewFileIds` is an immutable authorization assignment, canonicalized by sorting and validated against the bound review's changed-file IDs at launch/reconnect. When supplied it must be a nonempty unique array of at most 1,024 IDs, at most 4,096 UTF-8 bytes per ID and at most 128 KiB total ID bytes, and requires `reviewSessionId`. Explicit `null`, empty/duplicate lists and foreign IDs are invalid. Omission on reconnect preserves the stored scope; a different explicit assignment is rejected. Existing sessions without a stored field retain whole-review scope. Scoped MCP reads/writes/results cannot escape the assignment; progress merges only assigned file states into the portable review-wide summary and validates counts/disjointness before commit.

Current Rust IDs come from NUL-delimited Git name/status and numstat metadata, preserving actual UTF-8 paths rather than display-quoted text. Rename counts follow the canonical new path. IDs themselves cannot contain NUL. Exact-file diff/signature queries use top-level literal pathspecs, exclude descendants and clear inherited Git pathspec-mode environment overrides; wildcard/magic-looking filenames do not authorize other paths. See [repository path handling](architecture.md#repository-diff-syntax-and-lsp).

During migration to schema 7, any existing session with a stored `reviewFileIds` string beginning with `"` is marked in `acp_legacy_quoted_scopes`. This is deliberately conservative: the old string may be a display-quoted representation, or a genuine quote-prefixed name whose origin cannot now be distinguished. Reconnect of a marked session is rejected with `saved reviewFileIds use legacy Git display quoting; start a new session with current changed-file IDs`. Supplying a replacement list or omitting scope does not bypass the guard. Start a new session/review from current metadata; do not reinterpret or automatically unquote the old assignment.

The migration is idempotent and keeps old session IDs, scope values and historical records intact and readable; it adds markers only for sessions present during the upgrade. It does not mark ordinary legacy scopes or whole-review sessions. New sessions created after migration may use literal quote/backslash filenames, including a string equal to an old display representation, because that newly selected scope comes from current metadata. The schema bump also prevents older cores from bypassing this compatibility guard.

`QueuedTurn` contains `id`, `sessionId`, `requestId`, `text`, `state`, and `stopReason`. The desktop queue commits before acknowledging submission. A repeated `(sessionId, requestId)` with identical text returns the existing turn; changed text is rejected. Queued work is FIFO by private ordinal, with at most 64 queued turns per session and 32 KiB of text per prompt. States are `queued -> admitted -> running -> completed | cancelled | failed`; a queued turn may be cancelled directly. Session snapshots expose the most recent 100 turns, not an unbounded queue history response. The lower-level Rust immediate-prompt API still provides admission only, not this durable acknowledgement.

Session failure marks admitted/running turns failed but preserves never-admitted queued work. Explicit session close cancels queued and admitted/running work. Neither failure nor startup recovery automatically retries an interrupted turn. Queued work continues only after explicit reconnect succeeds. Reconnect preserves the session identity/scope/policy/profile and selects advertised resume, then load, otherwise a new remote session with `reset` continuity; a rejected resume/load is not an automatic retry cascade.

### Main-Owned Wave Plans

`workspace_ui_state.state.acpReviewWaves` contains durable `ReviewWaveRun` plans: run/workspace/generation/review/adapter IDs, creation time, bounded prompt, parallel count, status/error, and shards with `fileIds`, stable `requestId`, optional `sessionId`/`startedAt`, and state. Run/shard states are `queued`, `starting`, `running`, `completed`, `cancelled`, and `failed`. These are scheduler records, separate from durable ACP turn states and transcript history.

Electron main creates a plan from the saved review target and configuration, partitions by `maxParallelAgents` and splits oversized scopes into waves. It persists plans with compare-and-swap before launch, preserves the main-owned key across renderer UI saves, and uses scoped native sessions plus stable queue request IDs. Renderer reload does not stop scheduling; a new scheduler reads persisted plans. Completed shard sessions close before replacement waves launch, bounding active sessions per run. Cancellation is persisted before stopping owned sessions. Non-forced workspace close rejects active waves; forced close cancels them first.

Plan recovery does not replay interrupted execution. Existing failed/cancelled/missing shard sessions fail the run and cancel unstarted work; never-launched shards may be started as new work when the persisted plan is otherwise valid. No failed host is automatically reconnected. Users inspect/reconnect a session explicitly or start a new review. Application quit disposes scheduling before native shutdown. The 1,034-file native fixture verifies two bounded scopes and persisted completion without a renderer, not an unlimited-plan/storage guarantee.

### History And Replay

`SessionActivity` contains `sequence`, `sessionId`, optional `turnId`, `kind`, and `payload`; SQLite also stores creation time. It records session/turn lifecycle, peer updates, input activity, permission denial and continuity/history changes. `HistoryEntry` has its own `sequence`, `sessionId`, optional `turnId`, `kind`, and `content`. Normalized kinds include `user-message`, `agent-message`, `tool-call`, `plan`, `mode`, `input-request`, and `activity`. Prompt text is durable; `agent_thought_chunk` updates are discarded and historical first-slice thought activity is excluded from public activity reads. Presentation is text-only, not a multimodal transcript contract or a general secret-redaction guarantee.

History and activity reads each return up to 100 records with `sequence > after`, in ascending order. Start at 0 and advance to the last returned sequence. Each table has a database-wide cursor that is not consecutive per session and is independent of both event streams. Current-generation requests can read earlier-lifetime history for the same stable workspace.

During `session/load`, replay updates are staged in `acp_replay_history` rather than appended to the live transcript projection. On success, one transaction replaces the session's replayable user/agent messages, tools, plans and modes from staging and persists the incremented `historyRevision`. Input/audit history, turn outcomes and raw activity remain separate. Failed load does not replace the previous transcript; staging is cleared on the next start or application recovery. Consumers must clear cached transcript cursors and reload when `historyRevision` changes or `agent/historyReplaced` arrives, rather than append duplicate replay text.

Schema 4 backfills normalized history and turn outcomes from schema 3 activity, excluding thought chunks from the normalized projection. Historical turns without a terminal outcome become failed with `historical-interruption`; completed/cancelled outcomes are retained. This migration creates no historical attention and does not modify portable review files or legacy archives. Schema 5 adds incarnation ownership without replacing that history.

### Fencing And Recovery

Each launched worker claims a fresh `acp_session_incarnations` token for the local session ID and open workspace generation. Activity commits and queue claims validate that token as well as workspace ownership/open generation. A reconnect cannot start over a still-cleaning-up local worker; old workers cannot overwrite the new incarnation even if the workspace generation did not change.

An immediate activity transaction updates session metadata/snapshot, activity, affected turns and normalized history together. The shared Phase 5 gate covers commits, absolute summary construction and event enqueue; actual delivery occurs outside it. ACP terminal attention uses a subsequent durable mutation under the gate, not the same activity transaction. `getAcpSnapshot` includes sessions, turns, pending input metadata, summary, ACP `sequence` and separate `workbenchSequence`. Those process-local watermarks are not history cursors. The separate native ACP stream supports replay and explicit snapshot recovery on overflow, while workspace generations and renderer view epochs reject stale presentation. Phase 5's event/revision guarantees below remain unchanged.

At `AppCore` construction, recovery clears worker incarnations and replay staging, marks admitted/running turns failed with `application-restarted`, expires unresolved ACP inputs/attention, and changes sessions left starting/ready/running to failed with one `session-ended` restart record. It preserves queued turns, remote IDs and committed history. Repeating recovery does not append another terminal record, and no host is automatically restarted. Workspace close drains foreground input mutations before checking pending input; a refused non-forced close preserves the live host. Accepted close/shutdown cancels and drains owned background work before removal.

### ACP Inputs And Attention

Interactive `session/request_permission` choices and supported `elicitation/create` forms use durable Phase 5 input/attention records with session metadata. Review permissions are always denied; form questions are permitted without granting filesystem or terminal capabilities. Input answers use exact expected revisions and are validated before delivery; `acp_input_delivery` claims prevent duplicate sends after answer replay. Delivery leaves the request `response-submitted`; success of the enclosing session/prompt/mode operation marks a delivered answer accepted. There is no separate provider acknowledgement RPC and no exactly-once delivery guarantee across a process crash. Turn cancellation, peer cancellation and session/restart expiry have distinct outcomes. Form decline is a submitted form action, not a new input status.

Non-cancelled completed turns create completion attention and failed sessions create error attention; successful explicit reconnect resolves its prior session error. Exact focus/navigation acknowledgement, revision claims and summary priority remain the Phase 5 contract. Secret responses are unsupported by ACP forms; provider authentication belongs to the adapter. Adapter definitions persist only environment key names, but arguments, prompts, form responses and peer JSON can contain sensitive data and are not automatically scrubbed. Do not put credentials in these fields.

## Input And Attention Semantics

Workspace attention is summarized in this priority order:

1. `input-required`
2. `error`
3. `unread`
4. `running`
5. `idle`

Priority affects presentation only; category counts remain available. Selecting a workspace does not acknowledge any item.

Attention acknowledgement and notification delivery use compare-and-swap against one exact item revision. A stale acknowledgement or notification claim cannot consume a newer revision. Acknowledgement changes read emphasis but does not resolve an input request or error.

Input requests move through these states:

```text
pending -> response-submitted -> accepted | rejected
pending | response-submitted -> expired | cancelled | superseded
```

Submitting a response emits `input/responseSubmitted` and leaves the request unresolved in `response-submitted` until the owning producer confirms `accepted` or `rejected`. `accepted`, `rejected`, `expired`, `cancelled`, and `superseded` are distinct terminal states. Cancellation is allowed only when the request says it is supported.

Secret authentication values never persist in SQLite, `.diffuse`, renderer restoration state, or the import archive. A secret response may leave only a redacted marker indicating that a secret was submitted. Non-secret responses may be persisted for delivery and restoration.

## Transaction And Event Guarantees

Input creation and its attention item are one SQLite transaction. Input terminal transitions and the corresponding attention lifecycle update are also one transaction. UI-state revisions, attention acknowledgement, and notification claims use revision checks so stale writers return an authoritative current record instead of overwriting it.

Phase 5 events are enqueued only after their durable mutation commits and are delivered in process sequence order. The authoritative snapshot includes workspace summaries, aggregate attention, attention items, input requests, revisioned UI state, legacy import reports, restore diagnostics, and the event sequence. Consumers recover from a sequence gap by loading a fresh snapshot rather than treating the event stream as durable history.

## Migration Limits

- Phase 6 current features are delivered, including native bounded review waves and desktop Node-runner retirement. Windows Job Object containment is implemented and cross-target Clippy verified, not Windows runtime verified. Linux fake-peer/native/app tests do not establish real-provider or manual Windows/macOS/OS notification behavior. Presentation remains text-only; legacy overrides require explicit adapter migration rather than automatic translation.
- Adapters are trusted executables, not sandboxed code. Unix group cleanup does not contain escaped descendants; HTTP MCP capability is required for bound review tools. See [runtime limits](architecture.md#native-acp-workbench).
- The SQLite archive is not a write-through compatibility layer for v1 APIs.
- The RPC rollback backend reports degraded health and does not implement durable Phase 5 attention, input, or restore-failure mutations.
- No public stability is promised for the SQLite file or its private schema details.
