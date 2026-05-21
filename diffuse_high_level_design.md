# Diffuse — High-Level Design Brief

## 1. Project Summary

**Diffuse** is an AI-assisted, interactive code review workspace. The application helps a developer inspect code changes, ask questions about diffs, discuss findings with AI agents, add human comments, review AI-generated findings, and optionally apply AI-proposed patches.

The product is **not a full code editor**. The diff viewer is read-only. Users can select code ranges, ask questions, add comments, inspect diagnostics, and review patch proposals, but they do not directly edit code inside the diff view.

## 2. Core Product Goals

- Provide a fast, polished, read-only diff review experience.
- Support Tree-sitter-based syntax highlighting.
- Optionally enrich the review with LSP data such as diagnostics, hover information, definitions, references, and semantic tokens.
- Allow human and AI comments anchored to specific files, hunks, lines, or ranges.
- Let users ask AI agents questions scoped to:
  - selected code range,
  - current hunk,
  - current file,
  - specific finding/comment thread,
  - or the entire review.
- Let AI agents create structured findings and patch proposals.
- Keep the core engine independent from the GUI so other clients can be added later.

## 3. Recommended High-Level Stack

### Core Engine

**Language:** Zig

The Zig core should own the important product logic:

- Git/repository inspection
- Changed-file detection
- Diff generation/parsing
- Old/new file snapshot loading
- Tree-sitter parsing and syntax highlighting
- LSP client integration
- Review session model
- Human comments
- AI findings
- Agent orchestration
- Patch proposal generation and application
- Local persistence

The core should expose a local protocol/API to the GUI.

### GUI

**Recommended first implementation:** Electron or similar web-based desktop shell.

Rationale:

- The app needs complex productivity UI: panes, file tree, comment threads, chat input, markdown rendering, settings, patch previews, filters, keyboard shortcuts, etc.
- Electron makes it faster to build and iterate on the workflow.
- Tree-sitter and LSP support do not require a native GUI. They can run in the Zig core and send render/metadata models to the frontend.

Possible frontend stack:

- Electron main process for desktop shell and process management
- TypeScript frontend
- React, Solid, Svelte, or similar UI framework
- Virtualized diff rendering component
- WebSocket, JSON-RPC, or IPC bridge to the Zig core

### Future GUI Options

The architecture should allow replacing or supplementing the Electron GUI later with:

- a custom native Zig GUI,
- a lightweight webview shell,
- a TUI,
- a Neovim plugin,
- a VS Code extension,
- or a hosted web interface.

This is why the Zig core should be protocol-driven and not tightly coupled to Electron.

## 4. Process Architecture

Recommended process model:

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron / WebView UI                                       │
│                                                             │
│ - changed files panel                                      │
│ - read-only diff viewer                                    │
│ - comments and AI findings                                 │
│ - agent chat                                               │
│ - diagnostics / hover cards                                │
│ - patch proposal previews                                  │
└───────────────────────┬─────────────────────────────────────┘
                        │ IPC / WebSocket / JSON-RPC
┌───────────────────────▼─────────────────────────────────────┐
│ Diffuse Core — Zig                                           │
│                                                             │
│ - Git and diff model                                       │
│ - old/new file snapshots                                   │
│ - Tree-sitter syntax highlighting                          │
│ - LSP client                                               │
│ - review session state                                     │
│ - comments / findings / threads                            │
│ - AI agent orchestration                                   │
│ - patch application                                        │
└───────────────────────┬─────────────────────────────────────┘
                        │ stdio / JSON-RPC
┌───────────────────────▼─────────────────────────────────────┐
│ Language Servers                                            │
│                                                             │
│ zls, rust-analyzer, gopls, tsserver, clangd, etc.            │
└─────────────────────────────────────────────────────────────┘
```

## 5. Key Architectural Principle

Separate **where intelligence runs** from **where pixels are drawn**.

The frontend should not own Git, Tree-sitter, LSP, AI context building, review anchors, or patch application. It should render state and emit user interactions.

The Zig core should be the source of truth for:

- repository state,
- diffs,
- syntax spans,
- diagnostics,
- comments,
- AI findings,
- review threads,
- selected anchors,
- and patch proposals.

## 6. Main UI Layout

The main UI should be a three-pane review workspace.

```text
┌──────────────────────────────────────────────────────────────┐
│ Top bar: repo / branch / review session / agent status        │
├───────────────┬───────────────────────────────┬──────────────┤
│ Changed files │ Diff viewer                    │ Review panel │
│               │                               │              │
│ src/foo.zig   │ split/unified diff             │ AI findings  │
│ src/bar.zig   │ syntax highlighting            │ comments     │
│ tests/...     │ inline annotations             │ ask agent    │
│               │ selected range                 │ threads      │
├───────────────┴───────────────────────────────┴──────────────┤
│ Optional bottom panel: diagnostics / agent trace / patch view │
└──────────────────────────────────────────────────────────────┘
```

### Left Pane: Changed Files

Should show:

- file path,
- status: added, modified, deleted, renamed,
- additions/deletions,
- number of comments,
- number of AI findings,
- diagnostic count,
- reviewed/unreviewed state.

Useful filters:

- all files,
- files with findings,
- files with comments,
- unreviewed,
- tests only,
- high-risk.

### Center Pane: Read-Only Diff Viewer

Should support:

- split diff view,
- unified diff view,
- syntax highlighting from Tree-sitter,
- inline word-level diff highlighting,
- line numbers,
- gutter markers,
- AI finding markers,
- comment markers,
- diagnostic markers,
- range selection,
- copy selected text,
- collapse/expand unchanged context,
- hover cards,
- keyboard navigation.

Should not support:

- direct editing,
- autocomplete,
- multi-cursor editing,
- formatting,
- rename operations,
- direct in-view patch editing.

### Right Pane: Review / Agent Panel

Should adapt to current selection.

When nothing is selected:

- review summary,
- open findings,
- unresolved comments,
- ask about whole review.

When a file is selected:

- file summary,
- findings for the file,
- comments for the file,
- ask about this file.

When a code range is selected:

- ask AI about selection,
- add human comment,
- show diagnostics,
- show relevant findings,
- show symbol/hover info if available.

## 7. Diff Viewer Responsibilities

The diff viewer should be a specialized read-only projection of the review state.

It owns:

- rendering visible diff rows,
- rendering syntax spans,
- rendering add/delete/context styling,
- rendering inline changed-word spans,
- rendering gutters and annotations,
- scrolling,
- hit testing,
- range selection,
- click and hover events.

It should not own:

- Git operations,
- comment persistence,
- AI conversations,
- patch application,
- LSP process lifecycle,
- global review state.

The diff viewer should emit events such as:

```text
FileSelected(file_id)
LineSelected(file_id, side, line)
RangeSelected(file_id, side, start, end)
FindingClicked(finding_id)
CommentClicked(comment_id)
HoverRequested(file_id, side, line, column)
AskAgentRequested(scope)
```

## 8. Tree-sitter Highlighting Model

Do not parse the raw diff as one file for syntax highlighting.

Instead:

```text
old file content -> Tree-sitter parse -> old-side syntax spans
new file content -> Tree-sitter parse -> new-side syntax spans
diff hunks       -> map old/new line numbers to visible rows
```

Then render each visible diff row by combining:

1. diff kind: added, deleted, context, hunk header,
2. code syntax spans,
3. inline word-level diff spans,
4. diagnostics,
5. comments,
6. AI findings,
7. selection/hover state.

Tree-sitter should be the baseline syntax highlighter.

## 9. LSP Integration Model

LSP should be an optional enhancement layer, not the foundation of syntax highlighting.

Initial LSP support should focus on the new/current working-tree version of files.

Useful LSP features:

- diagnostics,
- hover,
- go to definition,
- references,
- document symbols,
- semantic tokens.

Features to postpone or avoid in the read-only viewer:

- completion,
- formatting,
- rename,
- direct workspace edits.

Code actions can be supported later by converting them into previewable patch proposals rather than applying them directly in the viewer.

## 10. Agent Interaction Model

The user should be able to ask questions scoped to different parts of the review.

Example scopes:

```text
selection: selected lines or range
hunk: current diff hunk
file: current changed file
finding: a specific AI finding
thread: a human/AI comment thread
whole_review: all changed files
```

The agent context builder should gather only relevant context for the selected scope.

For a selected range, include:

- selected code,
- surrounding hunk,
- surrounding function or symbol if available,
- relevant diagnostics,
- nearby comments,
- related definitions/references if available.

For a whole-review question, include:

- changed file list,
- per-file summaries,
- high-risk hunks,
- test changes,
- open findings,
- unresolved comments.

## 11. Review Model Concepts

Suggested core entities:

```zig
const ReviewSession = struct {
    repo: RepoId,
    base_ref: []const u8,
    head_ref: []const u8,

    files: []ChangedFile,
    comments: []ReviewComment,
    findings: []AiFinding,
    threads: []ReviewThread,
    questions: []AgentQuestion,
    patch_proposals: []PatchProposal,

    selection: ?ReviewSelection,
};
```

```zig
const ChangedFile = struct {
    id: FileId,
    old_path: ?[]const u8,
    new_path: ?[]const u8,
    status: FileStatus,

    old_snapshot: ?SourceSnapshotId,
    new_snapshot: ?SourceSnapshotId,

    diff: DiffDocumentId,
    language: LanguageId,
};
```

```zig
const ReviewSelection = struct {
    file_id: FileId,
    side: enum { old, new, both },
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
};
```

```zig
const CodeAnchor = struct {
    file_id: FileId,
    side: enum { old, new },
    start_line: u32,
    end_line: u32,

    // Used to recover anchors if the diff changes.
    context_before_hash: ?[32]u8,
    selected_text_hash: ?[32]u8,
    context_after_hash: ?[32]u8,
};
```

## 12. AI Findings vs Human Comments

Human comments and AI findings should both be anchored to code, but they should not be treated as identical.

A human comment is a discussion item.

An AI finding is structured review output with fields like:

- severity,
- category,
- title,
- body,
- suggested fix,
- status.

Example:

```zig
const AiFinding = struct {
    id: FindingId,
    file_id: FileId,
    anchor: CodeAnchor,

    severity: enum { info, suggestion, warning, error },
    category: enum { correctness, test_gap, security, maintainability, architecture, performance },
    title: []const u8,
    body: []const u8,

    status: enum { open, accepted, dismissed, resolved },
    thread_id: ?ThreadId,
};
```

Both comments and findings can have discussion threads.

## 13. Patch Proposal Workflow

The diff viewer is read-only, but the AI can still propose changes.

Patch flow:

```text
AI suggests fix
  ↓
Patch proposal is created
  ↓
User opens patch preview
  ↓
Patch preview is rendered as another diff
  ↓
User accepts or rejects
  ↓
Zig core applies patch to working tree
  ↓
Main diff is regenerated
  ↓
Viewer updates
```

Patch proposals should be separate from comments and findings.

## 14. Suggested Local Protocol

The GUI should communicate with the Zig core using a stable local protocol.

Possible transports:

- stdio JSON-RPC,
- WebSocket to localhost,
- Electron IPC bridge to a spawned Zig process.

Initial API commands:

```text
openRepository(path)
getRepositoryStatus()
listChangedFiles()
getDiffRenderModel(file_id, options)
selectRange(file_id, side, start, end)
createComment(anchor, body)
resolveThread(thread_id)
askAgent(scope, message)
listFindings(filter)
dismissFinding(finding_id)
acceptFinding(finding_id)
createPatchProposal(finding_id | thread_id | selection)
previewPatch(patch_id)
applyPatch(patch_id)
refreshDiff()
```

Events from core to UI:

```text
repositoryChanged
fileDiffUpdated
commentsUpdated
findingsUpdated
agentJobStarted
agentJobUpdated
agentJobCompleted
patchApplied
diagnosticsUpdated
lspStatusChanged
```

## 15. Suggested Milestones

### Milestone 1: Review Workspace Skeleton

- Open repository.
- Show changed files.
- Select changed file.
- Display read-only split diff.
- Basic virtualized scrolling.

### Milestone 2: Tree-sitter Highlighting

- Load old/new snapshots.
- Parse with Tree-sitter.
- Apply highlight queries.
- Map syntax spans to diff rows.
- Render syntax-highlighted split/unified diff.

### Milestone 3: Comments and Anchors

- Select range in diff.
- Add human comment.
- Persist review session locally.
- Show comment markers in gutter.
- Resolve/reopen threads.

### Milestone 4: AI Questions

- Ask AI about selected range.
- Ask AI about current file.
- Ask AI about whole review.
- Store AI responses in threads.

### Milestone 5: AI Findings

- Agent can create structured findings.
- Findings appear in file list, gutter, and right panel.
- User can accept, dismiss, or discuss findings.

### Milestone 6: LSP Metadata

- Start language server for supported languages.
- Show diagnostics.
- Show hover info.
- Optional semantic token overlay.

### Milestone 7: Patch Proposals

- Agent can propose patches.
- Patch preview is shown as a diff.
- User can accept/reject patch.
- Applying patch refreshes main diff.

## 16. Key Technical Risks

- Diff rendering performance on large reviews.
- Stable comment/finding anchors across refreshed diffs.
- Tree-sitter grammar packaging across platforms.
- LSP server setup and project-specific configuration.
- Agent context selection quality.
- Preventing the AI/chat UI from feeling bolted on.
- Patch application safety and conflict handling.
- Keeping Electron/frontend state synchronized with the Zig core.

## 17. Recommended First Build Decision

Start with:

```text
Zig core process
Electron UI
TypeScript frontend
Protocol boundary between UI and core
Tree-sitter in Zig core
LSP in Zig core or Electron main process, preferably Zig core long-term
Read-only virtualized diff viewer in frontend
```

The most important design principle:

```text
Zig owns intelligence.
The GUI owns interaction.
The protocol owns the boundary.
```

This keeps the product portable, allows a fast first GUI implementation, and preserves the option to build a Zig-native GUI later.

