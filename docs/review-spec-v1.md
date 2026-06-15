# Diffuse Review Spec v1

Diffuse stores review state in the opened repository under `.diffuse/reviews`.

This directory is intentionally plain JSON and Markdown so external agent harnesses can read and update reviews without linking against Diffuse. Built-in agents should prefer Diffuse RPC/tool calls; those calls persist the same files described here.

## Layout

```text
.diffuse/
  reviews/
    active-session
    sessions/
      <session-id>/
        review.json
        progress.json
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

## Writing Files

Agents should write atomically:

```text
write <path>.tmp
rename <path>.tmp -> <path>
```

Diffuse watches `.diffuse/reviews` and emits live UI updates when files change.

## Session

`review.json` describes the review target and participants.

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

## Agent State

Files in `runs/` are the canonical source of truth for managed review run lifecycle. Electron provider adapters may own external process handles, but they must report lifecycle state back to core by updating these run records.

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

## Built-In Tool Calls

Built-in providers should use Diffuse RPC/tool calls instead of writing JSON directly when possible:

```text
listReviewSessions
getActiveReviewSession
createReviewSession
getReviewProgress
saveReviewProgress
saveReviewAgentState
getReviewRuns
saveReviewRun
getReviewThreads
getReviewChatMessages
saveReviewChatMessage
addReviewComment
saveReviewThread
```

`addReviewComment` accepts a complete thread object as `comment` and persists it under `threads/<id>.json`.

## Built-In opencode Runner

The desktop app can start built-in opencode review runs for the active session. Zig core owns the review run state in `runs/<agent-run-id>.json`. Electron only acts as the opencode provider adapter: it starts opencode through `@opencode-ai/sdk`, creates opencode sessions for the repository directory, sends review prompts asynchronously, and reports status changes back to core.

Cancellation uses the opencode SDK `session.abort` API.

Environment overrides:

```text
DIFFUSE_OPENCODE_MODEL=provider/model
DIFFUSE_OPENCODE_AGENT=agent-name
```

The runner generates opencode custom tools that call back into Diffuse for validated comments, progress, agent state, assigned changed files, and diff access. Future chat provider sessions should preserve the same persisted file contract in `chat/messages/`.
