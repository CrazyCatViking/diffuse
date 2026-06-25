<template>
  <section ref="rootRef" class="diff-viewer" :class="selectionSideClass" @pointerdown.capture="lockSelectionSide">
    <div class="diff-header">
      <div class="file-meta">
        <span class="file-name">{{ model?.fileId ?? 'No file selected' }}</span>

        <span v-if="model" class="row-count">{{ rows.length }} rows</span>

        <span v-if="hasNewChanges" class="update-status">
          New changes available

          <button class="load-latest" type="button" :disabled="loading" @click="emit('loadLatest')">Load latest</button>
        </span>

        <span v-if="syntaxMessage" class="syntax-status">
          {{ syntaxMessage }}

          <button class="install-grammar" type="button" :disabled="installingGrammar" @click="emit('installGrammar')">
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
        search-enabled
        show-sync-scroll
        :view-mode="viewMode"
        :context-mode="contextMode"
        :search-open="searchOpen"
        :search-query="searchQuery"
        :search-status="searchStatus"
        :has-search-matches="searchMatches.length > 0"
        :sync-scroll="syncScroll"
        @update:view-mode="emit('update:viewMode', $event)"
        @update:context-mode="emit('update:contextMode', $event)"
        @update:sync-scroll="emit('update:syncScroll', $event)"
        @update:search-query="searchQuery = $event"
        @open-search="openSearch"
        @close-search="closeSearch"
        @move-search="moveSearch"
      />
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
      @comment-selection="startSelectionComment"
      @chat-selection="startSelectionChat"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { useClient } from '../../lib/useClient';
import type {
  DiffContextMode,
  DiffRenderModel,
  DiffRow,
  DiffTarget,
  DiffViewMode,
  LspDiagnostic,
  LspStatus,
  ReviewAnchor,
  ReviewThread,
  SyntaxSide,
  SyntaxSpan,
} from '../../lib/protocol';
import { useRepoStore } from '../../stores/repo';
import { useReviewStore } from '../../stores/review';
import type { ReviewTextHighlight, SearchTextHighlight } from './HighlightedCode.vue';
import type { InlineReviewEntry } from './InlineReviewBox.vue';
import {
  buildDisplayRows as buildReviewDisplayRows,
  buildReviewEntriesByEndLine,
  commentStartKey,
  selectionChatEntries as buildSelectionChatEntries,
  type DisplayRow,
} from './reviewRows';
import DiffViewControls from './DiffViewControls.vue';
import DiffViewerOverlays from './DiffViewerOverlays.vue';
import type { DiffScrollMarker } from './DiffScrollbar.vue';
import { useReviewInteractions } from './useReviewInteractions';
import { buildDiffScrollMarkers } from './diffScrollMarkers';
import { useDiffScrollbar } from './useDiffScrollbar';
import { supportsLspFile, useLspHover } from './useLspHover';
import { useDiffSelection } from './useDiffSelection';
import { buildRenderedDiffRowFields } from './diffRenderedRows';
import SingleFileDiffPanes from './SingleFileDiffPanes.vue';
import type { DiffPaneActions, DiffPaneModel, DiffRenderedEntry, DiffReviewActions, DiffReviewUi } from './diffViewModels';

const props = defineProps<{
  model?: DiffRenderModel;
  loading: boolean;
  error?: string;
  viewMode: DiffViewMode;
  contextMode: DiffContextMode;
  target: DiffTarget;
  syncScroll: boolean;
  installingGrammar: boolean;
  grammarInstallStep?: string;
  hasNewChanges: boolean;
}>();

const emit = defineEmits<{
  'update:viewMode': [mode: DiffViewMode];
  'update:contextMode': [mode: DiffContextMode];
  'update:syncScroll': [enabled: boolean];
  installGrammar: [];
  loadLatest: [];
}>();

const rootRef = ref<HTMLElement | null>(null);
const syncedSplitRef = ref<HTMLElement | null>(null);
const leftRef = ref<HTMLElement | null>(null);
const rightRef = ref<HTMLElement | null>(null);
const inlineRef = ref<HTMLElement | null>(null);
const rows = computed(() => props.model?.rows ?? []);
const client = useClient();
const repo = useRepoStore();
const review = useReviewStore();
const draftBody = ref('');
const searchOpen = ref(false);
const searchQuery = ref('');
const activeSearchIndex = ref(0);
const collapsedCommentStarts = ref(new Set<string>());
const expandedResolvedCommentStarts = ref(new Set<string>());
const syntaxCache = new Map<string, SyntaxSpan[]>();
const syntaxPageStates = new Map<string, 'queued-high' | 'queued-low' | 'loading' | 'done'>();
const highPrioritySyntaxQueue: SyntaxPageRequest[] = [];
const lowPrioritySyntaxQueue: SyntaxPageRequest[] = [];
const syntaxVersion = ref(0);
const initialSyntaxGateActive = ref(false);
let activeSyntaxRequests = 0;
let isSyncingScroll = false;
let syncScrollFrame: number | undefined;
let pendingScrollSync: { target: HTMLElement; top: number; left: number } | undefined;
let syntaxPrefetchTimer: number | undefined;
let initialSyntaxGateTimer: number | undefined;
let initialSyntaxGeneration = 0;
let syntaxRequestGeneration = 0;
const syntaxPageSize = 256;
const syntaxPageLookaround = 2;
const virtualRowOverscan = 40;
const syntaxPrefetchDelayMs = 120;
const maxConcurrentSyntaxRequests = 2;
const initialSyntaxGateMs = 80;
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

type RenderedRow = DiffRenderedEntry;

type SearchMatch = {
  rowIndex: number;
  side: SyntaxSide;
  line: number;
  startColumn: number;
  endColumn: number;
};

const syntaxMessage = computed(() => {
  const syntax = props.model?.syntax;
  if (!syntax?.language) return undefined;
  if (syntax.grammarInstalled) {
    if (syntax.missingReason === 'highlights-query-not-installed') return `No ${syntax.language} highlights query installed`;
    return undefined;
  }

  return `No ${syntax.language} grammar installed`;
});

const activeFile = computed(() => repo.changedFiles.find((file) => file.id === props.model?.fileId));
const diffTargetFingerprint = () =>
  JSON.stringify({
    base: props.target.base,
    compare: props.target.compare,
    includeStaged: props.target.includeStaged,
    includeUnstaged: props.target.includeUnstaged,
    head: repo.repository?.head,
  });
const {
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
const fileThreads = computed(() => review.threads.filter((thread) => thread.fileId === props.model?.fileId));
const leftDisplayRows = computed(() => buildDisplayRows('old'));
const rightDisplayRows = computed(() => buildDisplayRows('new'));
const syncedSplitDisplayRows = computed(() => buildDisplayRows());
const inlineDisplayRows = computed(() => buildDisplayRows());
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
    if (props.viewMode === 'inline') {
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
    review.draftFile?.id === props.model?.fileId &&
    review.draftAnchor.startColumn !== undefined &&
    review.draftAnchor.endColumn !== undefined
  ) {
    anchors.get(review.draftAnchor.side)?.push(review.draftAnchor);
  }
  const pendingSelection = selectionDraft.value;
  if (
    pendingSelection &&
    pendingSelection.file.id === props.model?.fileId &&
    pendingSelection.anchor.startColumn !== undefined &&
    pendingSelection.anchor.endColumn !== undefined
  ) {
    anchors.get(pendingSelection.anchor.side)?.push(pendingSelection.anchor);
  }
  return anchors;
});
const lspStatusMessage = computed(() => {
  if (!props.model) return undefined;
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
  ready: Boolean(lspStatus.value?.installed && !lspStatus.value?.lastError),
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
  if (!props.model) return undefined;
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

const loadLspStatus = async () => {
  const model = props.model;
  const generation = ++lspStatusGeneration;
  if (!model || !supportsLspFile(model.fileId)) {
    lspStatus.value = undefined;
    lspStatusLoading.value = false;
    return;
  }

  lspStatusLoading.value = true;
  try {
    const status = await client.getLspStatus(model.fileId, lspStatusSide(), props.target);
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
  const model = props.model;
  const generation = ++lspDiagnosticsGeneration;
  lspDiagnostics.value = [];
  if (!model || !supportsLspFile(model.fileId)) {
    lspDiagnosticsLoading.value = false;
    return;
  }

  lspDiagnosticsLoading.value = true;
  try {
    const diagnostics = await client.getLspDiagnostics(model.fileId, 'new', props.target);
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
  return lspDiagnostics.value.filter((diagnostic) => diagnostic.line === line);
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
  return searchMatches.value
    .filter((match) => match.side === side && match.line === line)
    .map((match) => ({
      startColumn: match.startColumn,
      endColumn: match.endColumn,
      active: Boolean(active && sameSearchMatch(match, active)),
    }));
};

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
  const fileId = props.model?.fileId;
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

const buildRenderedRows = (virtualRows: VirtualRow[], displayRows: DisplayRow[]): RenderedRow[] => {
  syntaxVersion.value;
  return virtualRows.map((virtualRow) => {
    const item = displayRows[virtualRow.index];
    const fields = buildRenderedDiffRowFields(item, {
      fileId: props.model?.fileId,
      syntaxSpansForLine: (side, line) => syntaxCache.get(syntaxKey(side, line)),
      commentCountForLine: (side, line) => commentCountByStart.value.get(commentStartKey(side, line)) ?? 0,
      commentsExpandedForLine: commentsExpandedForStart,
      reviewHighlightsForLine,
      searchHighlightsForLine,
      diagnosticsForLine,
    });
    return {
      virtualRow,
      ...fields,
      reviewRow: item && item.kind !== 'diff' ? item : undefined,
    };
  });
};

const selectionChatEntries = computed<InlineReviewEntry[]>(() => {
  if (!props.model?.fileId) return [];
  return buildSelectionChatEntries(props.model.fileId, review.chatMessages);
});

const startLineComment = (payload: { side: 'old' | 'new'; line: number; text: string; clientX: number; clientY: number }) => {
  if (!props.model || !activeFile.value) return;
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

const reviewUi = computed<DiffReviewUi>(() => ({
  draftBody: draftBody.value,
  error: review.error,
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
};

const moveSearch = (direction: number) => {
  if (searchMatches.value.length === 0) return;
  const step = direction < 0 ? -1 : 1;
  activeSearchIndex.value = (activeSearchIndex.value + step + searchMatches.value.length) % searchMatches.value.length;
  scrollToActiveSearchMatch();
};

const onDocumentKeyDown = (event: KeyboardEvent) => {
  const target = event.target instanceof HTMLElement ? event.target : undefined;
  const isTextInput = Boolean(target?.closest('input, textarea, [contenteditable="true"]'));
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openSearch();
    return;
  }
  if (!isTextInput && event.key === '/') {
    event.preventDefault();
    openSearch();
    return;
  }
  if (!isTextInput && searchMatches.value.length > 0 && event.key === 'n') {
    event.preventDefault();
    moveSearch(1);
    return;
  }
  if (!isTextInput && searchMatches.value.length > 0 && event.key === 'N') {
    event.preventDefault();
    moveSearch(-1);
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
  cleanupLspHover();
  scrollbars.cleanup();
});

const {
  hover: lspHover,
  hoverStyle: lspHoverStyle,
  queue: queueLspHover,
  clear: clearLspHover,
  cleanup: cleanupLspHover,
} = useLspHover({
  client,
  target: () => props.target,
  diffTargetFingerprint,
  reviewElementForNode,
  textOffsetWithinElement,
  fileIdForElement: (element) => element.dataset.reviewFileId ?? props.model?.fileId,
  canQueue: () => Boolean(props.model && lspStatus.value?.running),
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
    kindForItem: (item) => (item.kind === 'diff' && (item.row.kind === 'added' || item.row.kind === 'deleted') ? item.row.kind : undefined),
    side,
  });
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
const leftRenderedRows = computed(() => buildRenderedRows(leftVirtualRows.value, leftDisplayRows.value));
const rightRenderedRows = computed(() => buildRenderedRows(rightVirtualRows.value, rightDisplayRows.value));
const syncedSplitRenderedRows = computed(() => buildRenderedRows(syncedSplitVirtualRows.value, syncedSplitDisplayRows.value));
const inlineRenderedRows = computed(() => buildRenderedRows(inlineVirtualRows.value, inlineDisplayRows.value));
const leftTotalSize = computed(() => leftVirtualizer.value.getTotalSize());
const rightTotalSize = computed(() => rightVirtualizer.value.getTotalSize());
const syncedSplitTotalSize = computed(() => syncedSplitVirtualizer.value.getTotalSize());
const inlineTotalSize = computed(() => inlineVirtualizer.value.getTotalSize());
const commentHoverDisabled = computed(() => {
  return (
    leftVirtualizer.value.isScrolling ||
    rightVirtualizer.value.isScrolling ||
    syncedSplitVirtualizer.value.isScrolling ||
    inlineVirtualizer.value.isScrolling
  );
});

watch(
  [leftTotalSize, rightTotalSize, syncedSplitTotalSize, inlineTotalSize, () => props.viewMode, () => props.syncScroll],
  scrollbars.updateAfterRender,
  { immediate: true, flush: 'post' },
);

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
  loading: props.loading,
  error: props.error,
  hasModel: Boolean(props.model),
  rowsLength: rows.value.length,
  initialSyntaxGateActive: initialSyntaxGateActive.value,
}));

const paneModels = computed<Record<PaneKey, DiffPaneModel>>(() => ({
  left: {
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
  },
  right: {
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
  },
  syncedSplit: {
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
  },
  inline: {
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
  },
}));

const scrollToActiveSearchMatch = () => {
  const match = activeSearchMatch.value;
  if (!match) return;
  if (props.viewMode === 'split' && props.syncScroll) {
    scrollVirtualizerToMatch(syncedSplitVirtualizer.value, syncedSplitDisplayRows.value, match);
  } else if (props.viewMode === 'split' && match.side === 'old') {
    scrollVirtualizerToMatch(leftVirtualizer.value, leftDisplayRows.value, match);
  } else if (props.viewMode === 'split') {
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
  const displayIndex = displayRows.findIndex((item) => item.kind === 'diff' && item.key === `diff:${match.rowIndex}`);
  if (displayIndex === -1) return;
  virtualizer.scrollToIndex(displayIndex, { align: 'center' });
};

const syntaxKey = (side: SyntaxSide, line: number) => `${side}:${line}`;

const syntaxPageKey = (fileId: string, context: DiffContextMode, side: SyntaxSide, page: number) => `${fileId}:${context}:${side}:${page}`;

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
          props.target,
        );
        const isCurrentRequest =
          request.generation === syntaxRequestGeneration &&
          props.model?.fileId === request.fileId &&
          props.model.context === request.context;
        if (isCurrentRequest) {
          for (const line of lines) syntaxCache.set(syntaxKey(request.side, line.line), line.spans);
          syntaxVersion.value += 1;
          syntaxPageStates.set(request.key, 'done');
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
  const model = props.model;
  if (!model?.syntax.grammarInstalled || page < 0) return false;

  const requestKey = syntaxPageKey(model.fileId, model.context, side, page);
  const existingState = syntaxPageStates.get(requestKey);
  if (existingState === 'done' || existingState === 'loading' || existingState === 'queued-high') return false;
  if (existingState === 'queued-low' && priority === 'low') return false;

  const fileId = model.fileId;
  const context = model.context;
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
    scheduleSyntaxPrefetch();
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
  if (!props.model?.syntax.grammarInstalled) return;
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
  if (!props.model?.syntax.grammarInstalled || rows.value.length === 0) {
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

const maxLineForSide = (side: SyntaxSide) => {
  let maxLine = 0;
  for (const row of rows.value) {
    const line = side === 'old' ? row.oldLine : row.newLine;
    if (line) maxLine = Math.max(maxLine, line);
  }
  return maxLine;
};

const prefetchSyntaxSide = (side: SyntaxSide) => {
  const maxLine = maxLineForSide(side);
  if (maxLine === 0) return;
  const lastPage = Math.floor((maxLine - 1) / syntaxPageSize);
  for (let page = 0; page <= lastPage; page += 1) requestSyntaxPage(side, page, 'low');
};

const prefetchAllSyntaxPages = () => {
  if (!props.model?.syntax.grammarInstalled) return;
  if (highPrioritySyntaxQueue.length > 0) {
    scheduleSyntaxPrefetch();
    return;
  }
  prefetchSyntaxSide('old');
  prefetchSyntaxSide('new');
};

const scheduleSyntaxPrefetch = () => {
  if (syntaxPrefetchTimer !== undefined) window.clearTimeout(syntaxPrefetchTimer);
  syntaxPrefetchTimer = window.setTimeout(() => {
    syntaxPrefetchTimer = undefined;
    prefetchAllSyntaxPages();
  }, syntaxPrefetchDelayMs);
};

const syncScrollPosition = (source: HTMLElement, target: HTMLElement | null) => {
  if (!props.syncScroll || !target) return;
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

const setPaneRef = (pane: PaneKey, element: Element | null) => {
  const htmlElement = element instanceof HTMLElement ? element : null;
  if (pane === 'left') leftRef.value = htmlElement;
  else if (pane === 'right') rightRef.value = htmlElement;
  else if (pane === 'syncedSplit') syncedSplitRef.value = htmlElement;
  else inlineRef.value = htmlElement;
};

const onPaneScroll = (pane: PaneKey, event: Event) => {
  if (pane === 'left') onLeftScroll(event);
  else if (pane === 'right') onRightScroll(event);
  else if (pane === 'syncedSplit') onSyncedSplitScroll();
  else onInlineScroll();
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
  pointerMove: queueLspHover,
  mouseLeave: clearLspHover,
  mouseUp: captureSelectionComment,
  scrollbarTrackPointerDown: onScrollbarTrackPointerDown,
  scrollbarThumbPointerDown: onScrollbarThumbPointerDown,
  comment: startLineComment,
  toggleComments,
};

watch(
  () => props.syncScroll,
  (enabled, wasEnabled) => {
    if (props.viewMode !== 'split' || enabled === wasEnabled) return;

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
  },
);

watch(
  () => `${props.model?.fileId ?? ''}:${props.model?.context ?? ''}`,
  () => {
    activeSearchIndex.value = 0;
    syntaxRequestGeneration += 1;
    syntaxCache.clear();
    syntaxPageStates.clear();
    highPrioritySyntaxQueue.length = 0;
    lowPrioritySyntaxQueue.length = 0;
    activeSyntaxRequests = 0;
    if (syntaxPrefetchTimer !== undefined) window.clearTimeout(syntaxPrefetchTimer);
    syntaxPrefetchTimer = undefined;
    if (initialSyntaxGateTimer !== undefined) window.clearTimeout(initialSyntaxGateTimer);
    initialSyntaxGateTimer = undefined;
    initialSyntaxGateActive.value = false;
    syntaxVersion.value += 1;
    startInitialSyntaxGate();
  },
);

watch([normalizedSearchQuery, () => props.model?.fileId, () => props.model?.context, () => props.viewMode, () => props.syncScroll], () => {
  activeSearchIndex.value = 0;
  if (searchMatches.value.length > 0) {
    void nextTick(() => scrollToActiveSearchMatch());
  }
});

watch(searchMatches, (matches) => {
  if (activeSearchIndex.value >= matches.length) activeSearchIndex.value = Math.max(0, matches.length - 1);
});

watch(
  [() => props.model, () => diffTargetFingerprint()],
  () => {
    void loadLspStatus();
    void loadLspDiagnostics();
  },
  { immediate: true },
);

watch(
  [
    leftVirtualRows,
    rightVirtualRows,
    syncedSplitVirtualRows,
    inlineVirtualRows,
    () => props.model?.syntax.grammarInstalled,
    () => props.viewMode,
    () => props.syncScroll,
  ],
  () => {
    if (props.viewMode === 'split' && props.syncScroll) {
      requestSyntaxForVirtualRows(syncedSplitVirtualRows.value, syncedSplitDisplayRows.value, 'old');
      requestSyntaxForVirtualRows(syncedSplitVirtualRows.value, syncedSplitDisplayRows.value, 'new');
    } else if (props.viewMode === 'split') {
      requestSyntaxForVirtualRows(leftVirtualRows.value, leftDisplayRows.value, 'old');
      requestSyntaxForVirtualRows(rightVirtualRows.value, rightDisplayRows.value, 'new');
    } else {
      requestSyntaxForVirtualRows(inlineVirtualRows.value, inlineDisplayRows.value, 'old');
      requestSyntaxForVirtualRows(inlineVirtualRows.value, inlineDisplayRows.value, 'new');
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
  height: 100%;
  background: var(--color-bg-app);
  overflow: hidden;
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
}

.syntax-status {
  color: var(--color-warning);
  background: var(--color-warning-muted);
  border-color: rgba(240, 184, 106, 0.25);
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
