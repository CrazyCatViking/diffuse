# Diffuse Design Findings

## Product Understanding

Diffuse is a local, AI-assisted code review and diff exploration tool. It is not intended to be a full code editor. The diff viewer should remain read-only while supporting range selection, comments, diagnostics, AI questions, structured AI findings, and AI-generated patch proposals.

The core product value is helping developers understand and review code changes quickly, with AI agents tightly integrated into the review workflow rather than added as a separate chat surface.

## Architecture

The design favors a protocol-driven architecture with a Zig core process and a web-based desktop GUI, likely Electron for the first implementation.

The Zig core should own the important product logic:

- Git and repository inspection
- Changed-file detection
- Diff generation and parsing
- Old/new file snapshot loading
- Tree-sitter parsing and syntax highlighting
- Optional LSP integration
- Review session state
- Human comments
- AI findings
- Agent orchestration
- Patch proposals and patch application
- Local persistence

The GUI should own interaction and rendering:

- Pane layout
- Virtualized diff rendering
- Selection and hover behavior
- Comment and finding displays
- Agent chat interface
- Patch preview UI
- Keyboard shortcuts and filters

The central principle is:

```text
Zig owns intelligence.
The GUI owns interaction.
The protocol owns the boundary.
```

## UI Model

The main workspace should use a three-pane layout:

- Left pane: changed files, statuses, additions/deletions, comment counts, finding counts, diagnostics, reviewed state, and filters.
- Center pane: read-only split/unified diff viewer with syntax highlighting, inline word diffs, gutters, markers, selection, hover cards, and keyboard navigation.
- Right pane: review and agent panel that adapts to the current selection, file, finding, thread, or whole review.

The diff viewer should be a specialized projection of review state. It should render rows, syntax spans, diff styling, markers, selections, and hover state. It should not own Git operations, persistence, AI conversations, patch application, LSP lifecycle, or global review state.

## Core Review Concepts

The key domain model centers around a review session containing changed files, comments, findings, threads, questions, patch proposals, and the current selection.

Anchors are important because comments and findings need to survive refreshed diffs where possible. The proposed anchor model uses file, side, line range, and optional hashes for surrounding context and selected text.

Human comments and AI findings should both be anchored to code, but they should remain distinct concepts:

- Human comments are discussion items.
- AI findings are structured review outputs with severity, category, title, body, suggested fix, status, and optional discussion thread.

## Syntax And LSP

Tree-sitter should be the baseline syntax highlighter. The design correctly avoids parsing raw diffs as source files. Instead, old and new file snapshots should be parsed separately, and syntax spans should be mapped onto visible diff rows.

LSP should be optional enhancement rather than the foundation. Initial LSP work should focus on current working-tree files and provide diagnostics, hover, definitions, references, document symbols, and eventually semantic tokens.

Editor-like LSP operations such as completion, formatting, rename, and direct workspace edits should be avoided in the read-only diff viewer. Code actions may later become previewable patch proposals.

## AI Integration

AI interaction should be scoped to review context. Supported scopes include selected range, current hunk, current file, finding, thread, and whole review.

The context builder is a critical component. For a selected range, it should gather selected code, surrounding hunk, surrounding function or symbol, relevant diagnostics, nearby comments, and related definitions or references when available.

For whole-review questions, it should gather changed file lists, per-file summaries, high-risk hunks, test changes, open findings, and unresolved comments.

This context scoping is likely one of the most important parts of making the AI integration feel useful and native.

## Patch Proposal Flow

The diff viewer remains read-only, but AI agents can still propose changes through a separate patch proposal workflow:

```text
AI suggests fix
Patch proposal is created
User opens patch preview
Patch preview is rendered as another diff
User accepts or rejects
Zig core applies patch to working tree
Main diff is regenerated
Viewer updates
```

Patch proposals should be separate from comments and findings. This keeps review discussion, structured findings, and executable changes cleanly separated.

## Milestones

The suggested milestone order is reasonable:

1. Review workspace skeleton: open repository, list changed files, select a file, and display a read-only split diff.
2. Tree-sitter highlighting: parse old/new snapshots and map syntax spans to diff rows.
3. Comments and anchors: select ranges, add comments, persist sessions, and show gutter markers.
4. AI questions: ask about selected ranges, files, and the whole review.
5. AI findings: allow agents to create structured findings displayed in the file list, gutter, and review panel.
6. LSP metadata: add diagnostics, hover info, and optional semantic token overlay.
7. Patch proposals: let agents propose patches, preview them as diffs, accept/reject them, and refresh the main diff.

## Key Risks

The main technical risks are:

- Diff rendering performance on large reviews
- Stable comment and finding anchors across refreshed diffs
- Tree-sitter grammar packaging across platforms
- LSP server setup and project-specific configuration
- Agent context selection quality
- Avoiding an AI experience that feels bolted on
- Patch application safety and conflict handling
- Keeping frontend state synchronized with the Zig core

## Recommended MVP Focus

The first MVP should prove the core review loop:

- Open a local repository
- List changed files
- Render a fast read-only split diff
- Select a range
- Ask an AI question scoped to that range
- Display the AI response in the review panel

This validates the essential product direction before investing heavily in LSP, advanced findings, patch application, or multiple clients.
