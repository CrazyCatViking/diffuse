# Diffuse Review Spec v2

This specification defines the durable ownership and migration boundary introduced by Phase 5. It is a **hybrid transitional v2 boundary**, not a complete move of review data into SQLite and not the Phase 6 ACP format. The legacy file formats remain documented in [`review-spec-v1.md`](review-spec-v1.md).

## Authority

Each durable entity has one authoritative store.

| Store | Authoritative data |
| --- | --- |
| Repository-local `.diffuse/reviews` | `config.json`, `active-session`, each session's `review.json`, `progress.json`, `reviewed-files.json`, and `threads/*.json`. |
| Device-local `<Electron userData>/workbench.sqlite3` | Workspace identity, canonical root, rail order, open/active state, UI restoration, input requests and non-secret responses, attention lifecycle, exact acknowledgement and notification revisions, typed legacy archives, and future ACP workbench history. |

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

The normal desktop database is `<Electron userData>/workbench.sqlite3`. Schema migration version 2 contains these conceptual tables:

- `workspaces`: stable device-local workspace identity, canonical location, open state, generation, and rail order.
- `app_state`: application-wide state including the active workspace.
- `workspace_ui_state`: revisioned per-workspace UI restoration records.
- `agent_sessions`: device-local agent-session records and the basis for future ACP workbench history.
- `input_requests`: revisioned input requests, non-secret response state, and distinct lifecycle outcomes.
- `attention_items`: durable input, error, and completion attention with acknowledgement and notification-claim revisions.
- `legacy_review_import_ledger`: import identity, status, provenance, and retryable diagnostics.
- `legacy_import_runs`, `legacy_import_agents`, `legacy_import_chats`, and `legacy_import_prompts`: typed read-only archives of the four legacy v1 device-local artifact families.

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

Future v2 ACP sessions, turns, messages, input, and workbench history belong in device-local SQLite and must not be written back into the repository. Portable findings, review progress, reviewed-file state, threads, session targets, and repository review configuration continue to use the portable files above.

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

- This specification does not define ACP host supervision, session resume, prompt queues, or MCP tool scoping. Those remain Phase 6 work.
- The SQLite archive is not a write-through compatibility layer for v1 APIs.
- The RPC rollback backend reports degraded health and does not implement durable Phase 5 attention, input, or restore-failure mutations.
- No public stability is promised for the SQLite file or its private schema details.
