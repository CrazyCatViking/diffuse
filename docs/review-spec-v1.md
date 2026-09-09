# Diffuse Review Spec v1

Diffuse stores review state in the opened repository under `.diffuse/reviews`.

This directory is intentionally plain JSON and Markdown so external agent harnesses can read and update reviews without linking against Diffuse. Built-in agents should prefer Diffuse RPC/tool calls; those calls persist the same files described here.

## Migration Status

Phase 5 introduced the hybrid transitional boundary documented in [`review-spec-v2.md`](review-spec-v2.md). `config.json`, `active-session`, `review.json`, `progress.json`, `reviewed-files.json`, and `threads/*.json` remain authoritative portable files. The four legacy device-local families under `runs/`, `agents/`, `chat/messages/`, and `prompts/` are imported read-only into typed device-local SQLite archive tables when a workspace opens, but the source files are left untouched.

The Phase 5 Electron/Node opencode runner historically read and wrote those four legacy families. Phase 6 retires it from the desktop, along with its SDK, private IPC and environment bridge. The files and compatibility APIs remain for history/integrations; their SQLite import is an idempotent read-only archive, not a replacement live store.

The delivered native Phase 6 ACP workbench uses SQLite schema 7 for adapter/session/queue/history/input state, incarnations and file-scope compatibility. Schema 6 introduced immutable shard scope; schema 7 preserves old data while blocking ambiguous display-quoted scopes from reconnecting under literal Git path semantics. Affected sessions require new sessions with current IDs, not rewritten historical IDs. Main-owned bounded review waves persist in local UI state. See [the v2 persistence boundary](review-spec-v2.md#acp-session-and-activity-history). MCP tools write findings, merged shard progress and reviewed-file state through the portable formats here, never ACP transcripts into legacy run/chat/prompt families. Agents, review and inline chat use native ACP only; Diffuse RPC rollback has no agent execution fallback.

## Layout

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
        runs/
          <run-id>.json
        agents/
          <agent-run-id>.json
        chat/
          messages/
            <message-id>.json
        prompts/
          <run-id>.md
          file-review.md
```

The first six portable entities and `threads/` remain authoritative under the v2 boundary. `runs/`, `agents/`, `chat/messages/`, and `prompts/` retain their v1 shapes for historical data and compatibility APIs, and are imported as described in [`review-spec-v2.md`](review-spec-v2.md).

## Writing Files

Agents should write atomically:

```text
write <path>.tmp
rename <path>.tmp -> <path>
```

Diffuse watches `.diffuse/reviews` and emits live UI updates when files change.

IDs used as path segments must be safe file names. This applies to `<session-id>`, `<thread-id>`, `<run-id>`, `<agent-run-id>`, and `<message-id>`.

Allowed path-segment IDs:

- Must be non-empty.
- Must be at most 200 bytes.
- May contain only ASCII letters, digits, `.`, `_`, and `-`.
- Must not be `.` or `..`.
- Must not contain `/`, `\`, whitespace, or other separators/control characters.

The core rejects RPC writes with invalid path-segment IDs before constructing persistence paths.

## Session

`config.json` stores repository-local review agent configuration. If it is missing, Diffuse uses built-in defaults.

```json
{
  "provider": "opencode",
  "model": "provider/model",
  "agent": "agent-name",
  "maxParallelAgents": 1,
  "promptInstructions": "Prefer high-signal correctness, security, data-loss, race, and test-coverage findings. Do not comment on non-actionable observations."
}
```

The compatible `provider` default remains `opencode`, but provider/model/agent fields no longer select desktop execution. ACP review/chat uses `promptInstructions`; the main-owned review-wave scheduler uses `maxParallelAgents` for bounded concurrent file assignments. Legacy model/agent environment overrides are not consumed or auto-translated: configure equivalent supported adapter arguments explicitly and keep credentials in environment-key references or the adapter's authentication system.

`review.json` describes the review target and participants.

`.diffuse/reviews/active-session` contains the active session id. External agents can use that file for the current review, or target `.diffuse/reviews/sessions/<session-id>/` directly when they are asked to consider a specific review. Comments, chat, agent runs, progress, and reviewed-file state are all scoped to one session directory.

```json
{
  "id": "session-...",
  "repositoryRoot": "/repo",
  "target": {
    "base": "main",
    "compare": null,
    "includeStaged": true,
    "includeUnstaged": true
  },
  "headAtCreation": "abc123",
  "createdAt": "2026-06-15T12:00:00.000Z",
  "updatedAt": "2026-06-15T12:00:00.000Z",
  "title": "Local review",
  "status": "active",
  "participants": []
}
```

## Progress

`progress.json` is frequently updated by review agents.

```json
{
  "status": "running",
  "totalFiles": 12,
  "reviewedFiles": 4,
  "activeFiles": ["src/auth.ts"],
  "pendingFiles": ["src/api.ts"],
  "completedFiles": ["src/ui.ts"],
  "message": "Reviewing authentication flow",
  "lastActivityAt": "2026-06-15T12:05:00.000Z"
}
```

## Reviewed Files

`reviewed-files.json` records files that a human has marked reviewed in this session.

Diffuse treats a file as reviewed only when the saved `signature` matches the current changed-file signature. If the file changes after it was marked reviewed, the current signature changes and the UI shows the file as unreviewed without deleting the historical record.

```json
{
  "files": {
    "src/auth.ts": {
      "fileId": "src/auth.ts",
      "reviewedAt": "2026-06-15T12:08:00.000Z",
      "reviewedBy": "local-human",
      "signature": "9f4b..."
    }
  }
}
```

## Threads

Each file in `threads/` is a review thread. Agent findings and human comments share this format.

```json
{
  "id": "thread-...",
  "sessionId": "session-...",
  "fileId": "src/auth.ts",
  "oldPath": null,
  "newPath": "src/auth.ts",
  "anchor": {
    "side": "new",
    "startLine": 42,
    "endLine": 42,
    "startColumn": 2,
    "endColumn": 18,
    "selectedText": "validateToken(token)",
    "diffTargetFingerprint": "base:main|compare:|staged:true|unstaged:true"
  },
  "status": "open",
  "severity": "high",
  "category": "security",
  "confidence": "high",
  "source": {
    "kind": "agent",
    "provider": "opencode",
    "agentRunId": "agent-run-..."
  },
  "createdAt": "2026-06-15T12:06:00.000Z",
  "updatedAt": "2026-06-15T12:06:00.000Z",
  "messages": [
    {
      "id": "msg-...",
      "authorId": "agent-opencode",
      "body": "This accepts expired tokens because the expiry claim is not checked.",
      "createdAt": "2026-06-15T12:06:00.000Z"
    }
  ]
}
```

Human-created threads use `authorId: "local-human"` in their first message. Agent-created threads should include `source.kind: "agent"`, `source.provider`, and `source.agentRunId` when available.

Threads can be `open` or `resolved`. Replies append to `messages`; resolving or reopening a thread updates `status` and `updatedAt`.

## Agent State

Historically, the Node runner used `runs/` as its lifecycle authority and reported provider state through core file APIs. These records remain readable by legacy review APIs and are imported read-only into SQLite archives. Current ACP execution and wave plans use the v2 device-local stores instead; the archive is not a live execution store.

```json
{
  "id": "agent-run-...",
  "sessionId": "session-...",
  "provider": "opencode",
  "status": "running",
  "currentPhase": "running",
  "message": "opencode is reviewing changed files",
  "opencodeSessionId": "ses_...",
  "startedAt": "2026-06-15T12:00:00.000Z",
  "updatedAt": "2026-06-15T12:05:00.000Z"
}
```

Files in `agents/` describe lower-level live agent activity. Store summaries of activity, not raw hidden reasoning.

```json
{
  "id": "agent-run-...",
  "provider": "opencode",
  "status": "running",
  "currentPhase": "reviewing-file",
  "currentFile": "src/auth.ts",
  "lastThoughtSummary": "Checking token expiry and refresh handling.",
  "reviewedFiles": ["src/api.ts"],
  "startedAt": "2026-06-15T12:00:00.000Z",
  "updatedAt": "2026-06-15T12:05:00.000Z"
}
```

## Chat Messages

Files in `chat/messages/` are persisted user/assistant/system messages for chat during review. Messages may reference current file selection or review threads so a built-in provider can answer with review context without coupling UI state to a provider process.

```json
{
  "id": "chat-...",
  "sessionId": "session-...",
  "role": "user",
  "body": "Is this auth change safe?",
  "createdAt": "2026-06-15T12:07:00.000Z",
  "context": {
    "fileId": "src/auth.ts",
    "threadIds": ["thread-..."]
  }
}
```

Selection-only AI chat may use a synthetic thread id in `context.threadIds` with this shape:

```text
chat:<file-id>:<side>:<start-line>:<end-line>:<start-column>:<end-column>
```

Historical assistant responses from the retired built-in provider include `provider: "opencode"` and may include `runId`. Current ACP transcript history is not written into these files.

## Built-In Tool Calls

The following retained core file APIs support v1 data and integrations. They are not the current ACP MCP tool names; native agents use the scoped tools described in [architecture](architecture.md#inputs-and-review-tools). Integrations should prefer validated core calls over direct JSON writes where available:

```text
listReviewSessions
getActiveReviewSession
createReviewSession
getReviewConfig
saveReviewConfig
getReviewProgress
saveReviewProgress
getReviewAgentStates
getReviewedFiles
saveReviewedFiles
updateReviewedFiles
saveReviewAgentState
getReviewRuns
saveReviewRun
createReviewRun
updateReviewRun
finishReviewRun
getReviewThreads
getReviewChatMessages
saveReviewChatMessage
addReviewComment
addReviewCommentPayload
saveReviewThread
recoverStaleReviewRuns
```

`addReviewComment` accepts a complete thread object as `comment` and persists it under `threads/<id>.json`.

`addReviewCommentPayload` accepts the compact tool payload historically used by the opencode bridge and retained by compatible core APIs:

```json
{
  "filePath": "src/auth.ts",
  "side": "new",
  "startLine": 42,
  "endLine": 42,
  "body": "This accepts expired tokens because the expiry claim is not checked.",
  "severity": "high",
  "category": "security",
  "confidence": "high",
  "selectedText": "validateToken(token)"
}
```

The core expands that payload into a normal thread, anchors it to the active diff target, and records the current agent run as the source.

`recoverStaleReviewRuns` marks active runs as failed when Diffuse restarts without an attached provider process.

## Historical opencode Runner

This section records the Phase 5 and earlier contract, not a current desktop capability. The runner, `@opencode-ai/sdk` dependency, private `review-agent:*` IPC and Node bridge are removed in Phase 6. Existing files are preserved; current agent execution uses [native ACP](architecture.md#native-acp-workbench).

The desktop historically started opencode reviews for the active session. The core owned `runs/<agent-run-id>.json`, while Electron used the SDK to create provider sessions, send prompts and report status changes back to core. Compatible core file APIs continue preserving v1 data and unknown extension fields.

Cancellation used the opencode SDK `session.abort` API.

Historical environment overrides (not current ACP settings):

```text
DIFFUSE_OPENCODE_MODEL=provider/model
DIFFUSE_OPENCODE_AGENT=agent-name
```

The runner generated custom tools for validated comments, progress, agent state, assigned changed files and diffs. Its chat persisted in `chat/messages/`; ACP history now uses SQLite instead.

Generated tools were written to `.opencode/tools/diffuse_review.ts`; when absent, `.opencode/package.json` was created with `@opencode-ai/plugin`. Migration deliberately does not delete these repository files. If an ACP adapter auto-loads the old generated tool, explicitly disable or remove it during adapter setup: the Node endpoints it calls are retired, not aliases for the new session-scoped MCP tools. Do not automatically translate old provider/model/agent overrides into adapter flags.

The historical bridge listened on `127.0.0.1` with a bearer token routed through `DIFFUSE_REVIEW_BRIDGE_URL` and `DIFFUSE_REVIEW_BRIDGE_TOKEN`. These retired endpoints were exposed to generated tools:

- `/changed-files`
- `/diff`
- `/add-comment`
- `/set-progress`
- `/set-agent-state`
