<template>
  <section ref="rootRef" class="folder-diff-viewer">
    <div class="folder-header">
      <div class="folder-meta">
        <span class="folder-path">{{ folderPath }}</span>

        <span class="file-count">{{ files.length }} file{{ files.length === 1 ? '' : 's' }}</span>
      </div>

      <DiffViewControls
        :view-mode="viewMode"
        :context-mode="contextMode"
        @update:view-mode="emit('update:viewMode', $event)"
        @update:context-mode="emit('update:contextMode', $event)"
      />
    </div>

    <FolderDiffStream
      :loading="loading"
      :error="error"
      :models-length="models.length"
      :view-mode="viewMode"
      :folder-rendered-rows="folderRenderedRows"
      :folder-total-size="folderTotalSize"
      :has-folder-scroll="hasFolderScroll"
      :folder-markers="folderMarkers"
      :folder-thumb-style="folderThumbStyle"
      :comment-hover-disabled="commentHoverDisabled"
      :review="reviewUi"
      :review-actions="reviewActions"
      :show-selection-toolbar="Boolean(selectionDraft)"
      :selection-style="selectionBubbleStyle"
      :lsp-hover="lspHover"
      :lsp-hover-style="lspHoverStyle"
      :diagnostic-summary="diagnosticSummary"
      :measure-folder-element="measureFolderElement"
      @scroll-ref="setFolderScrollRef"
      @scroll="onFolderScroll"
      @pointer-move="queueLspHover"
      @mouse-leave="clearLspHover"
      @mouse-up="captureSelectionComment"
      @scrollbar-track-pointer-down="onScrollbarTrackPointerDown"
      @scrollbar-thumb-pointer-down="onScrollbarThumbPointerDown"
      @comment-selection="startSelectionComment"
      @chat-selection="startSelectionChat"
      @comment="startLineComment"
      @toggle-comments="toggleComments"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import type {
  ChangedFile,
  DiffContextMode,
  DiffRenderModel,
  DiffRow,
  DiffTarget,
  DiffViewMode,
  LspDiagnostic,
  ReviewAnchor,
  SyntaxSide,
  SyntaxSpan,
} from '../../lib/protocol';
import { useClient } from '../../lib/useClient';
import { useReviewStore } from '../../stores/review';
import type { InlineReviewEntry } from './InlineReviewBox.vue';
import type { ReviewTextHighlight } from './HighlightedCode.vue';
import type { DiffCodeRowModel, DiffReviewActions, DiffReviewUi } from './diffViewModels';
import {
  buildDisplayRows as buildReviewDisplayRows,
  buildReviewEntriesByEndLine,
  commentStartKey,
  displayDiffRow,
  displayReviewRow,
  selectionChatEntries as buildSelectionChatEntries,
  type DisplayRow,
} from './reviewRows';
import DiffViewControls from './DiffViewControls.vue';
import type { DiffScrollMarker } from './DiffScrollbar.vue';
import { useReviewInteractions } from './useReviewInteractions';
import { buildDiffScrollMarkers } from './diffScrollMarkers';
import { useDiffScrollbar } from './useDiffScrollbar';
import { supportsLspFile, useLspHover } from './useLspHover';
import { useDiffSelection } from './useDiffSelection';
import { buildRenderedDiffRowFields } from './diffRenderedRows';
import FolderDiffStream from './FolderDiffStream.vue';

const props = defineProps<{
  folderPath: string;
  files: ChangedFile[];
  target: DiffTarget;
  viewMode: DiffViewMode;
  contextMode: DiffContextMode;
}>();

const emit = defineEmits<{
  'update:viewMode': [mode: DiffViewMode];
  'update:contextMode': [mode: DiffContextMode];
}>();

const client = useClient();
const review = useReviewStore();
const models = ref<DiffRenderModel[]>([]);
const loading = ref(false);
const error = ref<string>();
const syntaxSpans = ref<Record<string, SyntaxSpan[]>>({});
const diagnosticsByFile = ref<Record<string, LspDiagnostic[]>>({});
const draftBody = ref('');
const collapsedCommentStarts = ref(new Set<string>());
const expandedResolvedCommentStarts = ref(new Set<string>());
let loadGeneration = 0;

type FolderVirtualItem = {
  kind: 'file' | 'empty' | 'row';
  key: string;
  model?: DiffRenderModel;
  fileId?: string;
  item?: DisplayRow;
};

type VirtualRow = {
  index: number;
  key: unknown;
  start: number;
};

type FolderRenderedRow = {
  virtualRow: VirtualRow;
  item: FolderVirtualItem;
  model: DiffRenderModel;
  fileId: string;
  diffRow?: DiffRow;
  diff?: DiffCodeRowModel;
  reviewRow?: InlineReviewEntry;
};

const rootRef = ref<HTMLElement | null>(null);
const folderScrollRef = ref<HTMLElement | null>(null);
const scrollbars = useDiffScrollbar({ folder: folderScrollRef });
const hasFolderScroll = scrollbars.panes.folder.hasScroll;
const folderThumbStyle = scrollbars.panes.folder.thumbStyle;
const diffTargetFingerprint = () =>
  JSON.stringify({
    base: props.target.base,
    compare: props.target.compare,
    includeStaged: props.target.includeStaged,
    includeUnstaged: props.target.includeUnstaged,
  });
const {
  selectionDraft,
  selectionBubbleStyle,
  captureSelectionComment,
  reviewElementForNode,
  textOffsetWithinElement,
  clearNativeSelection,
  clearSelectionDraftWhenSelectionEnds,
} = useDiffSelection({
  rootRef,
  scrollContainerRef: folderScrollRef,
  selector: '[data-review-side][data-review-line][data-review-file-id]',
  fileForElement: (element) => props.files.find((item) => item.id === element.dataset.reviewFileId),
  diffTargetFingerprint,
  requireSameFile: true,
});
const folderVirtualItems = computed<FolderVirtualItem[]>(() => {
  return models.value.flatMap((model) => {
    const items: FolderVirtualItem[] = [{ kind: 'file', key: `file:${model.fileId}`, model }];
    if (model.rows.length === 0) items.push({ kind: 'empty', key: `empty:${model.fileId}`, fileId: model.fileId });
    else
      items.push(
        ...displayRowsForModel(model).map((item) => ({
          kind: 'row' as const,
          key: `row:${model.fileId}:${item.key}`,
          fileId: model.fileId,
          item,
        })),
      );
    return items;
  });
});

const folderVirtualizer = useVirtualizer(
  computed(() => ({
    count: folderVirtualItems.value.length,
    getScrollElement: () => folderScrollRef.value,
    getItemKey: (index) => folderVirtualItems.value[index]?.key ?? index,
    estimateSize: (index: number) => estimateFolderItemSize(folderVirtualItems.value[index]),
    overscan: 40,
    useAnimationFrameWithResizeObserver: true,
  })),
);

const folderVirtualRows = computed(() => folderVirtualizer.value.getVirtualItems());
const folderRenderedRows = computed(() => buildFolderRenderedRows(folderVirtualRows.value));
const folderTotalSize = computed(() => folderVirtualizer.value.getTotalSize());
const commentHoverDisabled = computed(() => folderVirtualizer.value.isScrolling);
const folderMarkers = computed(() => scrollMarkersForItems(folderVirtualItems.value));
const threadCountsByStart = computed(() => {
  const counts = new Map<string, number>();
  for (const thread of review.threads) {
    const key = fileCommentStartKey(thread.fileId, thread.anchor.side, thread.anchor.startLine);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
});
const expandedCommentStarts = computed(() => {
  const expanded = new Set<string>();
  for (const thread of review.threads) {
    const startKey = commentStartKey(thread.anchor.side, thread.anchor.startLine);
    if (collapsedCommentStarts.value.has(startKey)) continue;
    if (thread.status === 'open' || expandedResolvedCommentStarts.value.has(startKey))
      expanded.add(fileCommentStartKey(thread.fileId, thread.anchor.side, thread.anchor.startLine));
  }
  return expanded;
});
const reviewHighlightAnchorsByFileSide = computed(() => {
  const anchors = new Map<string, ReviewAnchor[]>();
  const addAnchor = (fileId: string, anchor: ReviewAnchor) => {
    if (anchor.startColumn === undefined || anchor.endColumn === undefined) return;
    const key = fileSideKey(fileId, anchor.side);
    anchors.set(key, [...(anchors.get(key) ?? []), anchor]);
  };
  for (const thread of review.threads) {
    if (!expandedCommentStarts.value.has(fileCommentStartKey(thread.fileId, thread.anchor.side, thread.anchor.startLine))) continue;
    addAnchor(thread.fileId, thread.anchor);
  }
  if (review.draftAnchor && review.draftFile) addAnchor(review.draftFile.id, review.draftAnchor);
  const pendingSelection = selectionDraft.value;
  if (pendingSelection) addAnchor(pendingSelection.file.id, pendingSelection.anchor);
  return anchors;
});

const measureFolderElement = (element: unknown) => {
  folderVirtualizer.value.measureElement(element instanceof Element ? element : null);
};

const estimateFolderItemSize = (item?: FolderVirtualItem) => {
  if (!item) return 24;
  if (item.kind === 'file') return 36;
  if (item.kind === 'empty') return 50;
  if (!item.item) return 24;
  if (item.item.kind === 'draft') return 220;
  if (item.item.kind === 'thread') return 150;
  if (item.item.kind === 'chat') return 150;
  return item.item.row.kind === 'hunk' ? 28 : 24;
};

const scrollMarkersForItems = (items: FolderVirtualItem[]): DiffScrollMarker[] => {
  return buildDiffScrollMarkers(items, {
    estimateSize: estimateFolderItemSize,
    kindForItem: (item) => {
      const row = displayDiffRow(item.item);
      return row?.kind === 'added' || row?.kind === 'deleted' ? row.kind : undefined;
    },
  });
};

const onFolderScroll = () => {
  scrollbars.schedule();
};

const onScrollbarTrackPointerDown = (event: PointerEvent) => {
  scrollbars.onTrackPointerDown(event, 'folder');
};

const onScrollbarThumbPointerDown = (event: PointerEvent) => {
  scrollbars.onThumbPointerDown(event, 'folder');
};

const setFolderScrollRef = (element: Element | null) => {
  folderScrollRef.value = element instanceof HTMLElement ? element : null;
};

const buildFolderRenderedRows = (virtualRows: VirtualRow[]): FolderRenderedRow[] => {
  return virtualRows.map((virtualRow) => {
    const item = folderVirtualItems.value[virtualRow.index] ?? { kind: 'empty', key: 'missing', fileId: '' };
    const model = item.model ?? models.value.find((candidate) => candidate.fileId === item.fileId) ?? emptyModel();
    const fileId = item.fileId ?? model.fileId;
    const fields = buildRenderedDiffRowFields(item.item, {
      fileId,
      syntaxSpansForLine: (side, line) => syntaxSpans.value[syntaxKey(fileId, side, line)],
      commentCountForLine: (side, line) => threadCountsByStart.value.get(fileCommentStartKey(fileId, side, line)) ?? 0,
      commentsExpandedForLine: (side, line) => expandedCommentStarts.value.has(fileCommentStartKey(fileId, side, line)),
      reviewHighlightsForLine: (side, line, textLength) => reviewHighlightsForLine(fileId, side, line, textLength),
      diagnosticsForLine: (_side, line) => diagnosticsForLine(fileId, line),
    });
    const reviewRow = displayReviewRow(item.item);
    return {
      ...fields,
      virtualRow,
      item,
      model,
      fileId,
      reviewRow,
    };
  });
};

const diagnosticsForLine = (fileId: string, line?: number): LspDiagnostic[] => {
  if (!line) return [];
  return (diagnosticsByFile.value[fileId] ?? []).filter((diagnostic) => diagnostic.line === line);
};

const diagnosticSummary = (fileId: string) => {
  const diagnostics = diagnosticsByFile.value[fileId] ?? [];
  if (diagnostics.length === 0) return undefined;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const other = diagnostics.length - errors - warnings;
  const parts = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  if (other > 0) parts.push(`${other} info`);
  return {
    label: parts.join(', '),
    className: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'info',
  };
};

const emptyModel = (): DiffRenderModel => ({
  fileId: '',
  mode: props.viewMode,
  context: props.contextMode,
  syntax: { grammarInstalled: false, highlightsInstalled: false },
  rows: [],
});

const fileSideKey = (fileId: string, side: SyntaxSide) => `${fileId}:${side}`;

const fileCommentStartKey = (fileId: string, side: SyntaxSide, line: number) => `${fileId}:${side}:${line}`;

const folderItem = (index: number): FolderVirtualItem => folderVirtualItems.value[index] ?? { kind: 'empty', key: 'missing', fileId: '' };

const folderModel = (index: number): DiffRenderModel => folderItem(index).model ?? emptyModel();

const folderFileId = (index: number): string => folderItem(index).fileId ?? '';

const folderDiffRow = (index: number) => displayDiffRow(folderItem(index).item);

const folderReviewRow = (index: number) => displayReviewRow(folderItem(index).item);

const loadFolderDiff = async () => {
  const generation = ++loadGeneration;
  loading.value = true;
  error.value = undefined;
  models.value = [];
  syntaxSpans.value = {};
  diagnosticsByFile.value = {};

  try {
    const loaded: DiffRenderModel[] = [];
    for (const file of props.files) {
      const model = await client.getDiffRenderModel(file.id, { mode: props.viewMode, context: props.contextMode }, props.target);
      if (generation !== loadGeneration) return;
      loaded.push(model);
      models.value = [...loaded];
      void loadSyntaxForModel(model, generation);
      void loadDiagnosticsForModel(model, generation);
    }
  } catch (err) {
    if (generation === loadGeneration) error.value = err instanceof Error ? err.message : JSON.stringify(err);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
};

const loadDiagnosticsForModel = async (model: DiffRenderModel, generation: number) => {
  if (!supportsLspFile(model.fileId)) return;

  try {
    const diagnostics = await client.getLspDiagnostics(model.fileId, 'new', props.target);
    if (generation !== loadGeneration) return;

    diagnosticsByFile.value = {
      ...diagnosticsByFile.value,
      [model.fileId]: diagnostics.status === 'ok' ? diagnostics.diagnostics : [],
    };
  } catch {
    if (generation !== loadGeneration) return;
    diagnosticsByFile.value = {
      ...diagnosticsByFile.value,
      [model.fileId]: [],
    };
  }
};

const loadSyntaxForModel = async (model: DiffRenderModel, generation: number) => {
  if (!model.syntax.grammarInstalled) return;

  await Promise.all([
    loadSyntaxSide(model, 'old', maxLineForSide(model.rows, 'old'), generation),
    loadSyntaxSide(model, 'new', maxLineForSide(model.rows, 'new'), generation),
  ]);
};

const loadSyntaxSide = async (model: DiffRenderModel, side: SyntaxSide, maxLine: number, generation: number) => {
  if (maxLine === 0) return;

  try {
    const lines = await client.getSyntaxSpans(model.fileId, side, 1, maxLine, { context: props.contextMode }, props.target);
    if (generation !== loadGeneration) return;

    const next = { ...syntaxSpans.value };
    for (const line of lines) next[syntaxKey(model.fileId, side, line.line)] = line.spans;
    syntaxSpans.value = next;
  } catch {
    // Keep the folder diff usable even if syntax loading fails for a file.
  }
};

const maxLineForSide = (rows: DiffRow[], side: SyntaxSide) => {
  let maxLine = 0;
  for (const row of rows) {
    const line = side === 'old' ? row.oldLine : row.newLine;
    if (line) maxLine = Math.max(maxLine, line);
  }
  return maxLine;
};

const syntaxForRow = (fileId: string, row: DiffRow, side: SyntaxSide) => {
  const line = side === 'old' ? row.oldLine : row.newLine;
  return line ? syntaxSpans.value[syntaxKey(fileId, side, line)] : undefined;
};

const syntaxForInlineRow = (fileId: string, row: DiffRow) => {
  return syntaxForRow(fileId, row, row.kind === 'deleted' ? 'old' : 'new');
};

const syntaxKey = (fileId: string, side: SyntaxSide, line: number) => `${fileId}:${side}:${line}`;

const displayRowsForModel = (model: DiffRenderModel): DisplayRow[] => {
  return buildReviewDisplayRows(
    model.rows,
    buildReviewEntriesByEndLine({
      fileId: model.fileId,
      threads: fileThreads(model.fileId),
      chatMessages: review.chatMessages,
      collapsedCommentStarts: collapsedCommentStarts.value,
      resolvedCommentStarts: expandedResolvedCommentStarts.value,
      draft:
        review.draftAnchor && review.draftFile
          ? { fileId: review.draftFile.id, anchor: review.draftAnchor, mode: review.draftMode }
          : undefined,
    }),
  );
};

const selectionChatEntries = (fileId: string): InlineReviewEntry[] => buildSelectionChatEntries(fileId, review.chatMessages);

const fileThreads = (fileId: string) => review.threads.filter((thread) => thread.fileId === fileId);

const commentCountForRow = (fileId: string, row: DiffRow, side: SyntaxSide) => {
  const line = side === 'old' ? row.oldLine : row.newLine;
  if (!line) return 0;
  return fileThreads(fileId).filter((thread) => thread.anchor.side === side && thread.anchor.startLine === line).length;
};

const commentsExpandedForRow = (fileId: string, row: DiffRow, side: SyntaxSide) => {
  const line = side === 'old' ? row.oldLine : row.newLine;
  return Boolean(line && commentsExpandedForStart(fileId, side, line));
};

const commentsExpandedForStart = (fileId: string, side: SyntaxSide, line: number) => {
  const key = commentStartKey(side, line);
  if (collapsedCommentStarts.value.has(key)) return false;
  return fileThreads(fileId).some((thread) => {
    if (thread.anchor.side !== side || thread.anchor.startLine !== line) return false;
    return thread.status === 'open' || expandedResolvedCommentStarts.value.has(key);
  });
};

const toggleComments = (payload: { side: 'old' | 'new'; line: number }) => {
  const key = commentStartKey(payload.side, payload.line);
  const collapsed = new Set(collapsedCommentStarts.value);
  const expandedResolved = new Set(expandedResolvedCommentStarts.value);
  if (collapsed.has(key)) {
    collapsed.delete(key);
    expandedResolved.add(key);
  } else {
    collapsed.add(key);
    expandedResolved.delete(key);
  }
  collapsedCommentStarts.value = collapsed;
  expandedResolvedCommentStarts.value = expandedResolved;
};

const reviewHighlightsForInlineRow = (fileId: string, row: DiffRow) => {
  const side = row.kind === 'deleted' ? 'old' : 'new';
  return reviewHighlightsForRow(fileId, row, side);
};

const reviewHighlightsForRow = (fileId: string, row: DiffRow, side: SyntaxSide): ReviewTextHighlight[] => {
  const line = side === 'old' ? row.oldLine : row.newLine;
  const text = side === 'old' ? (row.oldText ?? '') : (row.newText ?? '');
  if (!line || text.length === 0) return [];

  return reviewHighlightsForLine(fileId, side, line, text.length);
};

const reviewHighlightsForLine = (fileId: string, side: SyntaxSide, line: number, textLength: number): ReviewTextHighlight[] => {
  return (reviewHighlightAnchorsByFileSide.value.get(fileSideKey(fileId, side)) ?? [])
    .map((anchor) => reviewHighlightForLine(anchor, line, textLength))
    .filter((highlight): highlight is ReviewTextHighlight => Boolean(highlight));
};

const reviewHighlightAnchors = (fileId: string, side: SyntaxSide) => {
  const anchors = fileThreads(fileId)
    .filter((thread) => commentsExpandedForStart(fileId, thread.anchor.side, thread.anchor.startLine))
    .map((thread) => thread.anchor);
  if (review.draftAnchor && review.draftFile?.id === fileId) anchors.push(review.draftAnchor);
  const pendingSelection = selectionDraft.value;
  if (pendingSelection && pendingSelection.file.id === fileId) anchors.push(pendingSelection.anchor);
  return anchors.filter((anchor) => anchor.side === side && anchor.startColumn !== undefined && anchor.endColumn !== undefined);
};

const reviewHighlightForLine = (anchor: ReviewAnchor, line: number, textLength: number): ReviewTextHighlight | undefined => {
  if (line < anchor.startLine || line > anchor.endLine) return undefined;
  const startColumn = line === anchor.startLine ? (anchor.startColumn ?? 0) : 0;
  const endColumn = line === anchor.endLine ? (anchor.endColumn ?? textLength) : textLength;
  if (endColumn <= startColumn) return undefined;
  return { startColumn, endColumn };
};

const startLineComment = (fileId: string, payload: { side: 'old' | 'new'; line: number; text: string }) => {
  const file = props.files.find((item) => item.id === fileId);
  if (!file) return;
  selectionDraft.value = undefined;
  draftBody.value = '';
  review.startDraft(file, {
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
  fileIdForElement: (element) => element.dataset.reviewFileId,
});

watch(
  () => [props.folderPath, props.files.map((file) => file.id).join('\n'), props.contextMode, JSON.stringify(props.target)],
  () => {
    void loadFolderDiff();
  },
  { immediate: true },
);

watch([folderTotalSize, () => props.viewMode, () => loading.value], scrollbars.updateAfterRender, { immediate: true, flush: 'post' });

onMounted(() => {
  document.addEventListener('selectionchange', clearSelectionDraftWhenSelectionEnds);
  scrollbars.startObserving([folderScrollRef.value]);
});

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', clearSelectionDraftWhenSelectionEnds);
  cleanupLspHover();
  scrollbars.cleanup();
});
</script>

<style scoped lang="scss">
.folder-diff-viewer {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  background: var(--color-bg-app);
}

.folder-header {
  display: flex;
  gap: var(--space-6);
  align-items: center;
  justify-content: space-between;
  padding: var(--space-5) var(--space-6);
  background: var(--color-bg-shell);
  border-bottom: 1px solid var(--color-border-subtle);
}

.folder-meta {
  display: flex;
  gap: var(--space-5);
  align-items: center;
  min-width: 0;
  color: var(--color-text-primary);
  font-weight: 650;
}

.folder-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-count {
  flex: 0 0 auto;
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
  font-weight: 500;
}
</style>
