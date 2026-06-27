# Amazing File Search Implementation Plan

## Purpose

Diffuse should have a powerful, unified, low-friction search experience for reviewing changed files. Search should make large diffs feel navigable, help users quickly find the file or change they care about, and support walking through matching results without losing context.

This feature must use the current Diffuse design system and must not depend on the review cockpit, because that feature is being rethought separately.

## Product Goals

- Make finding changed files instant and forgiving.
- Support both casual users and power users.
- Provide a unified search experience across file paths, review metadata, content, comments, and symbols.
- Let users pin search results and walk through matches while reviewing.
- Keep search visually consistent with the design system.
- Keep search independent from review cockpit layout and implementation.
- Preserve good performance on large diffs.
- Prefer changed-file and changed-line search over whole-repository search.

## Non-Goals

- Do not build search into `ReviewPanel.vue`.
- Do not reuse the review cockpit region as the pinned search surface.
- Do not make search depend on future review cockpit placement.
- Do not start with whole-repository Sourcegraph-level search.
- Do not create a parallel visual system outside the design tokens and UI primitives.

## Existing Context

Diffuse currently has:

- `useRepoStore()` for repository state, changed files, active file, diff target, and refresh state.
- `useDiffStore()` for current diff model, view mode, context mode, syntax state, and stale changes.
- `useReviewStore()` for reviewed files, review sessions, threads, progress, agent state, and chat.
- `ChangedFilesPane.vue` for the left changed-file tree.
- `ChangedFileRow.vue` for file rows.
- `App.vue` for file/folder selection and workspace layout.
- `DiffViewer.vue` and `FolderDiffViewer.vue` for diff rendering.
- Core RPC methods for changed files and per-file diff render models.
- Design-system primitives in `components/ui/`.
- Tokens in `styles/tokens.scss`.

The initial UI foundation was implemented renderer-first for file path, review-metadata, comment, and content search. The next search phase should move search execution into the Zig core so the Electron app owns UI state only, while core owns parsing, filtering, matching, ranking, streaming, and cancellation.

## Design-System Requirements

Use existing UI primitives:

- `Button.vue` for actions.
- `Badge.vue` for filters, counts, statuses, and metadata.
- `Panel.vue` for palette and drawer surfaces.
- `Toolbar.vue` for headers and compact action rows.
- `EmptyState.vue` for no-results, no-files, loading, and error states.
- `styles/tokens.scss` variables for colors, spacing, radius, shadow, typography, and transitions.

Avoid:

- Hard-coded colors.
- New one-off button styles.
- New one-off badge styles.
- Search-specific panel styling that duplicates `Panel.vue`.
- Tying search presentation to review cockpit UI.

Potential reusable additions:

- `SearchInput.vue`.
- `Kbd.vue`.
- `SegmentedControl.vue`.

Only add these if they are reusable beyond one component.

## UX Surfaces

### Sidebar Search

`ChangedFilesPane.vue` should become searchable.

Features:

- Persistent search input below the pane header.
- Filter chips for common review/file filters.
- Matching tree pruning.
- Highlighted filename and path matches.
- Folder rows remain visible when descendants match.
- Empty state when no changed files match the current query.
- Result count badge.
- Pin action to open matching files in the pinned search drawer.

Initial sidebar filters:

- `Unviewed`.
- `Viewed`.
- `Comments`.
- `Unresolved`.
- `Generated`.
- `Tests`.
- `Docs`.
- `Renamed`.
- `Deleted`.

Review metadata may be used as search data, but no search UI should be built into the review cockpit.

### Global Search Palette

Add `SearchPalette.vue`.

Behavior:

- Opens with `Cmd/Ctrl+P`.
- Opens content mode with `Cmd/Ctrl+Shift+F`.
- Searches immediately as the user types.
- Supports grouped results.
- Supports keyboard-first navigation.
- Supports previewing results without closing.
- Supports pinning current results into the drawer.

Palette modes:

- `All`.
- `Files`.
- `Content`.
- `Symbols`.
- `Comments`.

Keyboard behavior:

- `ArrowDown` selects next result.
- `ArrowUp` selects previous result.
- `Enter` opens selected result and closes the palette.
- `Space` previews selected result without closing the palette.
- `Shift+Enter` opens selected result and pins the result list.
- `Tab` accepts a suggested filter/completion when available.
- `Esc` closes the palette.

Visual structure:

- Overlay using `var(--color-bg-overlay)`.
- `Panel elevated padding="none"` for the palette.
- Header/input section using design tokens.
- Mode/filter chips using `Badge`.
- Actions using `Button`.
- No-results states using `EmptyState`.

### Pinned Search Results Drawer

Add `SearchResultsDrawer.vue`.

This is a standalone right overlay drawer over the workspace. It must not depend on the review cockpit or workspace right column.

Behavior:

- Opens when user pins results from sidebar or palette.
- Stays open while files are opened.
- Lets users walk through results.
- Keeps current result selected and visible.
- Does not clear query when closed.
- Does not close automatically when opening files.
- On narrow screens, becomes a full-height overlay drawer with backdrop.

Controls:

- Previous result.
- Next result.
- Open selected result.
- Preview selected result.
- Clear query.
- Close drawer.

Keyboard behavior:

- `]` moves to next result.
- `[` moves to previous result.
- `Enter` opens selected result.
- `Esc` closes drawer focus or collapses drawer, depending on focus context.

Drawer content:

- Header with query summary.
- Result count.
- Selected result position, such as `3 of 27`.
- Grouped results.
- File status badges.
- Review metadata badges when applicable.
- Snippets for content/comment/symbol matches.
- Empty state for no pinned results.

## Search Store

Add `app/src/stores/search.ts`.

State:

```ts
type SearchMode = 'all' | 'files' | 'content' | 'symbols' | 'comments';
```

Store fields:

- `query`.
- `mode`.
- `overlayOpen`.
- `drawerOpen`.
- `selectedIndex`.
- `results`.
- `fileResults`.
- `contentResults`.
- `symbolResults`.
- `commentResults`.
- `activeFilters`.
- `history`.
- `loading`.
- `error`.
- `lastGeneration`.

Actions:

- `openOverlay(mode?: SearchMode)`.
- `closeOverlay()`.
- `openDrawer()`.
- `closeDrawer()`.
- `pinResults()`.
- `setQuery(query: string)`.
- `setMode(mode: SearchMode)`.
- `toggleFilter(filter: SearchFilter)`.
- `clearQuery()`.
- `nextResult()`.
- `previousResult()`.
- `selectResult(index: number)`.
- `previewSelected()`.
- `openSelected()`.
- `refreshResults()`.

The store should combine renderer-only file/comment results with async core content/symbol results. Async results must use generation counters so stale responses are ignored.

## Search Result Model

Use a shared local result model.

```ts
type SearchResult =
  | FileSearchResult
  | ContentSearchResult
  | SymbolSearchResult
  | CommentSearchResult
  | ActionSearchResult;
```

File result fields:

- `kind: 'file'`.
- `fileId`.
- `path`.
- `oldPath?`.
- `status`.
- `additions`.
- `deletions`.
- `reviewed`.
- `commentCount`.
- `unresolvedCount`.
- `generated`.
- `test`.
- `docs`.
- `rank`.
- `matches`.

Content result fields:

- `kind: 'content'`.
- `fileId`.
- `path`.
- `side`.
- `line`.
- `text`.
- `matchRanges`.
- `changedLine`.
- `rank`.

Symbol result fields:

- `kind: 'symbol'`.
- `fileId`.
- `path`.
- `name`.
- `symbolKind`.
- `side`.
- `line`.
- `rank`.

Comment result fields:

- `kind: 'comment'`.
- `fileId`.
- `threadId`.
- `path`.
- `status`.
- `body`.
- `side`.
- `line`.
- `rank`.

Action result fields:

- `kind: 'action'`.
- `id`.
- `label`.
- `description`.
- `rank`.

## Query Syntax

Support forgiving plain search and typed filters.

Plain examples:

```text
button
btn cmp
PullCommentRow
review agent
```

Filter examples:

```text
path:src/components
file:Button
ext:tsx
lang:typescript
is:unviewed
is:viewed
is:commented
is:unresolved
is:generated
is:test
is:doc
status:added
status:modified
status:deleted
status:renamed
changes:>100
added:>50
deleted:>50
comment:todo
symbol:validateUser
```

Phrase search:

```text
"review agent"
```

Negation:

```text
-is:generated
NOT path:vendor
```

Later support:

```text
/validate[A-Z]/
foo OR bar
(path:app OR path:core) is:unresolved
```

Parsing should be forgiving. If typed syntax cannot be parsed, treat it as a literal/fuzzy search instead of blocking results.

## Matching And Ranking

Add helpers under `app/src/lib/search/` or `app/src/components/search/`.

Suggested files:

- `searchQueryParser.ts`.
- `searchMatch.ts`.
- `searchRanking.ts`.
- `searchMetadata.ts`.
- `searchResults.ts`.

File ranking order:

- Exact filename match.
- Filename prefix match.
- CamelCase/snake/kebab abbreviation match.
- Fuzzy filename match.
- Exact path segment match.
- Fuzzy full path match.
- Review metadata match.
- Content/comment/symbol match.
- Recent file boost.
- Active folder/file neighborhood boost.
- Unresolved/commented boost when relevant.
- Unviewed boost when relevant.
- Generated/vendor/lockfile downrank unless explicitly searched.

Content ranking order:

- Changed-line match.
- Exact phrase match.
- New-side match.
- Old-side match.
- Context/full-file match.
- Shorter and more direct path boost.

Empty query ranking:

- Recent files.
- Unviewed files.
- Files with unresolved comments.
- Files with comments.
- Risky large files.
- Existing sidebar order.

## File Classification

Add renderer-side classification first.

Classify:

- Generated files.
- Test files.
- Docs files.
- Config files.
- Lock files.
- Vendor/dependency paths.

Generated heuristics:

- `node_modules/`.
- `vendor/`.
- `dist/`.
- `build/`.
- `*.min.js`.
- `*.min.css`.
- `*.map`.
- `package-lock.json`.
- `pnpm-lock.yaml`.
- `yarn.lock`.
- `Cargo.lock`.
- `Gopkg.lock`.
- Generated protobuf/Go patterns where reliable.

Docs heuristics:

- `docs/`.
- `README`.
- `CHANGELOG`.
- `*.md`.
- `*.rst`.
- `*.adoc`.

Test heuristics:

- `test/`.
- `tests/`.
- `__tests__/`.
- `*.test.*`.
- `*.spec.*`.

Core-level `.gitattributes` support can be added later if needed.

## App Integration

Modify `App.vue`.

Add:

- Search store import.
- Global shortcut listeners.
- `SearchPalette` mount near the end of `app-shell`.
- `SearchResultsDrawer` mount near the end of `app-shell`.
- Handlers for opening, previewing, and pinning results.
- A generalized reveal request for search result navigation.

Do not modify:

- `ReviewPanel.vue`.
- Review cockpit placement.
- Review drawer behavior.

Top-level search UI should be independent and overlay the workspace.

## Top Bar Integration

Modify `TopBar.vue`.

Add when a repository is open:

- `Search` button.
- Shortcut hint if a reusable `Kbd.vue` exists or is added.
- Emit `openSearch`.

`App.vue` handles `@open-search="search.openOverlay()"`.

## Changed Files Pane Integration

Modify `ChangedFilesPane.vue`.

Add props or connect to search store directly. Prefer explicit props/emits if the component remains presentational, but using `useSearchStore()` is acceptable if it keeps behavior simpler.

Add:

- Search input.
- Filter chip row.
- Result count.
- Pin current list action.
- Filtered tree calculation.
- Highlighted matching fragments.
- No-results `EmptyState`.

Modify `ChangedFileRow.vue`.

Add props:

- `path`.
- `matches?`.
- `commentCount?`.
- `unresolvedCount?`.
- `generated?`.
- `test?`.
- `docs?`.

Render:

- Highlighted file label.
- Optional metadata badges.
- Existing status/counts/review checkbox remain.

## Search Result Navigation

Add a generalized search reveal request.

```ts
type SearchRevealRequest = {
  requestId: number;
  fileId: string;
  side?: 'old' | 'new';
  line?: number;
  threadId?: string;
  source: 'search';
};
```

Opening behavior:

- File result selects file.
- Comment result selects file and reveals thread using existing thread reveal flow where possible.
- Content result selects file and scrolls to line.
- Symbol result selects file and scrolls to line.
- Preview uses same navigation but keeps palette/drawer open.

`DiffViewer.vue` changes:

- Accept `searchRevealRequest`.
- Watch request changes.
- Locate matching row by side and line.
- Scroll virtualizer to matching row.
- Temporarily highlight row.

`FolderDiffViewer.vue` changes:

- Accept `searchRevealRequest` later.
- If target file is visible in current folder stream, scroll to file/line.
- If target file is outside the selected folder, switch to single-file mode.

## Core-Backed Streaming Search Engine

The next implementation phase should move search execution from the Electron renderer to the Zig core. The renderer should keep local UI state only: query text, selected index, palette/drawer visibility, collapsed categories, pinned result removals, and history. Core should own query parsing, filters, matching, ranking, source loading, review metadata lookup, result ordering, streaming, and cancellation.

Decisions:

- Content search searches full changed-file contents regardless of current diff context.
- Core returns a flat ordered list of results; renderer groups the flat list for display.
- Renderer passes `sessionId` so core can load reviewed state, threads, and comments for the correct review session.
- Streaming and cancellation ship with the first core-backed search implementation.

New core files:

- `core/src/core/search.zig` for parser, filters, matching, ranking, previews, metadata, and source scanning.
- `core/src/app/search_handlers.zig` for JSON-RPC handlers and search job lifecycle.

Core files to update:

- `core/src/app/rpc_handlers.zig` registers search handlers.
- `core/src/app/rpc_runtime.zig` stores active search jobs, a search lock, and a search task group.
- `core/src/app/rpc_events.zig` emits search progress, result, done, cancelled, and error events.
- `core/src/app/rpc_params.zig` parses search params.
- `core/src/protocol/types.zig` defines search result and event structs.

App files to update:

- `app/src/lib/protocol.ts` adds shared search result/event types.
- `app/src/lib/coreContract.ts` adds search RPC methods and core events.
- `app/electron/coreRpcClient.ts` should not need structural changes because it already emits core notifications without request IDs.
- `app/src/stores/search.ts` switches from renderer execution to core-backed streaming state.

### RPC Methods

Start search:

```ts
startSearch({
  searchId?: string;
  sessionId: string;
  query: string;
  mode: 'all' | 'files' | 'content' | 'comments' | 'symbols';
  filters: SearchFilterKind[];
  target: DiffTarget;
}): { searchId: string }
```

Cancel search:

```ts
cancelSearch({
  searchId: string;
}): { cancelled: boolean }
```

`startSearch` should return immediately after registering and spawning the background search job. Results must arrive through core events.

### Search Events

Core should emit line-delimited JSON-RPC notifications:

```ts
type SearchStartedEvent = {
  method: 'search/started';
  params: { searchId: string };
};

type SearchResultsEvent = {
  method: 'search/results';
  params: { searchId: string; results: SearchResult[] };
};

type SearchProgressEvent = {
  method: 'search/progress';
  params: { searchId: string; scannedFiles: number; totalFiles: number; emittedResults: number };
};

type SearchDoneEvent = {
  method: 'search/done';
  params: { searchId: string; totalResults: number; scannedFiles: number };
};

type SearchCancelledEvent = {
  method: 'search/cancelled';
  params: { searchId: string; scannedFiles: number; emittedResults: number };
};

type SearchErrorEvent = {
  method: 'search/error';
  params: { searchId: string; message: string };
};
```

The renderer must ignore events whose `searchId` does not match the active search.

### Result Model

Core returns a flat ordered list of normalized result objects. Renderer grouping is presentational.

```ts
type SearchMatchRange = {
  start: number;
  end: number;
};

type SearchFieldMatch = {
  field: 'name' | 'path' | 'body' | 'symbol';
  ranges: SearchMatchRange[];
  score: number;
};

type SearchResultBase = {
  id: string;
  kind: 'file' | 'content' | 'comment' | 'symbol';
  fileId?: string;
  path?: string;
  title: string;
  subtitle?: string;
  rank: number;
  matches: SearchFieldMatch[];
};
```

File results include changed-file data and metadata:

```ts
type FileSearchResult = SearchResultBase & {
  kind: 'file';
  fileId: string;
  path: string;
  name: string;
  file: ChangedFile;
  metadata: FileSearchMetadata;
};
```

Content results include full-file match location and preview:

```ts
type ContentSearchResult = SearchResultBase & {
  kind: 'content';
  fileId: string;
  path: string;
  side: 'old' | 'new';
  line: number;
  preview: string;
};
```

Comment results should reference persisted review data by ID plus enough display data to render without a second lookup:

```ts
type CommentSearchResult = SearchResultBase & {
  kind: 'comment';
  fileId: string;
  path: string;
  threadId: string;
  status: 'open' | 'resolved';
  anchor: ReviewAnchor;
  body: string;
};
```

Symbol results can be added after file/content/comment parity:

```ts
type SymbolSearchResult = SearchResultBase & {
  kind: 'symbol';
  fileId: string;
  path: string;
  side: 'old' | 'new';
  line: number;
  symbolName: string;
  symbolKind: string;
  containerName?: string;
};
```

### Result Ordering

Core should emit results in deterministic flat order:

1. File/path results.
2. Content results.
3. Comment results.
4. Symbol results, once implemented.

Within each kind, sort by rank descending, then path, then line when available. Keep ranking deterministic so pinned result walking is stable across refreshes.

### Runtime Job Lifecycle

`rpc_runtime.zig` should own active search jobs. Suggested fields:

```zig
search_lock: std.Io.Mutex,
search_jobs: std.StringHashMap(SearchJobState),
search_group: std.Io.Group,
```

`SearchJobState` should start minimal:

```zig
const SearchJobState = struct {
    cancelled: bool,
};
```

Lifecycle:

1. `startSearch` parses and validates params.
2. `startSearch` creates or accepts `searchId`.
3. Handler deep-copies all params because the JSON-RPC request is freed after the handler returns.
4. Handler registers `SearchJobState` under `search_lock`.
5. Handler starts a background search task in `runtime.search_group`.
6. Handler returns `{ searchId }` immediately.
7. Worker checks cancellation between files and during large file scans.
8. Worker emits result batches through `runtime.outbound`.
9. Worker emits `search/done`, `search/cancelled`, or `search/error`.
10. Worker removes its job from `search_jobs` before exit.

Cancellation should be cooperative. `cancelSearch` sets `cancelled = true`; workers observe the flag and stop at safe boundaries. Do not try to forcibly kill running Zig work.

### Full Changed-File Content Search

Content search must not depend on `getDiffRenderModel` or current diff context. It should read full source text for the changed-file side that users expect to review.

Default side policy:

- Added files: search `new` side.
- Modified files: search `new` side.
- Renamed files: search `new` side.
- Deleted files: search `old` side.

Use old paths for old-side lookups and new paths for new-side lookups. This matters for renames and deletions.

Source loading should reuse the existing logic in `core/src/core/diff.zig` where possible:

- Ref comparison: old from `target.base`, new from `target.compare`.
- Staged-only: old from base ref, new from index.
- Unstaged-only: old from index, new from working tree.
- Working tree mixed: old from base ref, new from working tree.

Add a search-specific wrapper instead of calling `getDiffRenderModel`. Search should not parse unified diff rows or run syntax highlighting. It should scan full source text line-by-line, calculate match ranges, and build compact previews.

Content safeguards:

- Skip binary files.
- Apply a per-file byte limit before reading or scanning.
- Emit an error or progress note for skipped huge files later if useful.
- Avoid regex in the first core implementation unless there is a safe timeout/limit story.

### Query, Filters, And Metadata

Core should port the current renderer query/filter behavior first:

- Terms and phrases.
- Negated filters.
- `is:` filters for reviewed/unreviewed/commented/unresolved/generated/test/docs/renamed/deleted.
- `status:` filters.
- `path:`, `file:`, `ext:`, `lang:`, `comment:` filters.
- Numeric change filters can follow after parity if needed.

Core should derive file metadata from changed-file data and review state loaded by `sessionId`:

- `reviewed` from persisted reviewed files.
- `commentCount` and `unresolvedCount` from review threads.
- `generated`, `test`, and `docs` from path/name heuristics.

### Streaming Strategy

Emit stable batches without overwhelming the JSON-RPC pipe:

- Batch size target: 50-100 results.
- Progress target: emit after each file or every few files for very large diffs.
- Flush all pending results before `search/done` or `search/cancelled`.
- Keep batches ordered within their phase. A simple first version can emit all file results, then content results, then comment results.

The renderer should append streamed results for the active `searchId`, update counts immediately, and keep selection clamped as batches arrive.

### Renderer Store Migration

`useSearchStore()` should keep:

- `query` and `treeQuery`.
- `mode`.
- Palette and drawer open state.
- `selectedIndex`.
- `activeFilters` and `treeActiveFilters`.
- Search history.
- Pinned result removals.

`useSearchStore()` should replace:

- Renderer query parsing.
- Renderer filtering and matching.
- Renderer content scan generation counters.
- Renderer `getDiffRenderModel` content scanning.
- Renderer content line cache.

New store state:

- `activeSearchId`.
- `searchLoading`.
- `searchProgress`.
- `results` from core events.
- `treeResults` from a separate core search request or a file-only mode.

Search restarts:

- Debounce query changes in the renderer.
- Cancel active search before starting a new one.
- Ignore stale events by `searchId`.
- Clear result arrays when starting a new search.

### Initial Core Search Milestone

The first core milestone should include:

- `startSearch` and `cancelSearch` RPCs.
- `search/started`, `search/results`, `search/progress`, `search/done`, `search/cancelled`, and `search/error` events.
- File/path results.
- Full changed-file content results.
- Comment results loaded by `sessionId`.
- Current filter/query syntax parity where practical.
- Renderer palette switched to streamed core results.
- Sidebar search can remain renderer-backed until the palette is stable, then move to `mode: 'files'` or a tree-specific search request.

## Symbol Search

Add after file/content/comment search is core-backed. Symbol results should flow through the same `startSearch` stream with `mode: 'symbols'` or `mode: 'all'`; do not add a separate symbol-only RPC unless symbol extraction needs an independent cache warming endpoint later.

Implementation:

- Use Tree-sitter where grammar exists.
- Extract best-effort definitions.
- Return no symbols for files without supported grammar initially.
- Do not block normal file search on symbol extraction.
- Add heuristic fallback later if needed.

## Performance Plan

Renderer:

- Keep search UI state local and cheap.
- Debounce user input before starting core searches.
- Cancel the active core search when query, mode, filters, target, or session changes.
- Ignore stale streamed events by `searchId`.
- Avoid re-sorting streamed results in the renderer unless the core contract changes.

Core:

- Stream result batches instead of returning large result arrays synchronously.
- Support cooperative cancellation from the first core search implementation.
- Search full changed-file source content, independent of current diff context.
- Skip huge files by default and expose skip metadata later if needed.
- Skip binary files.
- Return compact result objects.
- Avoid holding repository locks while performing expensive work.
- Avoid eager syntax or LSP work during search.

## Accessibility

Requirements:

- Palette uses dialog semantics.
- Drawer uses complementary/dialog semantics depending on overlay mode.
- Search input has clear label.
- Filter chips expose pressed state.
- Result list uses active descendant or roving tabindex.
- Keyboard navigation works without mouse.
- Focus returns to prior location when palette closes.
- `Esc` behavior is predictable.
- Match highlights remain readable.
- Drawer controls have accessible labels.

## Responsive Behavior

Desktop:

- Palette centered over workspace.
- Pinned drawer overlays the right side of workspace.
- Drawer width around `min(440px, 42vw)`.

Narrow screens:

- Palette width becomes `calc(100vw - 2 * var(--space-5))`.
- Drawer becomes near full-width or full-height overlay.
- Drawer uses backdrop.
- Result rows remain readable with snippets truncated.

## Implementation Phases

### Phase 1: Search Foundation

- Add search store.
- Add query parser.
- Add fuzzy matcher.
- Add ranking helper.
- Add file classification helper.
- Add result model types.
- Add result cursor navigation.

### Phase 2: Sidebar Search

- Add search input to `ChangedFilesPane.vue`.
- Add filter chips.
- Add filtered tree logic.
- Add highlighted matches.
- Add no-results state.
- Add pin action for current file results.
- Extend `ChangedFileRow.vue` for metadata and highlights.

### Phase 3: Global Palette

- Add `SearchPalette.vue`.
- Mount from `App.vue`.
- Add top bar search button.
- Add global shortcuts.
- Add grouped file/comment/action results.
- Add preview/open/pin behavior.

### Phase 4: Pinned Drawer

- Add `SearchResultsDrawer.vue`.
- Mount from `App.vue`.
- Implement right overlay drawer.
- Add result walking controls.
- Add keyboard navigation.
- Keep drawer independent from review cockpit.
- Add responsive drawer behavior.

### Phase 5: Search Reveal Navigation

- Add search reveal request model.
- Wire file result open/preview.
- Wire comment result reveal through existing thread reveal flow.
- Add `DiffViewer.vue` line reveal for content/symbol results.
- Add temporary row highlight.
- Add `FolderDiffViewer.vue` support later.

### Phase 6: Core Streaming Search Contracts

- Add search protocol structs to `core/src/protocol/types.zig`.
- Add `startSearch` and `cancelSearch` to `app/src/lib/coreContract.ts`.
- Add search event types to the TypeScript core event union.
- Add `core/src/app/search_handlers.zig` and register it from `rpc_handlers.zig`.
- Add search job state, lock, and task group to `rpc_runtime.zig`.
- Add event emitters to `rpc_events.zig`.
- Verify the RPC contract check includes the new methods.

### Phase 7: Core Search Engine

- Add `core/src/core/search.zig`.
- Port query parsing and filter parsing from renderer behavior.
- Implement file/path search and ranking.
- Implement review metadata loading by `sessionId`.
- Implement comment search.
- Implement full changed-file content scanning with side policy for added/modified/renamed/deleted files.
- Implement snippets and match range remapping.
- Implement deterministic flat ordering.
- Implement streamed result batches, progress events, done events, cancellation events, and error events.
- Add Zig unit tests for parser, filters, matching, previews, ordering, and cancellation checks.

### Phase 8: Renderer Migration To Core Search

- Add core search event subscription in the renderer.
- Replace renderer palette search execution with `startSearch` streams.
- Cancel active search when query, mode, filters, target, or session changes.
- Ignore stale events by `searchId`.
- Keep palette category collapse, selected index, and pinned drawer state renderer-owned.
- Move sidebar tree search to core file-only results after palette parity is stable.
- Delete obsolete renderer content line cache and renderer result builders after parity.

### Phase 9: Symbol Search

- Add Tree-sitter symbol extraction in core search.
- Return symbol results through the existing `startSearch` stream.
- Add symbol grouping in palette/drawer through renderer presentation only.
- Add symbol line reveal.

### Phase 10: Polish

- Add filter suggestions.
- Add search history.
- Add shortcut hint component if useful.
- Tune ranking.
- Tune drawer/palette animation and reduced-motion behavior.
- Add robust empty/loading/error states.
- Audit focus and keyboard behavior.

### Phase 11: Documentation And Verification

- Update `README.md`.
- Update `docs/architecture.md`.
- Update `docs/README.md` if a new standalone search doc is added.
- Run app build/typecheck.
- Run core build/tests.
- Verify RPC contract check.

## Files Likely Added

- `app/src/stores/search.ts`.
- `app/src/components/search/SearchPalette.vue`.
- `app/src/components/search/SearchResultsDrawer.vue`.
- `app/src/components/search/SearchInput.vue`.
- `app/src/components/search/SearchResultList.vue`.
- `app/src/components/search/SearchResultRow.vue`.
- `app/src/components/search/SearchFilterChips.vue`.
- `app/src/components/search/SearchMatchHighlight.vue`.
- `app/src/lib/search/searchQueryParser.ts`.
- `app/src/lib/search/searchMatch.ts`.
- `app/src/lib/search/searchRanking.ts`.
- `app/src/lib/search/searchMetadata.ts`.
- `core/src/core/search.zig`.
- `core/src/app/search_handlers.zig`.

## Files Likely Modified

- `app/src/App.vue`.
- `app/src/components/layout/TopBar.vue`.
- `app/src/components/changed-files/ChangedFilesPane.vue`.
- `app/src/components/changed-files/ChangedFileRow.vue`.
- `app/src/components/diff/DiffViewer.vue`.
- `app/src/components/diff/FolderDiffViewer.vue`.
- `app/src/lib/protocol.ts`.
- `app/src/lib/coreContract.ts`.
- `app/src/lib/useClient.ts`.
- `core/src/app/rpc_handlers.zig`.
- `core/src/app/rpc_runtime.zig`.
- `core/src/app/rpc_events.zig`.
- `core/src/app/rpc_params.zig`.
- `core/src/protocol/types.zig`.
- `README.md`.
- `docs/architecture.md`.

## Verification

App:

```sh
pnpm build
pnpm format:check
```

Core/repo:

```sh
just build
```

Manual scenarios:

- Search exact filename.
- Search fuzzy filename.
- Search folder path.
- Search extension.
- Filter unviewed files.
- Filter unresolved comments.
- Search generated files explicitly.
- Pin results and walk next/previous.
- Open files from pinned drawer.
- Preview files from palette.
- Search content in changed lines.
- Jump to content result line.
- Search comments and reveal thread.
- Large diff with hundreds of files.
- Narrow viewport drawer behavior.

## Open Decisions

- Whether `is:reviewed`, `is:unreviewed`, `is:commented`, and `is:unresolved` should ship in the first UI pass or wait until file search basics are polished.
- Whether to add a reusable `Input.vue` to the design system before implementing `SearchInput.vue`.
- Whether `Space` should preview selected result or toggle drawer selection in the pinned results drawer.
- Whether generated files should be merely downranked or hidden behind a default filter.
