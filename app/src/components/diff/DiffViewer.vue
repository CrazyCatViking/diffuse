<template>
  <section
    ref="rootRef"
    class="diff-viewer"
    :class="selectionSideClass"
    tabindex="0"
    aria-label="Diff viewer"
    @pointerdown.capture="onRootPointerDown"
  >
    <div class="diff-header">
      <div class="file-meta">
        <span class="file-name">{{ model?.fileId ?? 'No file selected' }}</span>

        <span v-if="model" class="row-count">{{ rows.length }} rows</span>

        <span v-if="analysisStatusMessage" class="analysis-status" :class="analysisStatusClass" :title="analysisStatusTitle">
          {{ analysisStatusMessage }}
        </span>

        <span v-if="hasNewChanges" class="update-status">
          New changes available

          <button class="load-latest" type="button" :disabled="loading" @click="loadLatest">Load latest</button>
        </span>

        <span v-if="syntaxMessage" class="syntax-status" :class="{ loading: installingGrammar }">
          {{ syntaxMessage }}

          <button class="install-grammar" type="button" :disabled="installingGrammar" @click="diff.installMissingGrammar()">
            {{ installingGrammar ? 'Installing...' : 'Install' }}
          </button>

          <span v-if="grammarInstallStep" class="install-step">{{ grammarInstallStep }}</span>
        </span>

        <span v-if="lspStatusMessage" class="lsp-status" :class="lspStatusClass" :title="lspStatusTitle">
          {{ lspStatusMessage }}
        </span>

        <span v-if="lspDiagnosticsMessage" class="lsp-diagnostics" :class="lspDiagnosticsClass">
          {{ lspDiagnosticsMessage }}
        </span>
      </div>

      <DiffViewControls
        show-sync-scroll
        :view-mode="viewMode"
        :context-mode="contextMode"
        :sync-scroll="syncScroll"
        @update:view-mode="diff.setViewMode($event)"
        @update:context-mode="diff.setContextMode($event)"
        @update:sync-scroll="diff.setSyncScroll($event)"
      />
    </div>

    <div v-if="searchOpen" class="diff-search-popover" role="search" aria-label="Search file">
      <SearchInput
        ref="searchInputRef"
        v-model="searchQuery"
        class="file-search-input"
        compact
        placeholder="Search file"
        label="Search file"
        @keydown.enter.prevent="moveSearch($event.shiftKey ? -1 : 1)"
        @keydown.esc.prevent="closeSearch"
      />

      <span class="search-count">{{ searchStatus }}</span>

      <Button variant="ghost" size="sm" :disabled="searchMatches.length === 0" title="Previous match" @click="moveSearch(-1)">Prev</Button>

      <Button variant="ghost" size="sm" :disabled="searchMatches.length === 0" title="Next match" @click="moveSearch(1)">Next</Button>

      <Button variant="ghost" size="sm" title="Close search" @click="closeSearch">Close</Button>
    </div>

    <SingleFileDiffPanes
      :status="paneStatus"
      :view-mode="viewMode"
      :sync-scroll="syncScroll"
      :panes="paneModels"
      :comment-hover-disabled="commentHoverDisabled"
      :review="reviewUi"
      :review-actions="reviewActions"
      :actions="paneActions"
    />

    <DiffViewerOverlays
      :show-selection-toolbar="Boolean(selectionDraft)"
      :selection-style="selectionBubbleStyle"
      :lsp-hover="lspHover"
      :lsp-hover-style="lspHoverStyle"
      @comment-selection="startToolbarSelectionComment"
      @chat-selection="startToolbarSelectionChat"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { useRoute } from 'vue-router';
import { useClient } from '../../lib/useClient';
import { applyDiffAnalysis } from '../../lib/diffAnalysis';
import type { DiffContextMode, LspDiagnostic, LspStatus, ReviewAnchor, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import { routeParamString } from '../../lib/workspaceRoutes';
import {
  diffSurfaceId,
  type CursorActivationReason,
  type CursorActionContext,
  type CursorCommand,
  type CursorMotion,
  type DiffSurface,
  type DiffSurfacePane,
  useCursorStore,
} from '../../stores/cursor';
import { useDiffStore } from '../../stores/diff';
import { useDiffAnalysisStore } from '../../stores/diffAnalysis';
import { useRepoStore } from '../../stores/repo';
import { useReviewStore } from '../../stores/review';
import type { ReviewTextHighlight, SearchTextHighlight } from './HighlightedCode.vue';
import type { InlineReviewEntry } from './InlineReviewBox.vue';
import Button from '../Button.vue';
import SearchInput from '../search/SearchInput.vue';
import {
  buildDisplayRows as buildReviewDisplayRows,
  buildReviewEntriesByEndLine,
  commentStartKey,
  selectionChatEntries as buildSelectionChatEntries,
  type DisplayRow,
} from './reviewRows';
import DiffViewControls from './DiffViewControls.vue';
import DiffViewerOverlays from './DiffViewerOverlays.vue';
import type { DiffScrollMarker, DiffScrollMarkerKind } from './DiffScrollbar.vue';
import { useReviewInteractions } from './useReviewInteractions';
import { buildDiffScrollMarkers } from './diffScrollMarkers';
import { useDiffScrollbar } from './useDiffScrollbar';
import { supportsLspFile, useLspHover } from './useLspHover';
import { useDiffSelection } from './useDiffSelection';
import { useDiffCursor, type DiffCursorPane, type DiffCursorPosition } from './useDiffCursor';
import { buildRenderedDiffRowFields, type DiffRowRenderTarget } from './diffRenderedRows';
import SingleFileDiffPanes from './SingleFileDiffPanes.vue';
import type { DiffPaneActions, DiffPaneModel, DiffRenderedEntry, DiffReviewActions, DiffReviewUi } from './diffViewModels';

type ThreadRevealRequest = {
  threadId: string;
  fileId: string;
  requestId: number;
};

type FileSearchRequest = {
  fileId: string;
  query: string;
  line?: number;
  side?: SyntaxSide;
  requestId: number;
};

const rootRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<InstanceType<typeof SearchInput> | null>(null);
const syncedSplitRef = ref<HTMLElement | null>(null);
const leftRef = ref<HTMLElement | null>(null);
const rightRef = ref<HTMLElement | null>(null);
const inlineRef = ref<HTMLElement | null>(null);
const route = useRoute();
const client = useClient();
const diff = useDiffStore();
const diffAnalysis = useDiffAnalysisStore();
const repo = useRepoStore();
const review = useReviewStore();
const cursor = useCursorStore();
const draftBody = ref('');
const flashingThreadId = ref<string>();
const searchOpen = ref(false);
const searchQuery = ref('');
const activeSearchIndex = ref(0);
const collapsedCommentStarts = ref(new Set<string>());
const expandedResolvedCommentStarts = ref(new Set<string>());
const syntaxCache = new Map<string, SyntaxSpan[]>();
const syntaxPageLineKeys = new Map<string, string[]>();
const syntaxPageAccessOrder: string[] = [];
const syntaxPageStates = new Map<string, 'queued-high' | 'queued-low' | 'loading' | 'done'>();
const highPrioritySyntaxQueue: SyntaxPageRequest[] = [];
const lowPrioritySyntaxQueue: SyntaxPageRequest[] = [];
const syntaxVersion = ref(0);
const initialSyntaxGateActive = ref(false);

let activeSyntaxRequests = 0;
let syntaxVersionFrame: number | undefined;
let isSyncingScroll = false;
let syncScrollFrame: number | undefined;
let pendingScrollSync: { target: HTMLElement; top: number; left: number } | undefined;
let initialSyntaxGateTimer: number | undefined;
let threadFlashTimer: number | undefined;
let initialSyntaxGeneration = 0;
let syntaxRequestGeneration = 0;
let handledThreadRevealRequestId = 0;
let handledFileSearchRequestId = 0;
let diffCursor: ReturnType<typeof useDiffCursor> | undefined;
let suppressCursorAutoScroll = false;
let activeCursorMotion: CursorMotion | undefined;
let cursorScrollFrame: number | undefined;
let pendingCursorRevealInline = false;
let pendingDiffActivation: { surfaceId: string; side: SyntaxSide; reason: CursorActivationReason; hadStoredSurface: boolean } | undefined;
let pendingFileOpenHistoryFileId: string | undefined;
const diffSurfaceRefs = new Map<string, Ref<DiffSurface>>();
const registeredDiffSurfaceIds = new Set<string>();

const routeFileId = computed(() => routeParamString(route.params.fileId));
const model = computed(() => diff.current);
const activeFile = computed(() => repo.changedFiles.find((file) => file.id === model.value?.fileId));
const activeAnalysis = computed(() => diffAnalysis.analysisForFile(model.value?.fileId, activeFile.value?.signature));
const rows = computed(() => applyDiffAnalysis(model.value?.rows ?? [], activeAnalysis.value));
const navigableDiffSides = computed<SyntaxSide[]>(() => {
  if (!model.value || rows.value.length === 0) return [];
  const sides: SyntaxSide[] = [];
  if (hasNavigableSide('old')) sides.push('old');
  if (hasNavigableSide('new')) sides.push('new');
  return sides;
});
const loading = computed(() => diff.loading);
const error = computed(() => diff.error);
const viewMode = computed(() => diff.viewMode);
const contextMode = computed(() => diff.contextMode);
const target = computed(() => repo.diffTarget);
const syncScroll = computed(() => diff.syncScroll);
const installingGrammar = computed(() => diff.installingGrammar);
const grammarInstallStep = computed(() => diff.grammarInstallStep);
const hasNewChanges = computed(() => diff.hasNewChanges);

const threadRevealRequest = computed<ThreadRevealRequest | undefined>(() => {
  const threadId = queryString(route.query.threadId);
  const requestId = queryNumber(route.query.requestId);
  if (!threadId || !routeFileId.value || requestId === undefined) return undefined;
  return { threadId, fileId: routeFileId.value, requestId };
});

const fileSearchRequest = computed<FileSearchRequest | undefined>(() => {
  const query = queryString(route.query.search);
  const requestId = queryNumber(route.query.requestId);
  if (!query || !routeFileId.value || requestId === undefined) return undefined;
  const side = queryString(route.query.side);
  return {
    fileId: routeFileId.value,
    query,
    line: queryNumber(route.query.line),
    side: side === 'old' || side === 'new' ? side : undefined,
    requestId,
  };
});

const queryString = (value: unknown) => {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
};

const queryNumber = (value: unknown) => {
  const text = queryString(value);
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
};

const syntaxPageSize = 256;
const syntaxPageLookaround = 1;
const maxSyntaxCachePages = 32;
const virtualRowOverscan = 20;
const maxConcurrentSyntaxRequests = 2;
const initialSyntaxGateMs = 80;
const threadFlashDurationMs = 1800;
const columnScrollMotions = new Set<CursorMotion>([
  'moveLeft',
  'moveRight',
  'nextWord',
  'previousWord',
  'endWord',
  'lineStart',
  'firstNonBlank',
  'lineEnd',
]);
const scrollbars = useDiffScrollbar({ left: leftRef, right: rightRef, syncedSplit: syncedSplitRef, inline: inlineRef });
const hasLeftScroll = scrollbars.panes.left.hasScroll;
const hasRightScroll = scrollbars.panes.right.hasScroll;
const hasSyncedSplitScroll = scrollbars.panes.syncedSplit.hasScroll;
const hasInlineScroll = scrollbars.panes.inline.hasScroll;
const leftThumbStyle = scrollbars.panes.left.thumbStyle;
const rightThumbStyle = scrollbars.panes.right.thumbStyle;
const syncedSplitThumbStyle = scrollbars.panes.syncedSplit.thumbStyle;
const inlineThumbStyle = scrollbars.panes.inline.thumbStyle;

type SyntaxPageRequest = {
  key: string;
  fileId: string;
  context: DiffContextMode;
  side: SyntaxSide;
  page: number;
  startLine: number;
  endLine: number;
  generation: number;
};

type PaneKey = 'left' | 'right' | 'syncedSplit' | 'inline';

type VirtualRow = DiffRenderedEntry['virtualRow'];

type CursorScrollVirtualizer = {
  getVirtualItems: () => Array<{ index: number; start: number; end?: number; size?: number }>;
  scrollToIndex: (index: number, options?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void;
};

type RenderedRow = DiffRenderedEntry;

type SearchMatch = {
  rowIndex: number;
  side: SyntaxSide;
  line: number;
  startColumn: number;
  endColumn: number;
};

type PointerTextPosition = {
  side: SyntaxSide;
  line: number;
  column: number;
};

const syntaxMessage = computed(() => {
  const syntax = model.value?.syntax;
  if (!syntax?.language) return undefined;
  if (syntax.grammarInstalled) {
    if (syntax.missingReason === 'highlights-query-not-installed') return `No ${syntax.language} highlights query installed`;
    return undefined;
  }

  return `No ${syntax.language} grammar installed`;
});

const diffTargetFingerprint = () =>
  JSON.stringify({
    base: target.value.base,
    compare: target.value.compare,
    includeStaged: target.value.includeStaged,
    includeUnstaged: target.value.includeUnstaged,
    head: repo.repository?.head,
  });
const {
  selectionBubblePosition,
  selectionDraft,
  selectionBubbleStyle,
  selectionSideClass,
  captureSelectionComment,
  lockSelectionSide,
  reviewElementForNode,
  textOffsetWithinElement,
  clearNativeSelection,
  clearSelectionDraftWhenSelectionEnds,
} = useDiffSelection({
  rootRef,
  selector: '[data-review-side][data-review-line]',
  fileForElement: () => activeFile.value,
  diffTargetFingerprint,
  lockSide: true,
});
const fileThreads = computed(() => review.threads.filter((thread) => thread.fileId === model.value?.fileId));
const leftDisplayRows = computed(() => buildDisplayRows('old'));
const rightDisplayRows = computed(() => buildDisplayRows('new'));
const syncedSplitDisplayRows = computed(() => buildDisplayRows());
const inlineDisplayRows = computed(() => buildDisplayRows());
const activeDisplayRows = computed(() => {
  if (viewMode.value === 'split' && syncScroll.value) return [syncedSplitDisplayRows.value];
  if (viewMode.value === 'split') return [leftDisplayRows.value, rightDisplayRows.value];
  return [inlineDisplayRows.value];
});
const leftMarkers = computed(() => scrollMarkersForRows(leftDisplayRows.value, 'old'));
const rightMarkers = computed(() => scrollMarkersForRows(rightDisplayRows.value, 'new'));
const syncedSplitMarkers = computed(() => scrollMarkersForRows(syncedSplitDisplayRows.value));
const inlineMarkers = computed(() => scrollMarkersForRows(inlineDisplayRows.value));
const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLowerCase());
const searchMatches = computed<SearchMatch[]>(() => {
  const query = normalizedSearchQuery.value;
  if (!query) return [];

  const matches: SearchMatch[] = [];
  rows.value.forEach((row, rowIndex) => {
    if (viewMode.value === 'inline') {
      const side = row.kind === 'deleted' ? 'old' : 'new';
      collectSearchMatches(
        matches,
        rowIndex,
        side,
        side === 'old' ? row.oldLine : row.newLine,
        side === 'old' ? row.oldText : row.newText,
        query,
      );
    } else {
      collectSearchMatches(matches, rowIndex, 'old', row.oldLine, row.oldText, query);
      collectSearchMatches(matches, rowIndex, 'new', row.newLine, row.newText, query);
    }
  });
  return matches;
});
const searchMatchesByLine = computed(() => {
  const matchesByLine = new Map<string, SearchMatch[]>();
  for (const match of searchMatches.value) {
    const key = searchLineKey(match.side, match.line);
    const matches = matchesByLine.get(key) ?? [];
    matches.push(match);
    matchesByLine.set(key, matches);
  }
  return matchesByLine;
});
const searchMatchesByRow = computed(() => {
  const matchesByRow = new Map<number, SearchMatch[]>();
  for (const match of searchMatches.value) {
    const matches = matchesByRow.get(match.rowIndex) ?? [];
    matches.push(match);
    matchesByRow.set(match.rowIndex, matches);
  }
  return matchesByRow;
});
const activeSearchMatch = computed(() => searchMatches.value[activeSearchIndex.value]);
const searchStatus = computed(() => {
  if (!searchQuery.value.trim()) return '0/0';
  if (searchMatches.value.length === 0) return 'No results';
  return `${activeSearchIndex.value + 1}/${searchMatches.value.length}`;
});
const lspStatus = ref<LspStatus>();
const lspStatusLoading = ref(false);
const lspDiagnostics = ref<LspDiagnostic[]>([]);
const lspDiagnosticsLoading = ref(false);
let lspStatusGeneration = 0;
let lspDiagnosticsGeneration = 0;
const lspDiagnosticsByLine = computed(() => {
  const diagnosticsByLine = new Map<number, LspDiagnostic[]>();
  for (const diagnostic of lspDiagnostics.value) {
    const diagnostics = diagnosticsByLine.get(diagnostic.line) ?? [];
    diagnostics.push(diagnostic);
    diagnosticsByLine.set(diagnostic.line, diagnostics);
  }
  return diagnosticsByLine;
});
const commentCountByStart = computed(() => {
  const counts = new Map<string, number>();
  for (const thread of fileThreads.value) {
    const key = commentStartKey(thread.anchor.side, thread.anchor.startLine);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
});
const expandedCommentStarts = computed(() => {
  const expanded = new Set<string>();
  for (const thread of fileThreads.value) {
    const key = commentStartKey(thread.anchor.side, thread.anchor.startLine);
    if (collapsedCommentStarts.value.has(key)) continue;
    if (thread.status === 'open' || expandedResolvedCommentStarts.value.has(key)) expanded.add(key);
  }
  return expanded;
});
const reviewHighlightAnchorsBySide = computed(() => {
  const anchors = new Map<SyntaxSide, ReviewAnchor[]>([
    ['old', []],
    ['new', []],
  ]);
  for (const thread of fileThreads.value) {
    if (!expandedCommentStarts.value.has(commentStartKey(thread.anchor.side, thread.anchor.startLine))) continue;
    if (thread.anchor.startColumn === undefined || thread.anchor.endColumn === undefined) continue;
    anchors.get(thread.anchor.side)?.push(thread.anchor);
  }
  if (
    review.draftAnchor &&
    review.draftFile?.id === model.value?.fileId &&
    review.draftAnchor.startColumn !== undefined &&
    review.draftAnchor.endColumn !== undefined
  ) {
    anchors.get(review.draftAnchor.side)?.push(review.draftAnchor);
  }
  return anchors;
});
const lspStatusMessage = computed(() => {
  if (!model.value) return undefined;
  if (lspStatusLoading.value) return 'LSP: checking';
  const status = lspStatus.value;
  if (!status) return undefined;
  if (!status.language) return 'LSP: unavailable';
  if (status.lastError) return `LSP: ${status.serverId ?? status.language} error`;
  if (status.starting) return `LSP: ${status.serverId ?? status.language} starting`;
  if (status.running) return `LSP: ${status.serverId ?? status.language} running`;
  if (status.installed) return `LSP: ${status.serverId ?? status.language} ready`;
  if (status.configured) return `LSP: ${status.command ?? status.serverId ?? status.language} missing`;
  return `LSP: ${status.language} not configured`;
});
const lspStatusClass = computed(() => ({
  ready: Boolean(lspStatus.value?.running && !lspStatus.value?.lastError),
  configured: Boolean(lspStatus.value?.installed && !lspStatus.value?.running && !lspStatus.value?.lastError),
  missing: Boolean(lspStatus.value && (!lspStatus.value.installed || lspStatus.value.lastError)),
  loading: lspStatusLoading.value,
}));
const lspStatusTitle = computed(() => {
  const status = lspStatus.value;
  if (lspStatusLoading.value) return 'Checking configured language server';
  if (!status) return undefined;
  return [
    status.message,
    status.command ? `Command: ${status.command}` : undefined,
    status.configSource ? `Config: ${status.configSource}` : undefined,
    status.running ? 'Session: running' : status.starting ? 'Session: starting' : 'Session: not started',
    status.lastError ? `Last error: ${status.lastError}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
});
const lspDiagnosticsSummary = computed(() => {
  const diagnostics = lspDiagnostics.value;
  return {
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
    total: diagnostics.length,
  };
});
const lspDiagnosticsMessage = computed(() => {
  if (!model.value) return undefined;
  if (lspDiagnosticsLoading.value) return 'Diagnostics: checking';
  const summary = lspDiagnosticsSummary.value;
  if (summary.total === 0) return undefined;
  const parts = [];
  if (summary.errors > 0) parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
  if (summary.warnings > 0) parts.push(`${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`);
  const other = summary.total - summary.errors - summary.warnings;
  if (other > 0) parts.push(`${other} info`);
  return `Diagnostics: ${parts.join(', ')}`;
});
const lspDiagnosticsClass = computed(() => ({
  error: lspDiagnosticsSummary.value.errors > 0,
  warning: lspDiagnosticsSummary.value.errors === 0 && lspDiagnosticsSummary.value.warnings > 0,
  loading: lspDiagnosticsLoading.value,
}));

const analysisStatus = computed(() => (activeFile.value ? diffAnalysis.statusForFile(activeFile.value.id) : undefined));
const analysisStatusMessage = computed(() => {
  if (!model.value || !activeFile.value) return undefined;
  const status = analysisStatus.value?.status ?? 'missing';
  if (status === 'ready') {
    return 'Analysis ready';
  }
  if (status === 'queued') return 'Analysis queued';
  if (status === 'analyzing') return 'Analyzing changes';
  if (status === 'stale') return 'Analysis stale';
  if (status === 'failed') return 'Analysis failed';
  return 'Analysis pending';
});
const analysisStatusClass = computed(() => ({
  ready: analysisStatus.value?.status === 'ready',
  running: analysisStatus.value?.status === 'queued' || analysisStatus.value?.status === 'analyzing',
  stale: analysisStatus.value?.status === 'stale' || analysisStatus.value?.status === 'missing',
  failed: analysisStatus.value?.status === 'failed',
}));
const analysisStatusTitle = computed(() => {
  const status = analysisStatus.value;
  if (!status) return 'Complex diff analysis has not started yet';
  return [status.status, status.message, activeAnalysis.value ? `${activeAnalysis.value.summary.changeGroups} change groups` : undefined]
    .filter(Boolean)
    .join('\n');
});

const loadLspStatus = async () => {
  const currentModel = model.value;
  const generation = ++lspStatusGeneration;
  if (!currentModel || !supportsLspFile(currentModel.fileId)) {
    lspStatus.value = undefined;
    lspStatusLoading.value = false;
    return;
  }

  lspStatusLoading.value = true;
  try {
    const status = await client.getLspStatus(currentModel.fileId, lspStatusSide(), target.value);
    if (generation !== lspStatusGeneration) return;
    lspStatus.value = status;
  } catch (error) {
    if (generation !== lspStatusGeneration) return;
    lspStatus.value = {
      configured: false,
      installed: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (generation === lspStatusGeneration) lspStatusLoading.value = false;
  }
};

const loadLspDiagnostics = async () => {
  const currentModel = model.value;
  const generation = ++lspDiagnosticsGeneration;
  lspDiagnostics.value = [];
  if (!currentModel || !supportsLspFile(currentModel.fileId)) {
    lspDiagnosticsLoading.value = false;
    return;
  }

  lspDiagnosticsLoading.value = true;
  try {
    const diagnostics = await client.getLspDiagnostics(currentModel.fileId, 'new', target.value);
    if (generation !== lspDiagnosticsGeneration) return;
    lspDiagnostics.value = diagnostics.status === 'ok' ? diagnostics.diagnostics : [];
  } catch {
    if (generation !== lspDiagnosticsGeneration) return;
    lspDiagnostics.value = [];
  } finally {
    if (generation === lspDiagnosticsGeneration) {
      lspDiagnosticsLoading.value = false;
      void loadLspStatus();
    }
  }
};

const lspStatusSide = (): SyntaxSide => {
  return rows.value.some((row) => row.newLine) ? 'new' : 'old';
};

const diagnosticsForLine = (side: SyntaxSide, line?: number): LspDiagnostic[] => {
  if (side !== 'new' || !line) return [];
  return lspDiagnosticsByLine.value.get(line) ?? [];
};

const toggleComments = (payload: { side: 'old' | 'new'; line: number }) => {
  const key = commentStartKey(payload.side, payload.line);
  const collapsed = new Set(collapsedCommentStarts.value);
  const expandedResolved = new Set(expandedResolvedCommentStarts.value);
  if (commentsExpandedForStart(payload.side, payload.line)) {
    collapsed.add(key);
    expandedResolved.delete(key);
  } else {
    collapsed.delete(key);
    expandedResolved.add(key);
  }
  collapsedCommentStarts.value = collapsed;
  expandedResolvedCommentStarts.value = expandedResolved;
};

const commentsExpandedForStart = (side: SyntaxSide, line: number) => {
  return expandedCommentStarts.value.has(commentStartKey(side, line));
};

const reviewHighlightsForLine = (side: SyntaxSide, line: number, textLength: number): ReviewTextHighlight[] => {
  return (reviewHighlightAnchorsBySide.value.get(side) ?? [])
    .map((anchor) => reviewHighlightForLine(anchor, line, textLength))
    .filter((highlight): highlight is ReviewTextHighlight => Boolean(highlight));
};

const reviewHighlightForLine = (anchor: ReviewAnchor, line: number, textLength: number): ReviewTextHighlight | undefined => {
  if (line < anchor.startLine || line > anchor.endLine) return undefined;
  const startColumn = line === anchor.startLine ? (anchor.startColumn ?? 0) : 0;
  const endColumn = line === anchor.endLine ? (anchor.endColumn ?? textLength) : textLength;
  if (endColumn <= startColumn) return undefined;
  return { startColumn, endColumn };
};

const collectSearchMatches = (
  matches: SearchMatch[],
  rowIndex: number,
  side: SyntaxSide,
  line: number | undefined,
  text: string | undefined,
  query: string,
) => {
  if (!line || !text) return;
  const lowerText = text.toLowerCase();
  let startColumn = lowerText.indexOf(query);
  while (startColumn !== -1) {
    matches.push({ rowIndex, side, line, startColumn, endColumn: startColumn + query.length });
    startColumn = lowerText.indexOf(query, startColumn + Math.max(query.length, 1));
  }
};

const searchHighlightsForLine = (side: SyntaxSide, line: number | undefined): SearchTextHighlight[] => {
  if (!line || !normalizedSearchQuery.value) return [];
  const active = activeSearchMatch.value;
  return (searchMatchesByLine.value.get(searchLineKey(side, line)) ?? []).map((match) => ({
    startColumn: match.startColumn,
    endColumn: match.endColumn,
    active: Boolean(active && sameSearchMatch(match, active)),
  }));
};

const searchLineKey = (side: SyntaxSide, line: number) => `${side}:${line}`;

const sameSearchMatch = (first: SearchMatch, second: SearchMatch) => {
  return (
    first.rowIndex === second.rowIndex &&
    first.side === second.side &&
    first.line === second.line &&
    first.startColumn === second.startColumn &&
    first.endColumn === second.endColumn
  );
};

const buildDisplayRows = (side?: SyntaxSide): DisplayRow[] => {
  const fileId = model.value?.fileId;
  if (!fileId) return buildReviewDisplayRows(rows.value, new Map());
  return buildReviewDisplayRows(
    rows.value,
    buildReviewEntriesByEndLine({
      fileId,
      threads: fileThreads.value,
      chatMessages: review.chatMessages,
      collapsedCommentStarts: collapsedCommentStarts.value,
      resolvedCommentStarts: expandedResolvedCommentStarts.value,
      draft:
        review.draftAnchor && review.draftFile
          ? { fileId: review.draftFile.id, anchor: review.draftAnchor, mode: review.draftMode }
          : undefined,
      side,
    }),
  );
};

const buildRenderedRows = (virtualRows: VirtualRow[], displayRows: DisplayRow[], renderTarget: DiffRowRenderTarget): RenderedRow[] => {
  syntaxVersion.value;
  const diffSurfaceActive = activeDiffSurface();
  return virtualRows.map((virtualRow) => {
    const item = displayRows[virtualRow.index];
    const fields = buildRenderedDiffRowFields(item, {
      fileId: model.value?.fileId,
      syntaxSpansForLine: (side, line) => syntaxCache.get(syntaxKey(side, line)),
      commentCountForLine: (side, line) => commentCountByStart.value.get(commentStartKey(side, line)) ?? 0,
      commentsExpandedForLine: commentsExpandedForStart,
      reviewHighlightsForLine,
      searchHighlightsForLine,
      cursorStateForLine: (side, line, textLength) =>
        diffSurfaceActive ? (diffCursor?.lineStateForLine(side, line, textLength) ?? {}) : {},
      diagnosticsForLine,
      renderTarget,
    });
    return {
      virtualRow,
      ...fields,
      reviewRow: item && item.kind !== 'diff' ? item : undefined,
      reviewFocused: item && item.kind !== 'diff' ? diffSurfaceActive && diffCursor?.isReviewFocused(item.key) : false,
    };
  });
};

const selectionChatEntries = computed<InlineReviewEntry[]>(() => {
  if (!model.value?.fileId) return [];
  return buildSelectionChatEntries(model.value.fileId, review.chatMessages);
});

const startLineComment = (payload: { side: 'old' | 'new'; line: number; text: string; clientX: number; clientY: number }) => {
  if (!model.value || !activeFile.value) return;
  selectionDraft.value = undefined;
  draftBody.value = '';
  review.startDraft(activeFile.value, {
    side: payload.side,
    startLine: payload.line,
    endLine: payload.line,
    lineText: payload.text,
    diffTargetFingerprint: diffTargetFingerprint(),
  });
};

const {
  chatMessagesForEntry,
  agentRespondingForEntry,
  submitComment,
  submitChatDraft,
  cancelDraft,
  addReply,
  askAiInThread,
  collapseThread,
  resolveThread,
  reopenThread,
  startSelectionComment,
  startSelectionChat,
} = useReviewInteractions({
  review,
  draftBody,
  collapsedCommentStarts,
  expandedResolvedCommentStarts,
  selectionDraft,
  clearNativeSelection,
});

const startToolbarSelectionComment = () => {
  startSelectionComment();
  diffCursor?.clearVisual();
};

const startToolbarSelectionChat = () => {
  startSelectionChat();
  diffCursor?.clearVisual();
};

const reviewUi = computed<DiffReviewUi>(() => ({
  draftBody: draftBody.value,
  error: review.error,
  flashingThreadId: flashingThreadId.value,
  chatMessagesForEntry,
  agentRespondingForEntry,
}));

const reviewActions: DiffReviewActions = {
  updateDraftBody: (value) => {
    draftBody.value = value;
  },
  submit: submitComment,
  submitChatDraft,
  cancel: cancelDraft,
  reply: addReply,
  chat: askAiInThread,
  collapse: collapseThread,
  resolve: resolveThread,
  reopen: reopenThread,
};

const openSearch = () => {
  searchOpen.value = true;
};

const closeSearch = () => {
  searchOpen.value = false;
  searchQuery.value = '';
  activeSearchIndex.value = 0;
};

const moveSearch = (direction: number) => {
  if (searchMatches.value.length === 0) return;
  const step = direction < 0 ? -1 : 1;
  const steps = Math.max(1, Math.abs(direction));
  for (let index = 0; index < steps; index += 1) {
    activeSearchIndex.value = (activeSearchIndex.value + step + searchMatches.value.length) % searchMatches.value.length;
  }
  scrollToActiveSearchMatch();
};

const onRootPointerDown = (event: PointerEvent) => {
  lockSelectionSide(event);
  const target = event.target instanceof HTMLElement ? event.target : undefined;
  if (target?.closest('.review-box')) {
    return;
  }
  if (target?.closest('.diff-scrollbar')) return;
  if (isInteractiveTarget(event.target)) return;

  const pointerPosition = pointerTextPosition(event);
  const surfaceId =
    pointerPosition && model.value ? diffSurfaceId(model.value.fileId, pointerPosition.side) : diffSurfaceIdForPointer(event);
  if (surfaceId) cursor.setActiveSurface(surfaceId, { activate: false });
  rootRef.value?.focus({ preventScroll: true });
  diffCursor?.clearVisual();
  selectionDraft.value = undefined;
  clearNativeSelection();
  if (pointerPosition) diffCursor?.moveCursorToLine(pointerPosition.side, pointerPosition.line, pointerPosition.column);
};

const isTextInputTarget = (target: EventTarget | null) => {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, [contenteditable="true"]'));
};

const isInteractiveTarget = (target: EventTarget | null) => {
  return target instanceof HTMLElement && Boolean(target.closest('button, input, textarea, select, a, [contenteditable="true"]'));
};

const clearCursorTransientState = () => {
  clearLspHover();
  selectionDraft.value = undefined;
  clearNativeSelection();
};

const onDocumentKeyDown = (event: KeyboardEvent) => {
  if (event.defaultPrevented) return;
  const isTextInput = isTextInputTarget(event.target);
  if (!isTextInput && event.key === 'Escape' && selectionDraft.value) {
    event.preventDefault();
    diffCursor?.clearVisual();
    clearCursorTransientState();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openSearch();
    return;
  }
};

onMounted(() => {
  document.addEventListener('keydown', onDocumentKeyDown);
  document.addEventListener('selectionchange', clearSelectionDraftWhenSelectionEnds);
  scrollbars.startObserving([rootRef.value]);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocumentKeyDown);
  document.removeEventListener('selectionchange', clearSelectionDraftWhenSelectionEnds);
  if (threadFlashTimer) window.clearTimeout(threadFlashTimer);
  if (initialSyntaxGateTimer !== undefined) {
    window.clearTimeout(initialSyntaxGateTimer);
    initialSyntaxGateTimer = undefined;
  }
  if (syncScrollFrame !== undefined) {
    cancelAnimationFrame(syncScrollFrame);
    syncScrollFrame = undefined;
  }
  if (syntaxVersionFrame !== undefined) {
    cancelAnimationFrame(syntaxVersionFrame);
    syntaxVersionFrame = undefined;
  }
  if (cursorScrollFrame !== undefined) {
    cancelAnimationFrame(cursorScrollFrame);
    cursorScrollFrame = undefined;
  }
  cleanupLspHover();
  scrollbars.cleanup();
  for (const surfaceId of registeredDiffSurfaceIds) cursor.unregisterSurface(surfaceId);
  registeredDiffSurfaceIds.clear();
  diffSurfaceRefs.clear();
  diff.clear();
});

const loadLatest = () => {
  if (routeFileId.value) void diff.loadDiff(routeFileId.value);
};

watch(
  routeFileId,
  (fileId) => {
    if (!fileId) {
      diff.clear();
      return;
    }

    const previousFileId = model.value?.fileId;
    if (cursor.isRestoringHistory()) pendingFileOpenHistoryFileId = undefined;
    if (previousFileId && previousFileId !== fileId && !cursor.isRestoringHistory()) {
      syncActiveDiffSurfacePosition();
      const previousPosition = diffCursor?.currentSurfacePosition();
      cursor.recordSurfacePosition(diffSurfaceId(previousFileId, previousPosition?.side ?? 'new'));
      pendingFileOpenHistoryFileId = fileId;
    }

    repo.selectFile(fileId);
    void diff.loadDiff(fileId, { silent: diff.current?.fileId === fileId });
  },
  { immediate: true },
);

watch(
  () => repo.diffTarget,
  () => {
    if (routeFileId.value) void diff.loadDiff(routeFileId.value);
  },
  { deep: true },
);

watch(
  () => repo.changeRevision,
  () => {
    const fileId = routeFileId.value;
    if (!fileId) return;
    if (diff.current?.fileId === fileId && repo.changedFileIds.includes(fileId)) diff.markNewChanges();
  },
);

watch(
  [() => activeFile.value?.id, () => activeFile.value?.signature, contextMode, () => JSON.stringify(target.value)],
  () => {
    const file = activeFile.value;
    if (!file) return;
    void diffAnalysis.refreshStatuses([file], contextMode.value).then(() => {
      diffAnalysis.ensureFiles([file], contextMode.value);
    });
  },
  { immediate: true },
);

const {
  hover: lspHover,
  hoverStyle: lspHoverStyle,
  queue: queueLspHover,
  showAt: showLspHoverAt,
  clear: clearLspHover,
  clearCache: clearLspHoverCache,
  cleanup: cleanupLspHover,
} = useLspHover({
  client,
  target: () => target.value,
  diffTargetFingerprint,
  reviewElementForNode,
  textOffsetWithinElement,
  fileIdForElement: (element) => element.dataset.reviewFileId ?? model.value?.fileId,
  canQueue: () => Boolean(model.value && lspStatus.value?.running && !commentHoverDisabled.value),
  afterHoverRequest: () => {
    void loadLspStatus();
  },
});

const estimateDisplayItemSize = (item?: DisplayRow) => {
  if (!item) return 24;
  if (item.kind === 'draft') return 220;
  if (item.kind === 'thread') return 150;
  if (item.kind === 'chat') return 150;
  return item.row.kind === 'hunk' ? 28 : 24;
};

const estimateDisplaySize = (items: DisplayRow[]) => (index: number) => estimateDisplayItemSize(items[index]);

const scrollMarkersForRows = (items: DisplayRow[], side?: SyntaxSide): DiffScrollMarker[] => {
  return buildDiffScrollMarkers(items, {
    estimateSize: estimateDisplayItemSize,
    kindForItem: (item) => markerKindsForDisplayRow(item, side),
    side,
  });
};

const markerKindsForDisplayRow = (item: DisplayRow, side?: SyntaxSide): DiffScrollMarkerKind[] => {
  const kinds: DiffScrollMarkerKind[] = [];
  if (item.kind !== 'diff') return ['review'];
  kinds.push(...diffMarkerKinds(item.row.kind, side));
  const diagnostics = diagnosticsForMarkerRow(item, side);
  if (diagnostics.length > 0) kinds.push(diagnosticMarkerKind(diagnostics));
  const searchKind = searchMarkerKind(item, side);
  if (searchKind) kinds.push(searchKind);
  return kinds;
};

const diffMarkerKinds = (kind: string, side?: SyntaxSide): DiffScrollMarkerKind[] => {
  if (kind === 'added' || kind === 'deleted') return [kind];
  if (kind === 'modified') {
    if (side === 'old') return ['deleted'];
    if (side === 'new') return ['added'];
    return ['deleted', 'added'];
  }
  return [];
};

const diagnosticsForMarkerRow = (item: DisplayRow, side?: SyntaxSide) => {
  if (item.kind !== 'diff' || side === 'old') return [];
  return diagnosticsForLine('new', item.row.newLine);
};

const diagnosticMarkerKind = (diagnostics: LspDiagnostic[]): DiffScrollMarkerKind => {
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return 'diagnostic-error';
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'warning')) return 'diagnostic-warning';
  return 'diagnostic-info';
};

const searchMarkerKind = (item: DisplayRow, side?: SyntaxSide): DiffScrollMarkerKind | undefined => {
  if (item.kind !== 'diff') return undefined;
  const active = activeSearchMatch.value;
  const rowMatches = [item.rowIndex, item.pairedRowIndex]
    .filter((index): index is number => index !== undefined)
    .flatMap((rowIndex) => searchMatchesByRow.value.get(rowIndex) ?? []);
  const matches = side ? rowMatches.filter((match) => match.side === side) : rowMatches;
  if (matches.length === 0) return undefined;
  return active && matches.some((match) => sameSearchMatch(match, active)) ? 'active-search' : 'search';
};

const leftVirtualizer = useVirtualizer(
  computed(() => ({
    count: leftDisplayRows.value.length,
    getScrollElement: () => leftRef.value,
    getItemKey: (index) => leftDisplayRows.value[index]?.key ?? index,
    estimateSize: estimateDisplaySize(leftDisplayRows.value),
    overscan: virtualRowOverscan,
    useAnimationFrameWithResizeObserver: true,
  })),
);

const rightVirtualizer = useVirtualizer(
  computed(() => ({
    count: rightDisplayRows.value.length,
    getScrollElement: () => rightRef.value,
    getItemKey: (index) => rightDisplayRows.value[index]?.key ?? index,
    estimateSize: estimateDisplaySize(rightDisplayRows.value),
    overscan: virtualRowOverscan,
    useAnimationFrameWithResizeObserver: true,
  })),
);

const syncedSplitVirtualizer = useVirtualizer(
  computed(() => ({
    count: syncedSplitDisplayRows.value.length,
    getScrollElement: () => syncedSplitRef.value,
    getItemKey: (index) => syncedSplitDisplayRows.value[index]?.key ?? index,
    estimateSize: estimateDisplaySize(syncedSplitDisplayRows.value),
    overscan: virtualRowOverscan,
    useAnimationFrameWithResizeObserver: true,
  })),
);

const inlineVirtualizer = useVirtualizer(
  computed(() => ({
    count: inlineDisplayRows.value.length,
    getScrollElement: () => inlineRef.value,
    getItemKey: (index) => inlineDisplayRows.value[index]?.key ?? index,
    estimateSize: estimateDisplaySize(inlineDisplayRows.value),
    overscan: virtualRowOverscan,
    useAnimationFrameWithResizeObserver: true,
  })),
);

const leftVirtualRows = computed(() => leftVirtualizer.value.getVirtualItems());
const rightVirtualRows = computed(() => rightVirtualizer.value.getVirtualItems());
const syncedSplitVirtualRows = computed(() => syncedSplitVirtualizer.value.getVirtualItems());
const inlineVirtualRows = computed(() => inlineVirtualizer.value.getVirtualItems());
const leftRenderedRows = computed(() => buildRenderedRows(leftVirtualRows.value, leftDisplayRows.value, 'old'));
const rightRenderedRows = computed(() => buildRenderedRows(rightVirtualRows.value, rightDisplayRows.value, 'new'));
const syncedSplitRenderedRows = computed(() => buildRenderedRows(syncedSplitVirtualRows.value, syncedSplitDisplayRows.value, 'split'));
const inlineRenderedRows = computed(() => buildRenderedRows(inlineVirtualRows.value, inlineDisplayRows.value, 'inline'));
const activeSyntaxRowRequests = computed(() => {
  if (viewMode.value === 'split' && syncScroll.value) {
    return [
      { virtualRows: syncedSplitVirtualRows.value, displayRows: syncedSplitDisplayRows.value, sides: ['old', 'new'] as SyntaxSide[] },
    ];
  }
  if (viewMode.value === 'split') {
    return [
      { virtualRows: leftVirtualRows.value, displayRows: leftDisplayRows.value, sides: ['old'] as SyntaxSide[] },
      { virtualRows: rightVirtualRows.value, displayRows: rightDisplayRows.value, sides: ['new'] as SyntaxSide[] },
    ];
  }
  return [{ virtualRows: inlineVirtualRows.value, displayRows: inlineDisplayRows.value, sides: ['old', 'new'] as SyntaxSide[] }];
});
const leftTotalSize = computed(() => leftVirtualizer.value.getTotalSize());
const rightTotalSize = computed(() => rightVirtualizer.value.getTotalSize());
const syncedSplitTotalSize = computed(() => syncedSplitVirtualizer.value.getTotalSize());
const inlineTotalSize = computed(() => inlineVirtualizer.value.getTotalSize());
const activePaneTotalSizes = computed(() => {
  if (viewMode.value === 'split' && syncScroll.value) return [syncedSplitTotalSize.value];
  if (viewMode.value === 'split') return [leftTotalSize.value, rightTotalSize.value];
  return [inlineTotalSize.value];
});
const commentHoverDisabled = computed(() => {
  if (viewMode.value === 'split' && syncScroll.value) return syncedSplitVirtualizer.value.isScrolling;
  if (viewMode.value === 'split') return leftVirtualizer.value.isScrolling || rightVirtualizer.value.isScrolling;
  return inlineVirtualizer.value.isScrolling;
});

watch([activePaneTotalSizes, viewMode, syncScroll], scrollbars.updateAfterRender, {
  immediate: true,
  flush: 'post',
});

const measureLeftElement = (element: unknown) => {
  leftVirtualizer.value.measureElement(element instanceof Element ? element : null);
};

const measureRightElement = (element: unknown) => {
  rightVirtualizer.value.measureElement(element instanceof Element ? element : null);
};

const measureSyncedSplitElement = (element: unknown) => {
  syncedSplitVirtualizer.value.measureElement(element instanceof Element ? element : null);
};

const measureInlineElement = (element: unknown) => {
  inlineVirtualizer.value.measureElement(element instanceof Element ? element : null);
};

const paneStatus = computed(() => ({
  loading: loading.value,
  error: error.value,
  hasModel: Boolean(model.value),
  rowsLength: rows.value.length,
  initialSyntaxGateActive: initialSyntaxGateActive.value,
}));

const noopMeasureElement = () => {};

const inactivePaneModel = (key: PaneKey): DiffPaneModel => ({
  key,
  compositionMode: key === 'syncedSplit' ? 'split' : key === 'inline' ? 'inline' : 'pane',
  paneSide: key === 'left' ? 'old' : key === 'right' ? 'new' : undefined,
  rows: [],
  totalSize: 0,
  hasScroll: false,
  markers: [],
  thumbStyle: {},
  measureElement: noopMeasureElement,
});

const paneModels = computed<Record<PaneKey, DiffPaneModel>>(() => {
  const panes: Record<PaneKey, DiffPaneModel> = {
    left: inactivePaneModel('left'),
    right: inactivePaneModel('right'),
    syncedSplit: inactivePaneModel('syncedSplit'),
    inline: inactivePaneModel('inline'),
  };

  if (viewMode.value === 'split' && syncScroll.value) {
    panes.syncedSplit = {
      key: 'syncedSplit',
      compositionMode: 'split',
      rows: syncedSplitRenderedRows.value,
      totalSize: syncedSplitTotalSize.value,
      hasScroll: hasSyncedSplitScroll.value,
      markers: syncedSplitMarkers.value,
      thumbStyle: syncedSplitThumbStyle.value,
      paneClass: 'synced-split-view',
      spacerClass: 'synced-split-spacer',
      measureElement: measureSyncedSplitElement,
    };
    return panes;
  }

  if (viewMode.value === 'split') {
    panes.left = {
      key: 'left',
      compositionMode: 'pane',
      paneSide: 'old',
      rows: leftRenderedRows.value,
      totalSize: leftTotalSize.value,
      hasScroll: hasLeftScroll.value,
      markers: leftMarkers.value,
      thumbStyle: leftThumbStyle.value,
      shellClass: 'old-pane-shell',
      paneClass: 'old-pane',
      keyPrefix: 'old-',
      measureElement: measureLeftElement,
    };
    panes.right = {
      key: 'right',
      compositionMode: 'pane',
      paneSide: 'new',
      rows: rightRenderedRows.value,
      totalSize: rightTotalSize.value,
      hasScroll: hasRightScroll.value,
      markers: rightMarkers.value,
      thumbStyle: rightThumbStyle.value,
      paneClass: 'new-pane',
      keyPrefix: 'new-',
      measureElement: measureRightElement,
    };
    return panes;
  }

  panes.inline = {
    key: 'inline',
    compositionMode: 'inline',
    rows: inlineRenderedRows.value,
    totalSize: inlineTotalSize.value,
    hasScroll: hasInlineScroll.value,
    markers: inlineMarkers.value,
    thumbStyle: inlineThumbStyle.value,
    paneClass: 'inline-view',
    spacerClass: 'inline-spacer',
    measureElement: measureInlineElement,
  };
  return panes;
});

const scrollToActiveSearchMatch = () => {
  const match = activeSearchMatch.value;
  if (!match) return;
  diffCursor?.moveCursorToSearchMatch(match);
  if (viewMode.value === 'split' && syncScroll.value) {
    scrollVirtualizerToMatch(syncedSplitVirtualizer.value, syncedSplitDisplayRows.value, match);
  } else if (viewMode.value === 'split' && match.side === 'old') {
    scrollVirtualizerToMatch(leftVirtualizer.value, leftDisplayRows.value, match);
  } else if (viewMode.value === 'split') {
    scrollVirtualizerToMatch(rightVirtualizer.value, rightDisplayRows.value, match);
  } else {
    scrollVirtualizerToMatch(inlineVirtualizer.value, inlineDisplayRows.value, match);
  }
  scrollbars.updateAfterRender();
};

const scrollVirtualizerToMatch = (
  virtualizer: { scrollToIndex: (index: number, options?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void },
  displayRows: DisplayRow[],
  match: SearchMatch,
) => {
  const displayIndex = displayRows.findIndex(
    (item) => item.kind === 'diff' && (item.rowIndex === match.rowIndex || item.pairedRowIndex === match.rowIndex),
  );
  if (displayIndex === -1) return;
  virtualizer.scrollToIndex(displayIndex, { align: 'center' });
};

const scrollToCursorPosition = (position: DiffCursorPosition, motion?: CursorMotion) => {
  if (suppressCursorAutoScroll) {
    scrollbars.updateAfterRender();
    return;
  }

  const target = cursorScrollTarget(position);
  const needsVerticalScroll = !target.element || !displayIndexFullyVisible(target.virtualizer, target.element, position.displayIndex);
  if (needsVerticalScroll) target.virtualizer.scrollToIndex(position.displayIndex, { align: 'auto' });

  if (needsVerticalScroll || (motion && columnScrollMotions.has(motion)))
    scheduleCursorPostScroll(Boolean(motion && columnScrollMotions.has(motion)));
};

const scheduleCursorPostScroll = (revealInline: boolean) => {
  pendingCursorRevealInline = pendingCursorRevealInline || revealInline;
  void nextTick(() => {
    if (cursorScrollFrame !== undefined) return;
    cursorScrollFrame = requestAnimationFrame(() => {
      cursorScrollFrame = undefined;
      const shouldRevealInline = pendingCursorRevealInline;
      pendingCursorRevealInline = false;
      if (shouldRevealInline) {
        cursorScrollElement()
          ?.querySelector<HTMLElement>('[data-diff-cursor="true"]')
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      scrollbars.updateAfterRender();
    });
  });
};

const cursorScrollTarget = (position: DiffCursorPosition): { virtualizer: CursorScrollVirtualizer; element: HTMLElement | null } => {
  if (viewMode.value === 'split' && syncScroll.value) return { virtualizer: syncedSplitVirtualizer.value, element: syncedSplitRef.value };
  if (viewMode.value === 'split' && position.side === 'old') return { virtualizer: leftVirtualizer.value, element: leftRef.value };
  if (viewMode.value === 'split') return { virtualizer: rightVirtualizer.value, element: rightRef.value };
  return { virtualizer: inlineVirtualizer.value, element: inlineRef.value };
};

const displayIndexFullyVisible = (virtualizer: CursorScrollVirtualizer, element: HTMLElement, displayIndex: number) => {
  const item = virtualizer.getVirtualItems().find((virtualRow) => virtualRow.index === displayIndex);
  if (!item) return false;

  const itemEnd = item.end ?? item.start + (item.size ?? 24);
  const viewportStart = element.scrollTop;
  const viewportEnd = viewportStart + element.clientHeight;
  return item.start >= viewportStart && itemEnd <= viewportEnd;
};

const cursorHalfPageLines = () => {
  const pane = cursorScrollElement();
  const height = pane?.clientHeight ?? 240;
  return Math.max(4, Math.floor(height / 2 / 24));
};

const currentDiffSurfaceSides = (): SyntaxSide[] => {
  return navigableDiffSides.value;
};

const currentDiffSurfaceIds = () => currentDiffSurfaceSides().map((side) => diffSurfaceId(model.value?.fileId ?? '', side));

const activeDiffSurface = () => Boolean(cursor.activeSurfaceId && currentDiffSurfaceIds().includes(cursor.activeSurfaceId));

const activeDiffSurfaceId = () => {
  const currentModel = model.value;
  if (!currentModel) return undefined;

  const surfaceIds = currentDiffSurfaceIds();
  if (cursor.activeSurfaceId && surfaceIds.includes(cursor.activeSurfaceId)) return cursor.activeSurfaceId;

  const currentPosition = diffCursor?.currentSurfacePosition();
  const sides = currentDiffSurfaceSides();
  const side = currentPosition && sides.includes(currentPosition.side) ? currentPosition.side : sides.includes('new') ? 'new' : sides[0];
  return side ? diffSurfaceId(currentModel.fileId, side) : undefined;
};

const syncRegisteredDiffSurfaces = () => {
  const currentModel = model.value;
  const sides = currentDiffSurfaceSides();
  const nextSurfaceIds = new Set(currentModel ? sides.map((side) => diffSurfaceId(currentModel.fileId, side)) : []);

  for (const side of sides) {
    if (!currentModel) continue;
    const surfaceId = diffSurfaceId(currentModel.fileId, side);
    if (registeredDiffSurfaceIds.has(surfaceId)) continue;

    const hadStoredSurface = Boolean(cursor.surface<DiffSurface>(surfaceId));
    const surfaceRef = cursor.registerSurface<DiffSurface>(defaultDiffSurface(currentModel.fileId, side), {
      id: surfaceId,
      getRect: () => diffSurfaceRect(side),
      isEligible: () => currentDiffSurfaceIds().includes(surfaceId),
      activate: (reason) => activateDiffSurface(surfaceId, side, reason, hadStoredSurface),
      onMotion: (motion, context) => handleDiffSurfaceMotion(surfaceId, motion, context),
      onCommand: (command, context) => handleDiffSurfaceCommand(surfaceId, command, context),
    });
    diffSurfaceRefs.set(surfaceId, surfaceRef);
    registeredDiffSurfaceIds.add(surfaceId);
  }

  for (const surfaceId of [...registeredDiffSurfaceIds]) {
    if (nextSurfaceIds.has(surfaceId)) continue;
    cursor.unregisterSurface(surfaceId);
    registeredDiffSurfaceIds.delete(surfaceId);
    diffSurfaceRefs.delete(surfaceId);
  }

  const nextActiveSurfaceId = activeDiffSurfaceId();
  if (nextActiveSurfaceId && !activeDiffSurface()) {
    cursor.setActiveSurface(nextActiveSurfaceId, { activate: false });
    const side = diffSurfaceSideFromId(nextActiveSurfaceId);
    if (side) activateDiffSurface(nextActiveSurfaceId, side, 'default', Boolean(cursor.surface<DiffSurface>(nextActiveSurfaceId)));
  }
};

const defaultDiffSurface = (fileId: string, side: SyntaxSide): DiffSurface => {
  const currentPosition = diffCursor?.currentSurfacePosition();
  if (currentPosition?.fileId === fileId && currentPosition.side === side) {
    return { id: diffSurfaceId(fileId, side), type: 'diff', position: currentPosition };
  }

  const pane: DiffSurfacePane = viewMode.value === 'split' ? side : 'inline';
  return {
    id: diffSurfaceId(fileId, side),
    type: 'diff',
    position: {
      fileId,
      pane,
      side,
      line: 1,
      column: 0,
      rowIndex: 0,
      displayIndex: 0,
      target: 'code',
    },
  };
};

const diffSurfaceRect = (side: SyntaxSide) => {
  if (viewMode.value !== 'split') return inlineRef.value?.getBoundingClientRect() ?? rootRef.value?.getBoundingClientRect();
  if (syncScroll.value) return syncedSplitRef.value?.getBoundingClientRect() ?? rootRef.value?.getBoundingClientRect();
  return (side === 'old' ? leftRef.value : rightRef.value)?.getBoundingClientRect() ?? rootRef.value?.getBoundingClientRect();
};

const activateDiffSurface = (surfaceId: string, side: SyntaxSide, reason: CursorActivationReason = 'default', hadStoredSurface = true) => {
  rootRef.value?.focus({ preventScroll: true });
  const restored = diffSurfaceRefs.get(surfaceId)?.value.position;
  if (!diffActivationReady(restored, side, reason, hadStoredSurface)) {
    pendingDiffActivation = { surfaceId, side, reason, hadStoredSurface };
    return;
  }

  if (reason === 'surface-move') {
    const currentPosition = diffCursor?.currentSurfacePosition();
    if (currentPosition && currentPosition.fileId === model.value?.fileId && diffSurfacePositionVisible(currentPosition)) {
      restoreCursorWithoutAutoScroll(currentPosition);
    } else if (restored && diffSurfacePositionVisible(restored)) restoreCursorWithoutAutoScroll(restored);
    else moveCursorToFirstVisibleDiffLine(restored?.side);
    syncActiveDiffSurfacePosition();
    return;
  }

  if (reason === 'history' || hadStoredSurface) {
    const restoredCursor = restored ? diffCursor?.moveCursorToSurfacePosition(restored) : false;
    if (!restoredCursor) moveCursorToInitialDiffPosition();
    recordPendingFileOpenHistory();
  } else {
    moveCursorToInitialDiffPosition();
    recordPendingFileOpenHistory();
  }
  syncActiveDiffSurfacePosition();
};

const flushPendingDiffActivation = () => {
  const pending = pendingDiffActivation;
  if (!pending) return;
  if (!diffSurfaceRefs.has(pending.surfaceId)) {
    pendingDiffActivation = undefined;
    return;
  }

  const restored = diffSurfaceRefs.get(pending.surfaceId)?.value.position;
  if (!diffActivationReady(restored, pending.side, pending.reason, pending.hadStoredSurface)) return;

  pendingDiffActivation = undefined;
  activateDiffSurface(pending.surfaceId, pending.side, pending.reason, pending.hadStoredSurface);
};

const diffActivationReady = (
  restored: DiffSurface['position'] | undefined,
  side: SyntaxSide,
  reason: CursorActivationReason,
  hadStoredSurface: boolean,
) => {
  if (reason === 'surface-move') return true;
  if ((reason === 'history' || hadStoredSurface) && restored) return Boolean(scrollElementForSide(restored.side));
  return Boolean(scrollElementForSide(side));
};

const handleDiffSurfaceMotion = (surfaceId: string, motion: CursorMotion, context: CursorActionContext) => {
  cursor.setActiveSurface(surfaceId, { activate: false });
  ensureDiffSurfaceCursor(surfaceId);
  const before = diffCursor?.currentSurfacePosition();
  activeCursorMotion = motion;
  let handled = false;
  try {
    handled = diffCursor?.handleAction(motion, context.count, context.hasCount) ?? false;
  } finally {
    activeCursorMotion = undefined;
  }
  const after = diffCursor?.currentSurfacePosition();
  syncActiveDiffSurfacePosition();
  return {
    handled,
    significant: Boolean(
      handled && (motion === 'diffSideLeft' || motion === 'diffSideRight') && before && after && before.pane !== after.pane,
    ),
  };
};

const handleDiffSurfaceCommand = (surfaceId: string, command: CursorCommand, context: CursorActionContext) => {
  if (command === 'activate') return false;
  cursor.setActiveSurface(surfaceId, { activate: false });
  ensureDiffSurfaceCursor(surfaceId);
  const handled = diffCursor?.handleAction(command, context.count, context.hasCount) ?? false;
  syncActiveDiffSurfacePosition();
  return handled;
};

const ensureDiffSurfaceCursor = (surfaceId: string) => {
  rootRef.value?.focus({ preventScroll: true });
  if (currentDiffCursorSurfaceId() === surfaceId) return;
  const side = diffSurfaceSideFromId(surfaceId);
  if (side) activateDiffSurface(surfaceId, side, 'default', Boolean(cursor.surface<DiffSurface>(surfaceId)));
};

const currentDiffCursorSurfaceId = () => {
  const position = diffCursor?.currentSurfacePosition();
  return position ? diffSurfaceId(position.fileId, position.side) : undefined;
};

const syncActiveDiffSurfacePosition = () => {
  const position = diffCursor?.currentSurfacePosition();
  if (!position) return;

  const surfaceId = diffSurfaceId(position.fileId, position.side);
  const surfaceRef = diffSurfaceRefs.get(surfaceId) ?? cursor.surface<DiffSurface>(surfaceId);
  if (!surfaceRef) return;

  surfaceRef.value.position = position;
  if (currentDiffSurfaceIds().includes(surfaceId) && cursor.activeSurfaceId !== surfaceId)
    cursor.setActiveSurface(surfaceId, { activate: false });
};

const recordPendingFileOpenHistory = () => {
  const position = diffCursor?.currentSurfacePosition();
  if (!position || pendingFileOpenHistoryFileId !== position.fileId || cursor.isRestoringHistory()) return;
  syncActiveDiffSurfacePosition();
  cursor.recordSurfacePosition(diffSurfaceId(position.fileId, position.side));
  pendingFileOpenHistoryFileId = undefined;
};

const diffSurfaceSideFromId = (surfaceId: string): SyntaxSide | undefined => {
  if (surfaceId.endsWith(':old')) return 'old';
  if (surfaceId.endsWith(':new')) return 'new';
  return undefined;
};

const cursorPaneForDiffSurfacePane = (pane: DiffSurfacePane): DiffCursorPane => {
  if (pane === 'inline' || viewMode.value !== 'split') return 'inline';
  return pane === 'old' ? 'left' : 'right';
};

const diffSurfacePositionVisible = (position: DiffSurface['position']) => {
  const element = reviewElementForLine(position.side, position.line);
  const scrollElement = scrollElementForSide(position.side);
  if (!element || !scrollElement) return false;

  const elementRect = element.getBoundingClientRect();
  const scrollRect = scrollElement.getBoundingClientRect();
  return elementRect.top >= scrollRect.top && elementRect.bottom <= scrollRect.bottom;
};

const moveCursorToFirstVisibleDiffLine = (preferredSide?: SyntaxSide) => {
  const side = preferredSide && hasNavigableSide(preferredSide) ? preferredSide : hasNavigableSide('new') ? 'new' : 'old';
  const scrollElement = scrollElementForSide(side);
  if (!scrollElement) {
    diffCursor?.moveCursorToPane(cursorPaneForDiffSurfacePane(viewMode.value === 'split' ? side : 'inline'));
    return;
  }

  const scrollRect = scrollElement.getBoundingClientRect();
  const elements = [...scrollElement.querySelectorAll<HTMLElement>(`[data-review-side="${side}"][data-review-line]`)];
  const firstVisible = elements.find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom >= scrollRect.top && rect.top <= scrollRect.bottom;
  });

  const line = firstVisible ? Number(firstVisible.dataset.reviewLine) : undefined;
  if (line && Number.isFinite(line)) {
    diffCursor?.moveCursorToLine(side, line, 0);
    return;
  }

  diffCursor?.moveCursorToPane(cursorPaneForDiffSurfacePane(viewMode.value === 'split' ? side : 'inline'));
};

const moveCursorToInitialDiffPosition = () => {
  if (viewMode.value === 'split' && hasNavigableSide('new')) {
    diffCursor?.moveCursorToPane(cursorPaneForDiffSurfacePane('new'));
    return;
  }

  if (viewMode.value === 'split' && hasNavigableSide('old')) {
    diffCursor?.moveCursorToPane(cursorPaneForDiffSurfacePane('old'));
    return;
  }

  diffCursor?.moveCursorToPane('inline');
};

const restoreCursorWithoutAutoScroll = (position: DiffSurface['position']) => {
  suppressCursorAutoScroll = true;
  try {
    return diffCursor?.moveCursorToSurfacePosition(position) ?? false;
  } finally {
    suppressCursorAutoScroll = false;
  }
};

const scrollElementForSide = (side: SyntaxSide) => {
  if (viewMode.value === 'split' && syncScroll.value) return syncedSplitRef.value;
  if (viewMode.value === 'split' && side === 'old') return leftRef.value;
  if (viewMode.value === 'split') return rightRef.value;
  return inlineRef.value;
};

const hasNavigableSide = (side: SyntaxSide) => {
  return rows.value.some((row) => row.kind !== 'hunk' && Boolean(side === 'old' ? row.oldLine : row.newLine));
};

const moveCursorToPointer = (event: MouseEvent | PointerEvent) => {
  const position = pointerTextPosition(event);
  if (!position) return false;

  diffCursor?.moveCursorToLine(position.side, position.line, position.column);
  return true;
};

const diffSurfaceIdForPointer = (event: MouseEvent | PointerEvent) => {
  const currentModel = model.value;
  if (!currentModel) return undefined;

  const position = pointerTextPosition(event);
  if (position) return diffSurfaceId(currentModel.fileId, position.side);

  const pane = diffSurfacePaneForPointer(event);
  if (!pane) return undefined;

  const side = pane === 'inline' ? fallbackDiffSurfaceSide() : pane;
  return side ? diffSurfaceId(currentModel.fileId, side) : undefined;
};

const fallbackDiffSurfaceSide = (): SyntaxSide | undefined => {
  const sides = currentDiffSurfaceSides();
  return sides.includes('new') ? 'new' : sides[0];
};

const diffSurfacePaneForPointer = (event: MouseEvent | PointerEvent): DiffSurfacePane | undefined => {
  if (!(event.target instanceof Node)) return undefined;
  if (viewMode.value !== 'split') return inlineRef.value?.contains(event.target) ? 'inline' : undefined;

  if (!syncScroll.value) {
    if (leftRef.value?.contains(event.target)) return 'old';
    if (rightRef.value?.contains(event.target)) return 'new';
    return undefined;
  }

  const rect = syncedSplitRef.value?.getBoundingClientRect();
  if (!rect || !syncedSplitRef.value?.contains(event.target)) return undefined;
  return event.clientX < rect.left + rect.width / 2 ? 'old' : 'new';
};

const pointerTextPosition = (event: MouseEvent | PointerEvent): PointerTextPosition | undefined => {
  if (!(event.target instanceof Node)) return undefined;

  const element = reviewElementForNode(event.target);
  if (!element) return undefined;

  const side = element.dataset.reviewSide;
  const line = Number(element.dataset.reviewLine);
  if ((side !== 'old' && side !== 'new') || !Number.isFinite(line)) return undefined;

  return {
    side,
    line,
    column: columnAtPoint(element, event.clientX, event.clientY),
  };
};

const moveCursorToSelectionFocus = () => {
  const selection = window.getSelection();
  if (!selection?.focusNode) return false;

  const element = reviewElementForNode(selection.focusNode);
  if (!element) return false;

  const side = element.dataset.reviewSide;
  const line = Number(element.dataset.reviewLine);
  if ((side !== 'old' && side !== 'new') || !Number.isFinite(line)) return false;

  const column = textOffsetWithinElement(element, selection.focusNode, selection.focusOffset);
  diffCursor?.moveCursorToLine(side, line, column);
  return true;
};

const columnAtPoint = (element: HTMLElement, clientX: number, clientY: number) => {
  const text = element.dataset.reviewText ?? element.textContent ?? '';
  const range = rangeAtPoint(clientX, clientY);
  if (range && element.contains(range.startContainer)) {
    return Math.max(0, Math.min(text.length, textOffsetWithinElement(element, range.startContainer, range.startOffset)));
  }

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const fontSize = Number.parseFloat(style.fontSize) || 12;
  const charWidth = fontSize * 0.62;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  return Math.max(0, Math.min(text.length, Math.round((clientX - rect.left - paddingLeft) / charWidth)));
};

const rangeAtPoint = (clientX: number, clientY: number): Range | undefined => {
  const documentWithCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
  if (position) {
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return documentWithCaret.caretRangeFromPoint?.(clientX, clientY) ?? undefined;
};

const cursorScrollElement = () => {
  const cursor = diffCursor?.cursor.value;
  if (!cursor) return inlineRef.value ?? syncedSplitRef.value ?? rightRef.value ?? leftRef.value;
  if (cursor.pane === 'left') return leftRef.value;
  if (cursor.pane === 'right') return rightRef.value;
  if (cursor.pane === 'syncedSplit') return syncedSplitRef.value;
  return inlineRef.value;
};

const showCursorHover = (position: DiffCursorPosition) => {
  if (!supportsLspFile(position.fileId) || !lspStatus.value?.running) return;

  const marker = rootRef.value?.querySelector<HTMLElement>('[data-diff-cursor="true"]');
  const rect = marker?.getBoundingClientRect();
  const rootRect = rootRef.value?.getBoundingClientRect();
  showLspHoverAt({
    fileId: position.fileId,
    side: position.side,
    line: position.line,
    column: position.column,
    clientX: rect?.left ?? (rootRect ? rootRect.left + 120 : 120),
    clientY: rect?.bottom ?? (rootRect ? rootRect.top + 80 : 80),
  });
};

const startCursorComment = (anchor: ReviewAnchor) => {
  startCursorDraft(anchor, 'comment');
};

const startCursorAskAi = (anchor: ReviewAnchor) => {
  startCursorDraft(anchor, 'chat');
};

const startCursorDraft = (anchor: ReviewAnchor, mode: 'comment' | 'chat') => {
  if (!activeFile.value) return;
  selectionDraft.value = undefined;
  clearNativeSelection();
  draftBody.value = '';
  review.startDraft(activeFile.value, anchor, mode);
};

const syncCursorNativeSelection = (anchor: ReviewAnchor | undefined) => {
  if (!anchor) {
    clearNativeSelection();
    return;
  }

  void nextTick(() => {
    selectCursorAnchor(anchor);
  });
};

const selectCursorAnchor = (anchor: ReviewAnchor) => {
  const start = reviewElementForLine(anchor.side, anchor.startLine);
  const end = reviewElementForLine(anchor.side, anchor.endLine);
  if (!start || !end) return;

  const range = document.createRange();
  const startBoundary = textBoundary(start, anchor.startColumn ?? 0);
  const endBoundary = textBoundary(end, anchor.endColumn ?? (end.dataset.reviewText ?? '').length);
  range.setStart(startBoundary.node, startBoundary.offset);
  range.setEnd(endBoundary.node, endBoundary.offset);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

const reviewElementForLine = (side: SyntaxSide, line: number) => {
  return rootRef.value?.querySelector<HTMLElement>(`[data-review-side="${side}"][data-review-line="${line}"]`);
};

const textBoundary = (element: HTMLElement, column: number): { node: Node; offset: number } => {
  const textLength = (element.dataset.reviewText ?? element.textContent ?? '').length;
  let remaining = Math.max(0, Math.min(textLength, column));
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let lastText: Text | undefined;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    lastText = node;
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
  }

  if (lastText) return { node: lastText, offset: lastText.data.length };
  return { node: element, offset: 0 };
};

const positionCursorSelectionToolbar = () => {
  const root = rootRef.value;
  const marker = root?.querySelector<HTMLElement>('[data-diff-cursor="true"]');
  if (!root || !marker) return;

  const rootRect = root.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const toolbarWidth = 220;
  const toolbarHeight = 34;
  const gap = 6;
  selectionBubblePosition.value = {
    left: Math.max(12, Math.min(markerRect.right - rootRect.left + gap, rootRect.width - toolbarWidth - 12)),
    top: Math.max(48, Math.min(markerRect.top - rootRect.top - toolbarHeight - gap, rootRect.height - toolbarHeight - 12)),
  };
};

diffCursor = useDiffCursor({
  model: () => model.value,
  viewMode: () => viewMode.value,
  syncScroll: () => syncScroll.value,
  displayRows: (side) => {
    if (viewMode.value === 'inline') return inlineDisplayRows.value;
    if (syncScroll.value) return syncedSplitDisplayRows.value;
    return side === 'old' ? leftDisplayRows.value : rightDisplayRows.value;
  },
  diagnostics: () => lspDiagnostics.value,
  diffTargetFingerprint,
  halfPageLines: cursorHalfPageLines,
  onOpenSearch: openSearch,
  onMoveSearch: moveSearch,
  onHover: showCursorHover,
  onComment: startCursorComment,
  onAskAi: startCursorAskAi,
  onClear: clearCursorTransientState,
  onMove: (position) => {
    syncActiveDiffSurfacePosition();
    scrollToCursorPosition(position, activeCursorMotion);
  },
});

watch(
  () => [viewMode.value, syncScroll.value, model.value?.fileId, rows.value.length] as const,
  () => {
    void nextTick(() => {
      syncRegisteredDiffSurfaces();
    });
  },
  { immediate: true, flush: 'post' },
);

watch(
  diffCursor.visualAnchor,
  (anchor) => {
    syncCursorNativeSelection(anchor);
  },
  { flush: 'post' },
);

const revealFileSearchRequest = async () => {
  const request = fileSearchRequest.value;
  if (!request || request.requestId === handledFileSearchRequestId || request.fileId !== model.value?.fileId || loading.value) return;

  searchOpen.value = true;
  searchQuery.value = request.query;
  await nextTick();

  const targetIndex = fileSearchRequestMatchIndex(request);
  activeSearchIndex.value = targetIndex >= 0 ? targetIndex : 0;

  await nextTick();
  if (searchMatches.value.length > 0) scrollToActiveSearchMatch();

  handledFileSearchRequestId = request.requestId;
};

const fileSearchRequestMatchIndex = (request: FileSearchRequest) => {
  if (!request.line) return searchMatches.value.length > 0 ? 0 : -1;
  return searchMatches.value.findIndex((match) => match.line === request.line && (!request.side || match.side === request.side));
};

const revealThreadRequest = async () => {
  const request = threadRevealRequest.value;
  if (!request || request.requestId === handledThreadRevealRequestId || request.fileId !== model.value?.fileId || loading.value) return;

  const thread = fileThreads.value.find((item) => item.id === request.threadId);
  if (!thread) return;

  const key = commentStartKey(thread.anchor.side, thread.anchor.startLine);
  const collapsed = new Set(collapsedCommentStarts.value);
  const expandedResolved = new Set(expandedResolvedCommentStarts.value);
  let changed = false;

  if (collapsed.delete(key)) changed = true;
  if (thread.status === 'resolved' && !expandedResolved.has(key)) {
    expandedResolved.add(key);
    changed = true;
  }

  if (changed) {
    collapsedCommentStarts.value = collapsed;
    expandedResolvedCommentStarts.value = expandedResolved;
    await nextTick();
  }

  await nextTick();
  if (!scrollToReviewThread(thread.id, thread.anchor.side)) return;
  diffCursor?.moveCursorToReviewKey(`thread:${thread.id}`);

  handledThreadRevealRequestId = request.requestId;
  await flashReviewThread(thread.id);
};

const flashReviewThread = async (threadId: string) => {
  if (threadFlashTimer) window.clearTimeout(threadFlashTimer);
  flashingThreadId.value = undefined;
  await nextTick();
  flashingThreadId.value = threadId;
  threadFlashTimer = window.setTimeout(() => {
    if (flashingThreadId.value === threadId) flashingThreadId.value = undefined;
    threadFlashTimer = undefined;
  }, threadFlashDurationMs);
};

const scrollToReviewThread = (threadId: string, side: SyntaxSide) => {
  if (!scrollElementForThread(side)) return false;

  let scrolled = false;
  if (viewMode.value === 'split' && syncScroll.value) {
    scrolled = scrollVirtualizerToThread(syncedSplitVirtualizer.value, syncedSplitDisplayRows.value, threadId);
  } else if (viewMode.value === 'split' && side === 'old') {
    scrolled = scrollVirtualizerToThread(leftVirtualizer.value, leftDisplayRows.value, threadId);
  } else if (viewMode.value === 'split') {
    scrolled = scrollVirtualizerToThread(rightVirtualizer.value, rightDisplayRows.value, threadId);
  } else {
    scrolled = scrollVirtualizerToThread(inlineVirtualizer.value, inlineDisplayRows.value, threadId);
  }
  if (scrolled) scrollbars.updateAfterRender();
  return scrolled;
};

const scrollElementForThread = (side: SyntaxSide) => {
  if (viewMode.value === 'split' && syncScroll.value) return syncedSplitRef.value;
  if (viewMode.value === 'split' && side === 'old') return leftRef.value;
  if (viewMode.value === 'split') return rightRef.value;
  return inlineRef.value;
};

const scrollVirtualizerToThread = (
  virtualizer: { scrollToIndex: (index: number, options?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void },
  displayRows: DisplayRow[],
  threadId: string,
) => {
  const displayIndex = displayRows.findIndex((item) => item.kind === 'thread' && item.thread.id === threadId);
  if (displayIndex === -1) return false;
  virtualizer.scrollToIndex(displayIndex, { align: 'center' });
  return true;
};

watch(
  [
    () => threadRevealRequest.value?.requestId,
    () => threadRevealRequest.value?.fileId,
    () => model.value?.fileId,
    loading,
    viewMode,
    syncScroll,
    () => leftRef.value,
    () => rightRef.value,
    () => syncedSplitRef.value,
    () => inlineRef.value,
    activeDisplayRows,
  ],
  () => {
    void revealThreadRequest();
  },
  { immediate: true, flush: 'post' },
);

watch(
  [() => fileSearchRequest.value?.requestId, () => fileSearchRequest.value?.fileId, () => model.value?.fileId, loading],
  () => {
    void revealFileSearchRequest();
  },
  { immediate: true, flush: 'post' },
);

const syntaxKey = (side: SyntaxSide, line: number) => `${side}:${line}`;

const syntaxPageKey = (fileId: string, context: DiffContextMode, side: SyntaxSide, page: number) => `${fileId}:${context}:${side}:${page}`;

const scheduleSyntaxVersionBump = () => {
  if (syntaxVersionFrame !== undefined) return;
  syntaxVersionFrame = requestAnimationFrame(() => {
    syntaxVersionFrame = undefined;
    syntaxVersion.value += 1;
  });
};

const runSyntaxQueue = () => {
  while (activeSyntaxRequests < maxConcurrentSyntaxRequests) {
    const request = highPrioritySyntaxQueue.shift() ?? lowPrioritySyntaxQueue.shift();
    if (!request) return;

    const state = syntaxPageStates.get(request.key);
    if (state !== 'queued-high' && state !== 'queued-low') {
      continue;
    }

    syntaxPageStates.set(request.key, 'loading');
    activeSyntaxRequests += 1;
    void (async () => {
      try {
        const lines = await client.getSyntaxSpans(
          request.fileId,
          request.side,
          request.startLine,
          request.endLine,
          { context: request.context },
          target.value,
        );
        const isCurrentRequest =
          request.generation === syntaxRequestGeneration &&
          model.value?.fileId === request.fileId &&
          model.value.context === request.context;
        if (isCurrentRequest) {
          const lineKeys: string[] = [];
          for (const line of lines) {
            const key = syntaxKey(request.side, line.line);
            syntaxCache.set(key, line.spans);
            lineKeys.push(key);
          }
          syntaxPageStates.set(request.key, 'done');
          syntaxPageLineKeys.set(request.key, lineKeys);
          touchSyntaxPage(request.key);
          evictOldSyntaxPages();
          scheduleSyntaxVersionBump();
        } else if (request.generation === syntaxRequestGeneration && syntaxPageStates.get(request.key) === 'loading') {
          syntaxPageStates.delete(request.key);
        }
      } catch {
        if (request.generation === syntaxRequestGeneration) syntaxPageStates.delete(request.key);
      } finally {
        activeSyntaxRequests = Math.max(0, activeSyntaxRequests - 1);
        runSyntaxQueue();
      }
    })();
  }
};

const requestSyntaxPage = (side: SyntaxSide, page: number, priority: 'high' | 'low') => {
  const currentModel = model.value;
  if (!currentModel?.syntax.grammarInstalled || page < 0) return false;

  const requestKey = syntaxPageKey(currentModel.fileId, currentModel.context, side, page);
  const existingState = syntaxPageStates.get(requestKey);
  if (existingState === 'done') {
    touchSyntaxPage(requestKey);
    return false;
  }
  if (existingState === 'loading' || existingState === 'queued-high') return false;
  if (existingState === 'queued-low' && priority === 'low') return false;

  const fileId = currentModel.fileId;
  const context = currentModel.context;
  const startLine = page * syntaxPageSize + 1;
  const endLine = startLine + syntaxPageSize - 1;
  const request = { key: requestKey, fileId, context, side, page, startLine, endLine, generation: syntaxRequestGeneration };
  if (priority === 'high') {
    syntaxPageStates.set(requestKey, 'queued-high');
    highPrioritySyntaxQueue.push(request);
  } else {
    syntaxPageStates.set(requestKey, 'queued-low');
    lowPrioritySyntaxQueue.push(request);
  }
  runSyntaxQueue();
  return true;
};

const touchSyntaxPage = (key: string) => {
  const existingIndex = syntaxPageAccessOrder.indexOf(key);
  if (existingIndex >= 0) syntaxPageAccessOrder.splice(existingIndex, 1);
  syntaxPageAccessOrder.push(key);
};

const evictOldSyntaxPages = () => {
  while (syntaxPageLineKeys.size > maxSyntaxCachePages) {
    const oldestKey = syntaxPageAccessOrder.shift();
    if (!oldestKey) return;

    const lineKeys = syntaxPageLineKeys.get(oldestKey);
    if (!lineKeys) continue;
    for (const lineKey of lineKeys) syntaxCache.delete(lineKey);
    syntaxPageLineKeys.delete(oldestKey);
    if (syntaxPageStates.get(oldestKey) === 'done') syntaxPageStates.delete(oldestKey);
  }
};

const requestSyntaxPages = (side: SyntaxSide, startLine: number, endLine: number, priority: 'high' | 'low') => {
  const firstPage = Math.max(0, Math.floor((startLine - 1) / syntaxPageSize) - syntaxPageLookaround);
  const lastPage = Math.floor((endLine - 1) / syntaxPageSize) + syntaxPageLookaround;
  for (let page = firstPage; page <= lastPage; page += 1) requestSyntaxPage(side, page, priority);
};

const requestSyntaxForVirtualRows = (virtualRows: { index: number }[], displayRows: DisplayRow[], side: SyntaxSide) => {
  let startLine = Number.POSITIVE_INFINITY;
  let endLine = 0;
  for (const virtualRow of virtualRows) {
    const item = displayRows[virtualRow.index];
    if (!item || item.kind !== 'diff') continue;
    const row = item.row;
    const line = side === 'old' ? row?.oldLine : row?.newLine;
    if (!line) continue;
    startLine = Math.min(startLine, line);
    endLine = Math.max(endLine, line);
  }
  if (Number.isFinite(startLine)) {
    requestSyntaxPages(side, startLine, endLine, 'high');
  }
};

const firstLineForSide = (side: SyntaxSide) => {
  for (const row of rows.value) {
    const line = side === 'old' ? row.oldLine : row.newLine;
    if (line) return line;
  }
  return undefined;
};

const requestInitialSyntaxPages = () => {
  if (!model.value?.syntax.grammarInstalled) return;
  const oldLine = firstLineForSide('old');
  const newLine = firstLineForSide('new');
  if (oldLine) requestSyntaxPages('old', oldLine, oldLine, 'high');
  if (newLine) requestSyntaxPages('new', newLine, newLine, 'high');
};

const releaseInitialSyntaxGate = (generation: number) => {
  if (generation !== initialSyntaxGeneration) return;
  if (initialSyntaxGateTimer !== undefined) window.clearTimeout(initialSyntaxGateTimer);
  initialSyntaxGateTimer = undefined;
  initialSyntaxGateActive.value = false;
};

const startInitialSyntaxGate = () => {
  initialSyntaxGeneration += 1;
  const generation = initialSyntaxGeneration;
  if (!model.value?.syntax.grammarInstalled || rows.value.length === 0) {
    releaseInitialSyntaxGate(generation);
    return;
  }

  initialSyntaxGateActive.value = true;
  requestInitialSyntaxPages();
  initialSyntaxGateTimer = window.setTimeout(() => releaseInitialSyntaxGate(generation), initialSyntaxGateMs);

  const waitForInitialPages = async () => {
    while (generation === initialSyntaxGeneration && highPrioritySyntaxQueue.length > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 8));
    }
    releaseInitialSyntaxGate(generation);
  };
  void waitForInitialPages();
};

const syncScrollPosition = (source: HTMLElement, target: HTMLElement | null) => {
  if (!syncScroll.value || !target) return;
  pendingScrollSync = { target, top: source.scrollTop, left: source.scrollLeft };
  if (syncScrollFrame !== undefined) return;

  syncScrollFrame = requestAnimationFrame(() => {
    syncScrollFrame = undefined;
    const sync = pendingScrollSync;
    pendingScrollSync = undefined;
    if (!sync) return;

    isSyncingScroll = true;
    if (sync.target.scrollTop !== sync.top) sync.target.scrollTop = sync.top;
    if (sync.target.scrollLeft !== sync.left) sync.target.scrollLeft = sync.left;
    isSyncingScroll = false;
    scrollbars.schedule();
  });
};

const onLeftScroll = (event: Event) => {
  scrollbars.schedule();
  if (isSyncingScroll) return;
  syncScrollPosition(event.currentTarget as HTMLElement, rightRef.value);
};

const onRightScroll = (event: Event) => {
  scrollbars.schedule();
  if (isSyncingScroll) return;
  syncScrollPosition(event.currentTarget as HTMLElement, leftRef.value);
};

const onSyncedSplitScroll = () => {
  scrollbars.schedule();
};

const onInlineScroll = () => {
  scrollbars.schedule();
};

const onPaneMouseUp = (event: MouseEvent) => {
  if (isInteractiveTarget(event.target)) return;

  const selectedText = window.getSelection()?.toString().trim();
  captureSelectionComment();
  if (selectedText) {
    moveCursorToSelectionFocus();
    void nextTick(() => {
      positionCursorSelectionToolbar();
    });
    return;
  }

  diffCursor?.clearVisual();
  clearCursorTransientState();
  moveCursorToPointer(event);
};

const setPaneRef = (pane: PaneKey, element: Element | null) => {
  const htmlElement = element instanceof HTMLElement ? element : null;
  const currentElement = paneRefValue(pane);
  if (currentElement === htmlElement) return;

  if (pane === 'left') leftRef.value = htmlElement;
  else if (pane === 'right') rightRef.value = htmlElement;
  else if (pane === 'syncedSplit') syncedSplitRef.value = htmlElement;
  else inlineRef.value = htmlElement;
  scrollbars.updateAfterRender();
  void nextTick(() => flushPendingDiffActivation());
};

const paneRefValue = (pane: PaneKey) => {
  if (pane === 'left') return leftRef.value;
  if (pane === 'right') return rightRef.value;
  if (pane === 'syncedSplit') return syncedSplitRef.value;
  return inlineRef.value;
};

const onPaneScroll = (pane: PaneKey, event: Event) => {
  clearLspHover();
  if (pane === 'left') onLeftScroll(event);
  else if (pane === 'right') onRightScroll(event);
  else if (pane === 'syncedSplit') onSyncedSplitScroll();
  else onInlineScroll();
};

const onPanePointerMove = (event: PointerEvent) => {
  if (isInteractiveTarget(event.target)) return;

  if ((event.buttons & 1) === 1) {
    clearLspHover();
    return;
  }

  queueLspHover(event);
};

const onScrollbarTrackPointerDown = (event: PointerEvent, pane: PaneKey) => {
  scrollbars.onTrackPointerDown(event, pane);
};

const onScrollbarThumbPointerDown = (event: PointerEvent, pane: PaneKey) => {
  scrollbars.onThumbPointerDown(event, pane);
};

const paneActions: DiffPaneActions = {
  paneRef: setPaneRef,
  scroll: onPaneScroll,
  pointerMove: onPanePointerMove,
  mouseLeave: clearLspHover,
  mouseUp: onPaneMouseUp,
  scrollbarTrackPointerDown: onScrollbarTrackPointerDown,
  scrollbarThumbPointerDown: onScrollbarThumbPointerDown,
  comment: startLineComment,
  toggleComments,
};

watch(syncScroll, (enabled, wasEnabled) => {
  if (viewMode.value !== 'split' || enabled === wasEnabled) return;

  const source = wasEnabled ? syncedSplitRef.value : (leftRef.value ?? rightRef.value);
  const scrollTop = source?.scrollTop ?? 0;
  const scrollLeft = source?.scrollLeft ?? 0;

  void nextTick(() => {
    requestAnimationFrame(() => {
      if (enabled) {
        if (syncedSplitRef.value) {
          syncedSplitRef.value.scrollTop = scrollTop;
          syncedSplitRef.value.scrollLeft = scrollLeft;
        }
        return;
      }

      for (const pane of [leftRef.value, rightRef.value]) {
        if (!pane) continue;
        pane.scrollTop = scrollTop;
        pane.scrollLeft = scrollLeft;
      }
    });
  });
});

watch(
  () => `${model.value?.fileId ?? ''}:${model.value?.context ?? ''}`,
  () => {
    activeSearchIndex.value = 0;
    syntaxRequestGeneration += 1;
    if (syntaxVersionFrame !== undefined) {
      cancelAnimationFrame(syntaxVersionFrame);
      syntaxVersionFrame = undefined;
    }
    syntaxCache.clear();
    syntaxPageLineKeys.clear();
    syntaxPageAccessOrder.length = 0;
    syntaxPageStates.clear();
    highPrioritySyntaxQueue.length = 0;
    lowPrioritySyntaxQueue.length = 0;
    activeSyntaxRequests = 0;
    clearLspHoverCache();
    if (initialSyntaxGateTimer !== undefined) window.clearTimeout(initialSyntaxGateTimer);
    initialSyntaxGateTimer = undefined;
    initialSyntaxGateActive.value = false;
    syntaxVersion.value += 1;
    startInitialSyntaxGate();
  },
);

watch([normalizedSearchQuery, () => model.value?.fileId, () => model.value?.context, viewMode, syncScroll], () => {
  activeSearchIndex.value = 0;
  if (searchMatches.value.length > 0) {
    void nextTick(() => scrollToActiveSearchMatch());
  }
});

watch(searchMatches, (matches) => {
  if (activeSearchIndex.value >= matches.length) activeSearchIndex.value = Math.max(0, matches.length - 1);
});

watch(searchOpen, (open) => {
  if (!open) {
    searchInputRef.value?.blur();
    return;
  }

  void nextTick(() => {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  });
});

watch(
  [model, () => diffTargetFingerprint()],
  () => {
    void loadLspStatus();
    void loadLspDiagnostics();
  },
  { immediate: true },
);

watch(
  [activeSyntaxRowRequests, () => model.value?.syntax.grammarInstalled],
  () => {
    for (const request of activeSyntaxRowRequests.value) {
      for (const side of request.sides) requestSyntaxForVirtualRows(request.virtualRows, request.displayRows, side);
    }
  },
  { immediate: true, flush: 'post' },
);
</script>

<style scoped lang="scss">
.diff-viewer {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--color-bg-app);
  overflow: hidden;

  &:focus {
    outline: none;
  }
}

.diff-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-7);
  min-width: 0;
  height: 40px;
  align-items: center;
  padding: 0 var(--space-6);
  color: var(--color-text-muted);
  background: var(--color-bg-shell);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-label);
}

.diff-search-popover {
  position: absolute;
  top: 40px;
  right: var(--space-6);
  z-index: 8;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  width: min(480px, calc(100% - var(--space-6) - var(--space-6)));
  min-width: 0;
  padding: var(--space-3);
  color: var(--color-text-muted);
  background: var(--color-bg-shell);
  border: 1px solid var(--color-border-default);
  border-top: 0;
  border-radius: 0 0 var(--radius-5) var(--radius-5);
  box-shadow: var(--shadow-popover);
}

.file-search-input {
  flex: 1 1 220px;
  min-width: 160px;
}

.search-count {
  flex: 0 0 auto;
  min-width: 54px;
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
  text-align: center;
}

.file-meta {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: var(--space-4);
  overflow: hidden;
}

.file-name {
  overflow: hidden;
  color: var(--color-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-count {
  flex: 0 0 auto;
  color: var(--color-text-disabled);
}

.syntax-status,
.analysis-status,
.lsp-status,
.lsp-diagnostics,
.update-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  flex: 0 0 auto;
  min-height: 22px;
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);

  &::before {
    width: 7px;
    height: 7px;
    background: currentColor;
    border-radius: var(--radius-pill);
    content: '';
  }
}

.analysis-status {
  color: var(--color-text-muted);
  background: rgba(143, 151, 166, 0.1);
  border-color: rgba(143, 151, 166, 0.18);

  &.ready {
    color: var(--color-ai);
    background: var(--color-ai-muted);
    border-color: rgba(143, 179, 255, 0.25);
  }

  &.running {
    color: var(--color-info);
    background: var(--color-info-muted);
    border-color: rgba(77, 166, 255, 0.25);
  }

  &.stale {
    color: var(--color-text-subtle);
  }

  &.failed {
    color: var(--color-danger);
    background: var(--color-danger-muted);
    border-color: rgba(255, 107, 107, 0.25);
  }
}

.syntax-status {
  color: var(--color-warning);
  background: var(--color-warning-muted);
  border-color: rgba(240, 184, 106, 0.25);

  &.loading {
    color: var(--color-info);
    background: var(--color-info-muted);
    border-color: rgba(77, 166, 255, 0.25);
  }
}

.lsp-status {
  color: var(--color-text-muted);
  background: rgba(143, 151, 166, 0.1);
  border-color: rgba(143, 151, 166, 0.18);

  &.ready {
    color: var(--color-success);
    background: var(--color-success-muted);
    border-color: rgba(91, 184, 119, 0.25);
  }

  &.configured {
    color: var(--color-info);
    background: var(--color-info-muted);
    border-color: rgba(77, 166, 255, 0.25);
  }

  &.missing {
    color: var(--color-warning);
    background: var(--color-warning-muted);
    border-color: rgba(240, 184, 106, 0.25);
  }

  &.loading {
    color: var(--color-text-muted);
  }
}

.lsp-diagnostics {
  color: var(--color-text-muted);
  background: rgba(143, 151, 166, 0.1);
  border-color: rgba(143, 151, 166, 0.18);

  &.error {
    color: var(--color-danger);
    background: var(--color-danger-muted);
    border-color: rgba(255, 107, 107, 0.25);
  }

  &.warning {
    color: var(--color-warning);
    background: var(--color-warning-muted);
    border-color: rgba(240, 184, 106, 0.25);
  }

  &.loading {
    color: var(--color-text-muted);
  }
}

.update-status {
  color: var(--color-info);
  background: var(--color-info-muted);
  border-color: rgba(77, 166, 255, 0.25);
}

.install-grammar,
.load-latest {
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  cursor: pointer;
  font: inherit;

  &:disabled {
    cursor: default;
    opacity: 0.65;
  }
}

.install-grammar {
  color: var(--color-warning);
  background: rgba(240, 184, 106, 0.16);
  border: 1px solid rgba(240, 184, 106, 0.28);
}

.load-latest {
  color: var(--color-info);
  background: var(--color-info-muted);
  border: 1px solid rgba(77, 166, 255, 0.32);
}

.install-step {
  max-width: 220px;
  overflow: hidden;
  color: var(--color-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selecting-old-side :deep([data-review-side='new']),
.selecting-new-side :deep([data-review-side='old']) {
  user-select: none;
}
</style>
