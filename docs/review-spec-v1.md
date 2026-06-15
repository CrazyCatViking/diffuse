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
        agents/
          <agent-run-id>.json
        prompts/
          initial.md
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

Files in `agents/` describe live agent activity. Store summaries of activity, not raw hidden reasoning.

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

## Built-In Tool Calls

Built-in providers should use Diffuse RPC/tool calls instead of writing JSON directly when possible:

```text
listReviewSessions
getActiveReviewSession
createReviewSession
getReviewProgress
saveReviewProgress
saveReviewAgentState
getReviewThreads
addReviewComment
saveReviewThread
```

`addReviewComment` accepts a complete thread object as `comment` and persists it under `threads/<id>.json`.
