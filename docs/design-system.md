# Diffuse Design System

This document explains how to build and extend Diffuse's desktop UI. It is contributor-facing and should be kept current when new shared components, tokens, or durable UI patterns are added.

## Goals

Diffuse is a dense local code review tool. The UI should help users scan changed files, understand review state, and act without leaving the diff.

Design decisions should optimize for:

- Clear scan paths for files, hunks, comments, diagnostics, search results, and AI review state.
- Desktop layouts that remain usable in narrow desktop windows.
- Small, composable Vue components with explicit state and typed events.
- Tokenized styling over one-off colors, spacing, and shadows.
- Accessible controls with visible focus and meaningful labels.

## Source Files

The main design system sources are:

- `app/src/styles/tokens.scss` for color, spacing, radius, type, shadow, and transition tokens.
- `app/src/components/Button.vue` for shared buttons.
- `app/src/components/ui/Badge.vue` for status and category labels.
- `app/src/components/ui/Panel.vue` for cards, dialogs, and raised surfaces.
- `app/src/components/ui/Toolbar.vue` for horizontal application bars.
- `app/src/components/ui/EmptyState.vue` for loading, empty, and unavailable states.
- `app/src/components/ui/TreeList.vue` for collapsible hierarchical lists with feature-owned row content.
- Feature components under `app/src/components/diff/`, `app/src/components/review/`, `app/src/components/changed-files/`, `app/src/components/settings/`, and `app/src/components/repositories/` for domain-specific UI patterns.

Shared primitives should stay generic. Diff-specific and review-specific concepts should stay in feature components unless they are reused across unrelated surfaces.

## Tokens

Use CSS custom properties from `tokens.scss` for new UI. Avoid hard-coded colors, spacing, font stacks, and shadows unless a value is genuinely one-off and cannot be named yet.

### Background Tokens

Use background tokens by surface depth:

| Token                     | Use                                                       |
| ------------------------- | --------------------------------------------------------- |
| `--color-bg-app`          | Full app and major viewer backgrounds.                    |
| `--color-bg-shell`        | Application chrome, sidebars, headers, toolbars.          |
| `--color-bg-panel`        | Cards, overview panels, file headers, neutral containers. |
| `--color-bg-panel-raised` | Dialogs, popovers, active cards, raised settings rows.    |
| `--color-bg-inset`        | Inputs, grouped controls, code-adjacent inset wells.      |
| `--color-bg-code`         | Diff row and code surfaces.                               |
| `--color-bg-line-number`  | Diff gutter line-number cells.                            |
| `--color-bg-hover`        | Hover state for interactive rows and controls.            |
| `--color-bg-active`       | Active or pressed row/control state.                      |
| `--color-bg-overlay`      | Modal and drawer overlays.                                |

### Border Tokens

Use border tokens by strength:

| Token                     | Use                                                 |
| ------------------------- | --------------------------------------------------- |
| `--color-border-subtle`   | Structural dividers and low-emphasis panel borders. |
| `--color-border-default`  | Cards, inputs, dialogs, and visible grouping.       |
| `--color-border-strong`   | Hovered or emphasized containers.                   |
| `--color-border-focus`    | Keyboard focus outlines.                            |
| `--color-border-hairline` | Dense diff row separators.                          |

### Text Tokens

Use text tokens by hierarchy:

| Token                    | Use                                          |
| ------------------------ | -------------------------------------------- |
| `--color-text-primary`   | Main titles, filenames, active content.      |
| `--color-text-secondary` | Normal body text and secondary labels.       |
| `--color-text-muted`     | Supporting descriptions and metadata.        |
| `--color-text-subtle`    | Counts, timestamps, helper copy.             |
| `--color-text-disabled`  | Disabled line numbers and inactive metadata. |
| `--color-text-on-accent` | Text placed on saturated accent backgrounds. |

### Semantic Tokens

Use semantic tokens consistently:

| Token Family | Meaning                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `accent`     | Primary app action or selected control.                                     |
| `review`     | Human review state, comments, threads, overview navigation.                 |
| `ai`         | AI review, AI chat, language-server info when no stronger severity applies. |
| `success`    | Ready, reviewed, resolved, installed, completed.                            |
| `warning`    | Missing configuration, incomplete install, open attention state.            |
| `danger`     | Errors, destructive actions, failed state.                                  |
| `info`       | Loading, stale state, neutral informational state.                          |

Each semantic family has a muted background token, such as `--color-review-muted`. Use muted backgrounds for badges, chips, and low-emphasis highlights.

### Diff Tokens

Use diff tokens only for code review semantics:

- `--color-diff-added-bg` for added-line backgrounds.
- `--color-diff-deleted-bg` for deleted-line backgrounds.
- `--color-diff-hunk-bg` for hunk scan landmarks.
- `--color-scrollbar-track`, `--color-scrollbar-thumb`, and `--color-scrollbar-thumb-hover` for custom diff scrollbars.

### Spacing, Radius, Type, And Shadow

Spacing uses `--space-1` through `--space-10`. Dense controls normally use `--space-2` to `--space-5`; panel layout normally uses `--space-6` to `--space-9`.

Radii use `--radius-1` through `--radius-6`, plus `--radius-pill`. Use `--radius-pill` for badges, status chips, and count pills. Use `--radius-4` to `--radius-6` for panels, dialogs, drawers, and empty states.

Fonts use `--font-ui` for product UI and `--font-mono` for code, line numbers, commands, paths, and anchors. Code rows should use `--line-height-code`.

Shadows are intentionally sparse. Use `--shadow-inset-highlight` for subtle raised panels, `--shadow-popover` for floating controls and menus, and `--shadow-dialog` for drawers and modal panels.

## Shared Components

### Button

Use `Button.vue` for all normal buttons. Do not create custom button styles unless the control is a specialized feature primitive, such as a diff gutter icon.

Variants:

| Variant     | Use                                                      |
| ----------- | -------------------------------------------------------- |
| `primary`   | Main action in a dialog or panel.                        |
| `secondary` | Normal toolbar action, toggles, and non-primary actions. |
| `ghost`     | Low-emphasis action in dense rows or headers.            |
| `danger`    | Stop, remove, uninstall, or destructive action.          |
| `review`    | Review-specific actions such as opening review surfaces. |
| `ai`        | AI review and AI chat actions.                           |

Sizes:

| Size | Use                                             |
| ---- | ----------------------------------------------- |
| `sm` | Toolbars, dense rows, overview cards.           |
| `md` | Normal panels and forms.                        |
| `lg` | Start screen and large primary calls to action. |

Use `pressed` for toggle state and `block` for full-width actions. Shared button focus is handled by the component.

### Badge

Use `Badge.vue` for compact labels, counts, and state chips. It is not interactive.

Tones map to semantic tokens: `neutral`, `accent`, `success`, `warning`, `danger`, `info`, `review`, and `ai`. Prefer `Badge` over hand-written pill spans when the element is a static label.

### Panel

Use `Panel.vue` for reusable surface containers. Prefer it for dialogs, start cards, and settings panels when the structure is generic. Keep feature-specific layout inside the slot.

Padding options are `none`, `sm`, `md`, and `lg`. Use `elevated` for dialogs, floating panels, and foreground cards.

### Toolbar

Use `Toolbar.vue` for horizontal chrome that separates a region from the content below it. Use `density="compact"` for dense app bars and `density="normal"` for larger section headers. Use `borderless` only when the surrounding container already supplies a divider.

### EmptyState

Use `EmptyState.vue` for loading, empty, no-selection, and unavailable states. Prefer clear titles and one-sentence descriptions. Use `bordered` when the empty state sits inside a panel or list region. Use `align="start"` for review overview and settings sections; use the default centered layout for full-pane states.

### TreeList

Use `TreeList.vue` for shared hierarchy behavior: indentation, collapse state, active row framing, and tree semantics. Keep feature-specific labels, badges, actions, review state, and result previews in the consuming feature component through slots.

## Feature UI Patterns

### Diff Viewer

The diff viewer is optimized for scan speed.

Use existing diff primitives before creating new ones:

- `DiffScrollbar.vue` for custom scrollbar thumbs and scan markers.
- `diffScrollMarkers.ts` for marker range calculation and merging.
- `CodeHunkRow.vue` for hunk landmarks.
- `CodeLineNumber.vue` for line numbers, comment affordances, collapsed comment counts, and diagnostic markers.
- `DiagnosticMarker.vue` for LSP diagnostic dots and popovers.
- `DiffViewerOverlays.vue` for floating selection actions and LSP hover.
- `InlineReviewBox.vue` and `DiffReviewRow.vue` for inline comments, AI chat, drafts, and thread actions.

Do not add separate marker systems for review, diagnostics, search, or diff analysis. Extend `DiffScrollMarkerKind` and `buildDiffScrollMarkers` when a new scan marker belongs on the diff scrollbar.

Diff analysis is layered over cheap Git rows. Keep base diff rows readable before analysis is ready, then add visual information in place:

- Use token highlights only for partial line edits where the rest of the line remains readable as unchanged context.
- Compute visible token highlights from the paired old/new line text in the renderer, not from semantic or move analysis groups.
- Use old-side deleted-token color and new-side inserted-token color; avoid replaced/whitespace-specific colors until those modes are intentionally reintroduced.
- Do not add token highlights for whole inserted or deleted rows; the row background already communicates that change.
- Keep analysis status chips lifecycle-only while semantic, move, and cross-file grouping accuracy is being refined. Status language is `pending`, `queued`, `analyzing`, `ready`, `stale`, and `failed`.
- Prefer durable model fields and existing row primitives over DOM-only drawing. Virtualized rows must be able to recreate the same visuals from `DiffAnalysis` and `DiffRow` data.

Single-file diff keyboard navigation is rendered through the existing code row primitives. Cursor and visual-selection state should be model-driven from diff rows, not DOM-driven, because diff rows are virtualized. Add cursor or visual styling through `CodeTextHighlight`/`CodeLineModel` so syntax, search, review, cursor, and visual-selection styling share one text-fragment pipeline.

### Folder Diff

Folder diff mode should feel like one review surface over many files. File headers should preserve context with path, file position, row count, review summary, and diagnostics summary. Avoid duplicating single-file-only controls in folder mode unless they work well across many files.

Folder diff should reuse the same review row, gutter, diagnostic, hunk, and scrollbar primitives as single-file diff where possible.

### Review Overview

The review overview is a workspace page, not a persistent side panel. It should not own persisted review state. Use it to summarize reviewed files, thread filters, AI activity, diagnostics, and shortcuts into files or threads.

Session-wide diagnostics shown on the overview should be derived from existing LSP diagnostics APIs while the overview is active. Do not persist diagnostic summaries in review session state unless the review data format explicitly changes.

Thread navigation should be request-based, not persistent selection state. Clicking a thread should open the file, reveal the anchored row, and flash the target briefly.

Avoid reintroducing an always-visible review side panel or drawer that competes with diff exploration space. Keep the overview reachable from workspace navigation instead.

### Settings

Settings should use the same status language as the diff viewer:

- `success` for installed, ready, running, resolved, and reviewed.
- `warning` for missing configuration, missing highlights, and install guidance.
- `danger` for errors and failed server state.
- `info` for loading or neutral availability.

Use shared buttons and badge-like state chips. Keep install commands in `code` blocks or monospace text.

Settings uses a feature-local shell with grouped navigation and one focused content pane. Keep settings sections under `app/src/components/settings/` unless a component is generic enough for unrelated features. Add new settings by extending the section registry and creating a section component; avoid returning to a single page that loads every setting and integration at once.

Settings content should lazy-load expensive integration state from the active section. For example, language server and Tree-sitter grammar RPC calls belong in their section components, not in the settings shell.

## Building New UI

When adding a feature UI, follow this order:

1. Identify whether the UI belongs to an existing feature area: changed files, diff, review, repository, settings, layout, or shared `ui`.
2. Reuse existing shared primitives for buttons, badges, panels, toolbars, and empty states.
3. Reuse feature primitives for domain interactions, especially diff rows, scan markers, review boxes, and diagnostics.
4. Keep state ownership explicit. Use stores for app-level state and feature components for local interaction state such as transient flashes, open popovers, text drafts, or filters.
5. Keep new components small. Prefer one component with clear props/events over a tree of wrappers unless the behavior is reused.
6. Add docs in the same change if users interact with the feature differently, or if the new component becomes a durable design-system pattern.

## Vue And TypeScript Conventions

Use Vue single-file components with `<script setup lang="ts">`.

Use typed props and emits:

```ts
const props = withDefaults(
  defineProps<{
    tone?: "neutral" | "warning";
  }>(),
  {
    tone: "neutral",
  },
);

const emit = defineEmits<{
  select: [id: string];
}>();
```

Use `computed` for derived display state. Use local `ref` state for UI-only interactions. Keep asynchronous side effects in explicit functions and watchers.

Prefer direct functions over generic helpers until behavior is reused. Do not add compatibility branches unless persisted data, external consumers, or shipped behavior require them.

Follow `app/AGENTS.md`: semicolons are required in JS/TS, and Vue templates should have blank lines between sibling elements at the same nesting level.

## SCSS Conventions

Use scoped SCSS in components.

Use tokens:

```scss
.card {
  padding: var(--space-7);
  color: var(--color-text-secondary);
  background: var(--color-bg-panel);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-5);
}
```

Prefer `grid` for pane and card layouts, and `flex` for horizontal controls and metadata rows. Always include `min-width: 0` on grid/flex children that can contain paths, code, or long text.

Use `:focus-visible` for custom interactive elements. Shared `Button` already handles focus, but custom row buttons, icon buttons, and cards need explicit focus styles.

Use `@media (prefers-reduced-motion: reduce)` when adding new non-trivial animations. Transient flash animations should fade out and should not represent persistent state.

## Accessibility Rules

Interactive elements should be real `button`, `input`, or `textarea` elements unless there is a strong reason otherwise.

Every icon-only button needs an `aria-label` or visible text. Prefer visible text in toolbars and selection actions.

Use `aria-pressed` for toggles. Use `role="dialog"` and `aria-modal="true"` for modal drawers and dialogs. Keep focus outlines visible and tokenized with `--color-border-focus`.

Do not rely on color alone when the state is important. Pair colors with text labels, counts, titles, or badges.

## Narrow Desktop Layouts

Diffuse is a desktop app, but narrow desktop windows are supported.

For new layouts:

- Use drawer or collapsible access when a side panel cannot fit.
- Preserve the main diff reading area as the primary surface.
- Avoid mobile/tablet language in code and docs unless the app explicitly adds a mobile target.
- Test layouts around the existing breakpoints near `1280px` and `900px`.

## When To Add A Shared Component

Add a shared component under `app/src/components/ui/` only when it is generic and likely to be reused by unrelated features.

Keep a component feature-local when it contains domain terms or behavior, such as review threads, diagnostics, diff rows, repository paths, or grammar install state.

If a pattern appears in two feature areas, extract only the generic surface or control. Leave domain logic in each feature.

## Documentation Checklist

When a UI change is user-facing, update the relevant docs:

- `README.md` for product-level workflows and visible behavior.
- `docs/lsp.md` for LSP setup, diagnostics, hover, install, and lifecycle behavior.
- `docs/review-spec-v1.md` for review persistence and integration contracts.
- `docs/architecture.md` for process boundaries, state ownership, JSON-RPC flow, or build wiring.
- This document when tokens, shared primitives, or durable UI patterns change.

Run `pnpm build`, `pnpm format:check`, and `git diff --check` for app changes. For docs-only changes, run at least `git diff --check`.
