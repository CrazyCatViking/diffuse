# Diffuse Review Spec v2

This specification defines the durable ownership and migration boundary introduced by Phase 5, extended by the first Rust-only Phase 6 ACP slice. It remains a **hybrid transitional v2 boundary**, not a complete move of review data into SQLite or a completed Phase 6 format. The document version, SQLite schema version (currently 3), and ACP protocol version (1) are distinct. The legacy file formats remain documented in [`review-spec-v1.md`](review-spec-v1.md).

## Authority

Each durable entity has one authoritative store.

| Store | Authoritative data |
| --- | --- |
| Repository-local `.diffuse/reviews` | `config.json`, `active-session`, each session's `review.json`, `progress.json`, `reviewed-files.json`, and `threads/*.json`. |
| Device-local `<Electron userData>/workbench.sqlite3` | Workspace identity, canonical root, rail order, open/active state, UI restoration, input requests and non-secret responses, attention lifecycle, exact acknowledgement and notification revisions, typed legacy archives, and first-slice ACP session snapshots and activity history. |

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

The normal desktop database is `<Electron userData>/workbench.sqlite3`. Current schema migration version 3 retains the Phase 5 tables and adds ACP snapshots and activity:

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

## Transitional Runner Contract

The retained Electron/Node opencode runner continues to read and write the legacy v1 `runs`, `agents`, `chat/messages`, and `prompts` files until the Phase 6 ACP cutover. The importer is a compatibility archive for already persisted data and newly encountered legacy files. It does **not** mean that current legacy review APIs or the Node runner read those archive tables.

The first ACP slice writes session snapshots and activity only to device-local SQLite, not to v1 runner files or portable review artifacts. Future normalized turns, messages, input, and workbench history belong in that same device-local store. Portable findings, review progress, reviewed-file state, threads, session targets, and repository review configuration continue to use the portable files above. The Rust slice does not perform the Node runner cutover.

## ACP Session And Activity History

Schema 3 adds the following private persistence model, exposed for consumption only through the [Rust ACP API](architecture.md#rust-acp-first-slice), not N-API, RPC, or UI:

- `SessionSnapshot` serializes camelCase fields: `id`, `hostId`, `workspaceId`, `workspaceGeneration`, `adapterId`, `remoteSessionId`, `capabilities`, `state`, `turnId`, and `permissionPolicy`. Local session, host, and turn IDs are distinct; remote IDs are scoped to the isolated host. The policy is currently `deny-all`.
- Session states are `starting`, `ready`, `running`, `failed`, and `closed`. Successful initialization reaches `ready`; an admitted turn becomes `running` when recorded and returns to `ready` on a valid prompt outcome. Stopping the host produces `closed`; protocol, I/O, or deadline failure produces `failed`.
- `SessionActivity` contains `sequence`, `sessionId`, optional `turnId`, `kind`, and `payload`. SQLite additionally stores creation time. The autoincrement sequence is database-wide, not consecutive per session and not an EventHub sequence.
- Activity kinds are `session-starting`, `host-initialized`, `session-ready`, `turn-started`, `session-update`, `cancel-requested`, `turn-ended`, and `session-ended`. Prompt text is stored in `turn-started`; peer updates are retained as JSON payloads, not normalized message/tool/plan tables. `turn-ended` stores `stopReason`; session termination stores a reason or error. A failed or stopped turn may end with `session-ended` rather than `turn-ended`.
- `acp_activity(context, session_id, after)` reads up to 100 records in ascending sequence with `sequence > after`. Start at 0 and use the last returned sequence for subsequent pages. Reads are scoped to the workspace and session. A current-generation context can read historical snapshots/activity from earlier lifetimes of that same stable workspace; it does not make those sessions resumable.

An immediate transaction checks that the workspace is still open at the recorded generation, updates `agent_sessions` and `acp_sessions`, and inserts the activity record. The worker holds the shared Phase 5 coordination gate through this commit, authoritative absolute running-count summary construction, and enqueue of `acp/activity` with `{ session, activity }` followed by the ACP-stream workspace summary. Workbench snapshots and Phase 5 mutations share that gate, so concurrent ACP summaries are enqueued in committed session-state order. Delivery happens after releasing the gate. Prompt admission alone is not a durable acknowledgement. Stream overflow disconnects a slow subscriber; durable activity pagination and snapshots, not replay alone, are the recovery authority. ACP retains its separate event sequence and nonblocking delivery policy; sharing the gate does not merge it with the Phase 5 stream or weaken the guarantees below.

Before startup snapshots, `AppCore` construction transactionally changes ACP sessions left `starting`, `ready`, or `running` to `failed` and appends `session-ended` with `{ "reason": "application-restarted" }`, retaining the previous turn ID, remote ID, capabilities, and history. Repeating recovery does not append another terminal record. No process is resumed or rediscovered, even when stored capabilities advertise session loading. Workspace close drains admitted foreground mutations before checking pending input; a refused non-forced close preserves the live ACP host and restores workspace readiness. Accepted close and shutdown stop owned hosts before draining their background lifetime permits; old-generation activity writes cannot mutate a reopened workspace.

ACP start is Unix-only in this slice; non-Unix platforms return an explicit unsupported-platform error. A dedicated Unix process group contains ordinary descendants for stop, timeout, accepted close, and shutdown cleanup. Processes that escape that group are not contained. This lifecycle mechanism is not an OS sandbox and does not expand the Linux fake-peer verification claim.

ACP running state feeds the existing SQLite summary count, but this slice creates no durable permission input, completion attention, or error attention. All permission requests receive a cancelled outcome; denial is not an OS sandbox and executables must be trusted. Adapter environment configuration is not stored by this model, but prompt text and peer JSON payloads are persisted without transcript redaction. Do not submit secrets through this text/activity path or assume Phase 5's typed secret-input redaction filters arbitrary ACP payloads. Verification is limited to fake-peer Linux lifecycle checks and database recovery tests, not real-provider or cross-platform ACP parity.

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

- Only the first-slice ACP persistence above is implemented. Host pooling, discovery, load/resume/reconnect, durable prompt queues, MCP tool scoping, durable permission delivery, and ACP workbench UI remain Phase 6 work.
- The SQLite archive is not a write-through compatibility layer for v1 APIs.
- The RPC rollback backend reports degraded health and does not implement durable Phase 5 attention, input, or restore-failure mutations.
- No public stability is promised for the SQLite file or its private schema details.
