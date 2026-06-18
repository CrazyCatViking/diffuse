<template>
  <section class="folder-diff-viewer">
    <div class="folder-header">
      <div class="folder-meta">
        <span>{{ folderPath }}</span>
        <span class="file-count">{{ files.length }} file{{ files.length === 1 ? '' : 's' }}</span>
      </div>

      <div class="controls">
        <button class="control" :class="{ active: viewMode === 'split' }" type="button" @click="emit('update:viewMode', 'split')">Split</button>
        <button class="control" :class="{ active: viewMode === 'inline' }" type="button" @click="emit('update:viewMode', 'inline')">Inline</button>
        <button class="control" :class="{ active: contextMode === 'full' }" type="button" @click="emit('update:contextMode', contextMode === 'full' ? 'diff' : 'full')">
          {{ contextMode === 'full' ? 'Full file' : 'Diff only' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="message">Loading folder diff...</div>
    <div v-else-if="error" class="message error">{{ error }}</div>
    <div v-else-if="models.length === 0" class="message">No diffs in this folder.</div>
    <div v-else class="folder-diffs-shell" :class="{ 'has-diff-scroll': hasFolderScroll }">
      <div ref="folderScrollRef" class="folder-diffs" @scroll="onFolderScroll" @mouseup="captureSelectionComment">
        <div class="folder-spacer" :style="{ height: `${folderTotalSize}px` }">
          <div
            v-for="entry in folderRenderedRows"
            :key="String(entry.virtualRow.key)"
            class="virtual-row"
            :data-index="entry.virtualRow.index"
            :ref="entry.diffRow ? undefined : measureFolderElement"
            :style="{ transform: `translateY(${entry.virtualRow.start}px)` }"
          >
            <template v-if="entry.item.kind === 'file'">
              <header class="file-header">
                <span>{{ entry.model.fileId }}</span>
                <span>{{ entry.model.rows.length }} rows</span>
              </header>
            </template>
            <div v-else-if="entry.item.kind === 'empty'" class="empty-file">No diff for this file.</div>
            <template v-else-if="entry.item.kind === 'row' && viewMode === 'split'">
              <SplitDiffRow
                v-if="entry.diffRow"
                :row="entry.diffRow"
                :file-id="entry.fileId"
                :old-syntax-spans="entry.oldSyntaxSpans"
                :new-syntax-spans="entry.newSyntaxSpans"
                :old-comment-count="entry.oldCommentCount"
                :new-comment-count="entry.newCommentCount"
                :old-comments-expanded="entry.oldCommentsExpanded"
                :new-comments-expanded="entry.newCommentsExpanded"
                :old-review-highlights="entry.oldReviewHighlights"
                :new-review-highlights="entry.newReviewHighlights"
                :comment-hover-disabled="commentHoverDisabled"
                @comment="startLineComment(entry.fileId, $event)"
                @toggle-comments="toggleComments"
              />
              <div v-else-if="entry.reviewRow" class="inline-review-row synced-split" :class="entry.reviewRow.anchor.side">
                <div class="review-cell">
                  <InlineReviewBox :entry="entry.reviewRow" v-model:draft-body="draftBody" :chat-messages="chatMessagesForEntry(entry.reviewRow)" :agent-responding="agentRespondingForEntry(entry.reviewRow)" :error="review.error" @submit="submitComment" @submit-chat-draft="submitChatDraft" @cancel="cancelDraft" @reply="addReply" @chat="askAiInThread" @collapse="collapseThread" @resolve="resolveThread" @reopen="reopenThread" />
                </div>
              </div>
            </template>
            <template v-else-if="entry.item.kind === 'row'">
              <InlineDiffRow
                v-if="entry.diffRow"
                :row="entry.diffRow"
                :file-id="entry.fileId"
                :syntax-spans="entry.inlineSyntaxSpans"
                :old-comment-count="entry.oldCommentCount"
                :new-comment-count="entry.newCommentCount"
                :old-comments-expanded="entry.oldCommentsExpanded"
                :new-comments-expanded="entry.newCommentsExpanded"
                :review-highlights="entry.inlineReviewHighlights"
                :comment-hover-disabled="commentHoverDisabled"
                @comment="startLineComment(entry.fileId, $event)"
                @toggle-comments="toggleComments"
              />
              <InlineReviewBox v-else-if="entry.reviewRow" :entry="entry.reviewRow" v-model:draft-body="draftBody" :chat-messages="chatMessagesForEntry(entry.reviewRow)" :agent-responding="agentRespondingForEntry(entry.reviewRow)" :error="review.error" @submit="submitComment" @submit-chat-draft="submitChatDraft" @cancel="cancelDraft" @reply="addReply" @chat="askAiInThread" @collapse="collapseThread" @resolve="resolveThread" @reopen="reopenThread" />
            </template>
          </div>
        </div>
        <div v-if="selectionDraft" class="selection-toolbar" :style="selectionBubbleStyle">
          <button type="button" title="Comment on selection" aria-label="Comment on selection" @pointerdown.prevent.stop="startSelectionComment">
            <span class="comment-icon" aria-hidden="true" />
          </button>
          <button type="button" title="Ask AI about selection" aria-label="Ask AI about selection" @pointerdown.prevent.stop="startSelectionChat">
            <span class="ai-icon" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div v-if="hasFolderScroll" class="diff-scrollbar" @pointerdown="onScrollbarTrackPointerDown">
        <div
          v-for="marker in folderMarkers"
          :key="marker.key"
          class="diff-scroll-marker"
          :class="marker.kind"
          :style="marker.style"
        />
        <div class="diff-scroll-thumb" :style="folderThumbStyle" @pointerdown.stop="onScrollbarThumbPointerDown" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import type { ChangedFile, DiffContextMode, DiffRenderModel, DiffRow, DiffTarget, DiffViewMode, ReviewAnchor, ReviewThread, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import { useClient } from '../../lib/useClient';
import { useReviewStore } from '../../stores/review';
import InlineReviewBox, { type InlineReviewEntry } from './InlineReviewBox.vue';
import type { ReviewTextHighlight } from './HighlightedCode.vue';
import InlineDiffRow from './InlineDiffRow.vue';
import SplitDiffRow from './SplitDiffRow.vue';

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
const draftBody = ref('');
const collapsedCommentStarts = ref(new Set<string>());
const expandedResolvedCommentStarts = ref(new Set<string>());
const selectionBubblePosition = ref({ left: 18, top: 52 });
const selectionDraft = ref<{ file: ChangedFile; anchor: ReviewAnchor }>();
const nativeSelectionRange = ref<Range>();
const hasFolderScroll = ref(false);
const folderScrollMetrics = ref<ScrollMetrics>(emptyScrollMetrics());
let loadGeneration = 0;
let paneResizeObserver: ResizeObserver | undefined;
let observedFolderScroll: HTMLElement | undefined;
let scrollbarDrag: { startY: number; startScrollTop: number; trackHeight: number } | undefined;
let paneScrollStateFrame: number | undefined;

type DisplayRow = {
  kind: 'diff';
  key: string;
  row: DiffRow;
} | InlineReviewEntry;

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
  reviewRow?: InlineReviewEntry;
  oldSyntaxSpans?: SyntaxSpan[];
  newSyntaxSpans?: SyntaxSpan[];
  inlineSyntaxSpans?: SyntaxSpan[];
  oldCommentCount: number;
  newCommentCount: number;
  oldCommentsExpanded: boolean;
  newCommentsExpanded: boolean;
  oldReviewHighlights: ReviewTextHighlight[];
  newReviewHighlights: ReviewTextHighlight[];
  inlineReviewHighlights: ReviewTextHighlight[];
};

type DiffScrollMarker = {
  key: string;
  kind: 'added' | 'deleted';
  style: CSSProperties;
};

type DiffScrollMarkerRange = {
  kind: 'added' | 'deleted';
  top: number;
  bottom: number;
};

type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

function emptyScrollMetrics(): ScrollMetrics {
  return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
}

const folderScrollRef = ref<HTMLElement | null>(null);
const folderVirtualItems = computed<FolderVirtualItem[]>(() => {
  return models.value.flatMap((model) => {
    const items: FolderVirtualItem[] = [{ kind: 'file', key: `file:${model.fileId}`, model }];
    if (model.rows.length === 0) items.push({ kind: 'empty', key: `empty:${model.fileId}`, fileId: model.fileId });
    else items.push(...displayRowsForModel(model).map((item) => ({ kind: 'row' as const, key: `row:${model.fileId}:${item.key}`, fileId: model.fileId, item })));
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
  }))
);

const folderVirtualRows = computed(() => folderVirtualizer.value.getVirtualItems());
const folderRenderedRows = computed(() => buildFolderRenderedRows(folderVirtualRows.value));
const folderTotalSize = computed(() => folderVirtualizer.value.getTotalSize());
const commentHoverDisabled = computed(() => folderVirtualizer.value.isScrolling);
const folderMarkers = computed(() => scrollMarkersForItems(folderVirtualItems.value));
const folderThumbStyle = computed(() => scrollThumbStyle(folderScrollMetrics.value));
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
    if (thread.status === 'open' || expandedResolvedCommentStarts.value.has(startKey)) expanded.add(fileCommentStartKey(thread.fileId, thread.anchor.side, thread.anchor.startLine));
  }
  return expanded;
});
const reviewHighlightAnchorsByFileSide = computed(() => {
  const anchors = new Map<string, ReviewAnchor[]>();
  const addAnchor = (fileId: string, anchor: ReviewAnchor) => {
    if (anchor.startColumn === undefined || anchor.endColumn === undefined) return;
    const key = fileSideKey(fileId, anchor.side);
    anchors.set(key, [...anchors.get(key) ?? [], anchor]);
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
  const totalSize = items.reduce((sum, item) => sum + estimateFolderItemSize(item), 0);
  if (totalSize <= 0) return [];

  const markerRanges: DiffScrollMarkerRange[] = [];
  let offset = 0;
  items.forEach((item) => {
    const size = estimateFolderItemSize(item);
    const row = displayDiffRow(item.item);
    if (row?.kind === 'added' || row?.kind === 'deleted') {
      const top = offset / totalSize * 100;
      const bottom = Math.max((offset + size) / totalSize * 100, top + 0.45);
      markerRanges.push({ kind: row.kind, top, bottom });
    }
    offset += size;
  });

  return mergeMarkerRanges(markerRanges).map((marker, index) => ({
    key: `${marker.kind}:${index}`,
    kind: marker.kind,
    style: {
      top: `${marker.top}%`,
      height: `${marker.bottom - marker.top}%`,
    },
  }));
};

const mergeMarkerRanges = (ranges: DiffScrollMarkerRange[]) => {
  const merged: DiffScrollMarkerRange[] = [];
  const sorted = [...ranges].sort((first, second) => first.kind.localeCompare(second.kind) || first.top - second.top);
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous?.kind === range.kind && range.top <= previous.bottom + 0.15) {
      previous.bottom = Math.max(previous.bottom, range.bottom);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.sort((first, second) => first.top - second.top || first.kind.localeCompare(second.kind));
};

const scrollThumbStyle = (metrics: ScrollMetrics): CSSProperties => {
  if (metrics.scrollHeight <= metrics.clientHeight || metrics.clientHeight <= 0) return { display: 'none' };
  return {
    top: `${(metrics.scrollTop / metrics.scrollHeight) * 100}%`,
    height: `${Math.max((metrics.clientHeight / metrics.scrollHeight) * 100, 6)}%`,
  };
};

const updatePaneScrollState = () => {
  paneScrollStateFrame = undefined;
  const element = folderScrollRef.value;
  if (element && element !== observedFolderScroll) {
    if (observedFolderScroll) paneResizeObserver?.unobserve(observedFolderScroll);
    paneResizeObserver?.observe(element);
    observedFolderScroll = element;
  }
  hasFolderScroll.value = Boolean(element && element.scrollHeight > element.clientHeight + 1);
  folderScrollMetrics.value = {
    scrollTop: element?.scrollTop ?? 0,
    scrollHeight: element?.scrollHeight ?? 0,
    clientHeight: element?.clientHeight ?? 0,
  };
};

const schedulePaneScrollStateUpdate = () => {
  if (paneScrollStateFrame !== undefined) return;
  paneScrollStateFrame = requestAnimationFrame(updatePaneScrollState);
};

const updatePaneScrollStateAfterRender = () => {
  void nextTick(() => {
    requestAnimationFrame(updatePaneScrollState);
  });
};

const onFolderScroll = () => {
  schedulePaneScrollStateUpdate();
};

const onScrollbarTrackPointerDown = (event: PointerEvent) => {
  const element = folderScrollRef.value;
  const track = event.currentTarget as HTMLElement;
  if (!element || track.clientHeight <= 0) return;

  const thumbHeight = Math.max((element.clientHeight / element.scrollHeight) * track.clientHeight, 24);
  const trackTop = track.getBoundingClientRect().top;
  const targetTop = event.clientY - trackTop - thumbHeight / 2;
  element.scrollTop = Math.max(0, Math.min(targetTop / track.clientHeight * element.scrollHeight, element.scrollHeight - element.clientHeight));
  schedulePaneScrollStateUpdate();
};

const onScrollbarThumbPointerDown = (event: PointerEvent) => {
  const element = folderScrollRef.value;
  const track = (event.currentTarget as HTMLElement).parentElement;
  if (!element || !track || track.clientHeight <= 0) return;

  scrollbarDrag = { startY: event.clientY, startScrollTop: element.scrollTop, trackHeight: track.clientHeight };
  window.addEventListener('pointermove', onScrollbarThumbPointerMove);
  window.addEventListener('pointerup', stopScrollbarThumbDrag, { once: true });
};

const onScrollbarThumbPointerMove = (event: PointerEvent) => {
  if (!scrollbarDrag) return;
  const element = folderScrollRef.value;
  if (!element || scrollbarDrag.trackHeight <= 0) return;

  const deltaY = event.clientY - scrollbarDrag.startY;
  element.scrollTop = scrollbarDrag.startScrollTop + deltaY / scrollbarDrag.trackHeight * element.scrollHeight;
  schedulePaneScrollStateUpdate();
};

const stopScrollbarThumbDrag = () => {
  scrollbarDrag = undefined;
  window.removeEventListener('pointermove', onScrollbarThumbPointerMove);
};

const buildFolderRenderedRows = (virtualRows: VirtualRow[]): FolderRenderedRow[] => {
  return virtualRows.map((virtualRow) => {
    const item = folderVirtualItems.value[virtualRow.index] ?? { kind: 'empty', key: 'missing', fileId: '' };
    const model = item.model ?? models.value.find((candidate) => candidate.fileId === item.fileId) ?? emptyModel();
    const fileId = item.fileId ?? model.fileId;
    const diffRow = displayDiffRow(item.item);
    const reviewRow = displayReviewRow(item.item);
    const oldLine = diffRow?.oldLine;
    const newLine = diffRow?.newLine;
    const oldText = diffRow?.oldText ?? '';
    const newText = diffRow?.newText ?? '';
    const oldReviewHighlights = diffRow && oldLine && oldText.length > 0 ? reviewHighlightsForLine(fileId, 'old', oldLine, oldText.length) : [];
    const newReviewHighlights = diffRow && newLine && newText.length > 0 ? reviewHighlightsForLine(fileId, 'new', newLine, newText.length) : [];
    return {
      virtualRow,
      item,
      model,
      fileId,
      diffRow,
      reviewRow,
      oldSyntaxSpans: oldLine ? syntaxSpans.value[syntaxKey(fileId, 'old', oldLine)] : undefined,
      newSyntaxSpans: newLine ? syntaxSpans.value[syntaxKey(fileId, 'new', newLine)] : undefined,
      inlineSyntaxSpans: diffRow?.kind === 'deleted'
        ? oldLine ? syntaxSpans.value[syntaxKey(fileId, 'old', oldLine)] : undefined
        : newLine ? syntaxSpans.value[syntaxKey(fileId, 'new', newLine)] : undefined,
      oldCommentCount: oldLine ? threadCountsByStart.value.get(fileCommentStartKey(fileId, 'old', oldLine)) ?? 0 : 0,
      newCommentCount: newLine ? threadCountsByStart.value.get(fileCommentStartKey(fileId, 'new', newLine)) ?? 0 : 0,
      oldCommentsExpanded: Boolean(oldLine && expandedCommentStarts.value.has(fileCommentStartKey(fileId, 'old', oldLine))),
      newCommentsExpanded: Boolean(newLine && expandedCommentStarts.value.has(fileCommentStartKey(fileId, 'new', newLine))),
      oldReviewHighlights,
      newReviewHighlights,
      inlineReviewHighlights: diffRow?.kind === 'deleted' ? oldReviewHighlights : newReviewHighlights,
    };
  });
};

const emptyModel = (): DiffRenderModel => ({ fileId: '', mode: props.viewMode, context: props.contextMode, syntax: { grammarInstalled: false, highlightsInstalled: false }, rows: [] });

const fileSideKey = (fileId: string, side: SyntaxSide) => `${fileId}:${side}`;

const fileCommentStartKey = (fileId: string, side: SyntaxSide, line: number) => `${fileId}:${side}:${line}`;

const folderItem = (index: number): FolderVirtualItem => folderVirtualItems.value[index] ?? { kind: 'empty', key: 'missing', fileId: '' };

const folderModel = (index: number): DiffRenderModel => folderItem(index).model ?? emptyModel();

const folderFileId = (index: number): string => folderItem(index).fileId ?? '';

const folderDiffRow = (index: number) => displayDiffRow(folderItem(index).item);

const folderReviewRow = (index: number) => displayReviewRow(folderItem(index).item);

const selectionBubbleStyle = computed(() => ({
  left: `${selectionBubblePosition.value.left}px`,
  top: `${selectionBubblePosition.value.top}px`,
}));

const loadFolderDiff = async () => {
  const generation = ++loadGeneration;
  loading.value = true;
  error.value = undefined;
  models.value = [];
  syntaxSpans.value = {};

  try {
    const loaded: DiffRenderModel[] = [];
    for (const file of props.files) {
      const model = await client.getDiffRenderModel(file.id, { mode: props.viewMode, context: props.contextMode }, props.target);
      if (generation !== loadGeneration) return;
      loaded.push(model);
      models.value = [...loaded];
      void loadSyntaxForModel(model, generation);
    }
  } catch (err) {
    if (generation === loadGeneration) error.value = err instanceof Error ? err.message : JSON.stringify(err);
  } finally {
    if (generation === loadGeneration) loading.value = false;
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
  const result: DisplayRow[] = [];
  const reviewEntries = reviewEntriesByEndLine(model.fileId);
  model.rows.forEach((row, index) => {
    result.push({ kind: 'diff', key: `diff:${index}`, row });
    const oldEntries = row.oldLine ? reviewEntries.get(`old:${row.oldLine}`) ?? [] : [];
    const newEntries = row.newLine ? reviewEntries.get(`new:${row.newLine}`) ?? [] : [];
    result.push(...oldEntries, ...newEntries);
  });
  return result;
};

const reviewEntriesByEndLine = (fileId: string) => {
  const entries = new Map<string, InlineReviewEntry[]>();
  const addEntry = (entry: InlineReviewEntry) => {
    if (entry.kind === 'thread' && collapsedCommentStarts.value.has(commentStartKey(entry.anchor.side, entry.anchor.startLine))) return;
    const key = `${entry.anchor.side}:${entry.anchor.endLine}`;
    entries.set(key, [...entries.get(key) ?? [], entry]);
  };

  for (const thread of fileThreads(fileId)) {
    if (thread.status === 'resolved' && !expandedResolvedCommentStarts.value.has(commentStartKey(thread.anchor.side, thread.anchor.startLine))) continue;
    addEntry({ kind: 'thread', key: `thread:${thread.id}`, anchor: thread.anchor, thread });
  }

  for (const chat of selectionChatEntries(fileId)) addEntry(chat);

  if (review.draftAnchor && review.draftFile?.id === fileId) {
    addEntry({ kind: 'draft', key: `draft:${review.draftMode}:${review.draftAnchor.side}:${review.draftAnchor.startLine}:${review.draftAnchor.endLine}`, anchor: review.draftAnchor, mode: review.draftMode });
  }

  return entries;
};

const displayDiffRow = (item?: DisplayRow) => item?.kind === 'diff' ? item.row : undefined;

const displayReviewRow = (item?: DisplayRow): InlineReviewEntry | undefined => item && item.kind !== 'diff' ? item : undefined;

const chatMessagesForEntry = (entry: InlineReviewEntry) => {
  if (entry.kind === 'draft') return [];
  const threadId = entry.kind === 'thread' ? entry.thread.id : entry.chatThreadId;
  return review.chatMessages.filter((message) => message.context?.threadIds?.includes(threadId));
};

const agentRespondingForEntry = (entry: InlineReviewEntry) => {
  if (entry.kind === 'draft') return entry.mode === 'chat' && Boolean(review.draftFile && review.draftAnchor && review.pendingAgentChatKeys.has(selectionChatThreadId(review.draftFile.id, review.draftAnchor)));
  return review.pendingAgentChatKeys.has(entry.kind === 'thread' ? entry.thread.id : entry.chatThreadId);
};

const selectionChatEntries = (fileId: string): InlineReviewEntry[] => {
  const seen = new Set<string>();
  const result: InlineReviewEntry[] = [];
  for (const message of review.chatMessages) {
    const threadId = message.context?.threadIds?.[0];
    const anchor = message.context?.selection;
    if (!threadId?.startsWith('chat:') || !anchor || message.context?.fileId !== fileId || seen.has(threadId)) continue;
    seen.add(threadId);
    result.push({ kind: 'chat', key: threadId, anchor, chatThreadId: threadId });
  }
  return result;
};

const selectionChatThreadId = (fileId: string, anchor: ReviewAnchor) => `chat:${fileId}:${anchor.side}:${anchor.startLine}:${anchor.endLine}:${anchor.startColumn ?? ''}:${anchor.endColumn ?? ''}`;

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

const commentStartKey = (side: SyntaxSide, line: number) => `${side}:${line}`;

const reviewHighlightsForInlineRow = (fileId: string, row: DiffRow) => {
  const side = row.kind === 'deleted' ? 'old' : 'new';
  return reviewHighlightsForRow(fileId, row, side);
};

const reviewHighlightsForRow = (fileId: string, row: DiffRow, side: SyntaxSide): ReviewTextHighlight[] => {
  const line = side === 'old' ? row.oldLine : row.newLine;
  const text = side === 'old' ? row.oldText ?? '' : row.newText ?? '';
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
  const startColumn = line === anchor.startLine ? anchor.startColumn ?? 0 : 0;
  const endColumn = line === anchor.endLine ? anchor.endColumn ?? textLength : textLength;
  if (endColumn <= startColumn) return undefined;
  return { startColumn, endColumn };
};

const startLineComment = (fileId: string, payload: { side: 'old' | 'new'; line: number; text: string }) => {
  const file = props.files.find((item) => item.id === fileId);
  if (!file) return;
  selectionDraft.value = undefined;
  nativeSelectionRange.value = undefined;
  draftBody.value = '';
  review.startDraft(file, {
    side: payload.side,
    startLine: payload.line,
    endLine: payload.line,
    lineText: payload.text,
    diffTargetFingerprint: diffTargetFingerprint(),
  });
};

const captureSelectionComment = () => {
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim();
  if (!selection || !selectedText || selection.rangeCount === 0) {
    selectionDraft.value = undefined;
    return;
  }

  const range = selection.getRangeAt(0);
  nativeSelectionRange.value = range.cloneRange();
  const start = reviewElementForNode(range.startContainer);
  const end = reviewElementForNode(range.endContainer);
  if (!start || !end) {
    selectionDraft.value = undefined;
    return;
  }
  const side = start.dataset.reviewSide;
  const fileId = start.dataset.reviewFileId;
  if ((side !== 'old' && side !== 'new') || end.dataset.reviewSide !== side || end.dataset.reviewFileId !== fileId || !fileId) {
    selectionDraft.value = undefined;
    return;
  }
  const file = props.files.find((item) => item.id === fileId);
  if (!file) return;
  const startLine = Number(start.dataset.reviewLine);
  const endLine = Number(end.dataset.reviewLine);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    selectionDraft.value = undefined;
    return;
  }
  const startColumn = textOffsetWithinElement(start, range.startContainer, range.startOffset);
  const endColumn = textOffsetWithinElement(end, range.endContainer, range.endOffset);
  const normalizedStartLine = Math.min(startLine, endLine);
  const normalizedEndLine = Math.max(startLine, endLine);
  const normalizedStartColumn = startLine <= endLine ? startColumn : endColumn;
  const normalizedEndColumn = startLine <= endLine ? endColumn : startColumn;
  const rect = selectionTextRect(range);
  if (!rect) return;
  positionSelectionToolbar(rect.right, rect.top);
  selectionDraft.value = {
    file,
    anchor: {
      side,
      startLine: normalizedStartLine,
      endLine: normalizedEndLine,
      startColumn: normalizedStartLine === normalizedEndLine ? Math.min(normalizedStartColumn, normalizedEndColumn) : normalizedStartColumn,
      endColumn: normalizedStartLine === normalizedEndLine ? Math.max(normalizedStartColumn, normalizedEndColumn) : normalizedEndColumn,
      selectedText,
      lineText: start.dataset.reviewText,
      diffTargetFingerprint: diffTargetFingerprint(),
    },
  };
};

const reviewElementForNode = (node: Node) => {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentNode instanceof Element ? node.parentNode : null;
  return element?.closest<HTMLElement>('[data-review-side][data-review-line][data-review-file-id]');
};

const textOffsetWithinElement = (element: HTMLElement, node: Node, offset: number) => {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(node, offset);
  return range.toString().length;
};

const selectionTextRect = (range: Range) => {
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return undefined;
  return rects.sort((first, second) => first.top - second.top || second.right - first.right)[0];
};

const positionSelectionToolbar = (clientX: number, clientY: number) => {
  const container = document.querySelector<HTMLElement>('.folder-diffs');
  const rect = container?.getBoundingClientRect();
  if (!rect || !container) return;
  const toolbarWidth = 34;
  const toolbarHeight = 30;
  const gap = 6;
  selectionBubblePosition.value = {
    left: container.scrollLeft + Math.max(12, Math.min(clientX - rect.left + gap, rect.width - toolbarWidth - 12)),
    top: container.scrollTop + Math.max(48, Math.min(clientY - rect.top - toolbarHeight - gap, rect.height - toolbarHeight - 12)),
  };
};

const startSelectionComment = () => {
  if (!selectionDraft.value) return;
  draftBody.value = '';
  review.startDraft(selectionDraft.value.file, selectionDraft.value.anchor, 'comment');
  selectionDraft.value = undefined;
};

const startSelectionChat = () => {
  if (!selectionDraft.value) return;
  draftBody.value = '';
  review.startDraft(selectionDraft.value.file, selectionDraft.value.anchor, 'chat');
  selectionDraft.value = undefined;
};

const submitComment = async () => {
  const saved = await review.createThread(draftBody.value);
  if (!saved) return;
  draftBody.value = '';
  clearNativeSelection();
};

const submitChatDraft = async () => {
  const saved = await review.askAgentAtDraft(draftBody.value);
  if (!saved) return;
  draftBody.value = '';
  clearNativeSelection();
};

const cancelDraft = () => {
  draftBody.value = '';
  review.cancelDraft();
  clearNativeSelection();
};

const addReply = async (payload: { thread: ReviewThread; body: string }) => {
  await review.addMessage(payload.thread, payload.body);
  const next = new Set(collapsedCommentStarts.value);
  next.delete(commentStartKey(payload.thread.anchor.side, payload.thread.anchor.startLine));
  collapsedCommentStarts.value = next;
};

const askAiInThread = async (payload: { thread: ReviewThread; body: string }) => {
  await review.askAgentInThread(payload.thread, payload.body);
  const next = new Set(collapsedCommentStarts.value);
  next.delete(commentStartKey(payload.thread.anchor.side, payload.thread.anchor.startLine));
  collapsedCommentStarts.value = next;
};

const collapseThread = (anchor: ReviewAnchor) => {
  const next = new Set(collapsedCommentStarts.value);
  next.add(commentStartKey(anchor.side, anchor.startLine));
  collapsedCommentStarts.value = next;
  const expandedResolved = new Set(expandedResolvedCommentStarts.value);
  expandedResolved.delete(commentStartKey(anchor.side, anchor.startLine));
  expandedResolvedCommentStarts.value = expandedResolved;
};

const resolveThread = async (thread: ReviewThread) => {
  await review.resolveThread(thread);
  collapseThread(thread.anchor);
};

const reopenThread = async (thread: ReviewThread) => {
  await review.reopenThread(thread);
  const next = new Set(collapsedCommentStarts.value);
  next.delete(commentStartKey(thread.anchor.side, thread.anchor.startLine));
  collapsedCommentStarts.value = next;
};

const clearNativeSelection = () => {
  nativeSelectionRange.value = undefined;
  window.getSelection()?.removeAllRanges();
};

const clearSelectionDraftWhenSelectionEnds = () => {
  if (!selectionDraft.value) return;
  if (window.getSelection()?.toString().trim()) return;
  selectionDraft.value = undefined;
  nativeSelectionRange.value = undefined;
};

const diffTargetFingerprint = () => JSON.stringify({
  base: props.target.base,
  compare: props.target.compare,
  includeStaged: props.target.includeStaged,
  includeUnstaged: props.target.includeUnstaged,
});

watch(
  () => [props.folderPath, props.files.map((file) => file.id).join('\n'), props.contextMode, JSON.stringify(props.target)],
  () => {
    void loadFolderDiff();
  },
  { immediate: true }
);

watch(
  [folderTotalSize, () => props.viewMode, () => loading.value],
  updatePaneScrollStateAfterRender,
  { immediate: true, flush: 'post' }
);

onMounted(() => {
  document.addEventListener('selectionchange', clearSelectionDraftWhenSelectionEnds);
  paneResizeObserver = new ResizeObserver(updatePaneScrollState);
  updatePaneScrollStateAfterRender();
});

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', clearSelectionDraftWhenSelectionEnds);
  window.removeEventListener('pointermove', onScrollbarThumbPointerMove);
  window.removeEventListener('pointerup', stopScrollbarThumbDrag);
  if (paneScrollStateFrame !== undefined) cancelAnimationFrame(paneScrollStateFrame);
  paneResizeObserver?.disconnect();
});
</script>

<style scoped lang="scss">
.folder-diff-viewer {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  background: #111318;
}

.folder-header,
.file-header {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.folder-header {
  padding: 10px 14px;
  border-bottom: 1px solid #252a35;
  background: #151821;
}

.folder-meta {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
  color: #f5f7fb;
  font-weight: 650;
}

.file-count,
.file-header span:last-child {
  color: #7e8aa0;
  font-size: 12px;
  font-weight: 500;
}

.controls {
  display: flex;
  gap: 6px;
}

.control {
  color: #cbd5e1;
  background: #202635;
  border: 1px solid #2b3344;
  border-radius: 8px;
  padding: 5px 9px;
  cursor: pointer;

  &.active {
    color: #ffffff;
    background: #2d63d8;
    border-color: #2d63d8;
  }
}

.folder-diffs-shell {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;

  &.has-diff-scroll {
    grid-template-columns: minmax(0, 1fr) 18px;
  }
}

.folder-diffs {
  position: relative;
  grid-column: 1;
  grid-row: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;

  &::-webkit-scrollbar {
    width: 0;
    height: 14px;
  }

  &::-webkit-scrollbar-track {
    background: #151923;
  }

  &::-webkit-scrollbar-thumb {
    background: #4b5568;
    border: 4px solid #151923;
    border-radius: 999px;
  }
}

.diff-scrollbar {
  position: relative;
  grid-column: 2;
  grid-row: 1;
  z-index: 4;
  width: 18px;
  height: 100%;
  background: #151923;
  border-left: 1px solid #252a35;
  cursor: default;
  user-select: none;
}

.diff-scroll-marker {
  position: absolute;
  width: 50%;
  min-height: 2px;
  opacity: 0.95;

  &.added {
    right: 0;
    background: rgba(60, 179, 113, 0.16);
  }

  &.deleted {
    left: 0;
    background: rgba(255, 99, 99, 0.16);
  }
}

.diff-scroll-thumb {
  position: absolute;
  right: 0;
  left: 0;
  z-index: 1;
  min-height: 24px;
  background: rgba(152, 162, 179, 0.42);
  transition: background 120ms ease;
  will-change: top;

  &:hover {
    background: rgba(174, 183, 198, 0.58);
  }
}

.folder-spacer {
  position: relative;
  min-width: 1120px;
}

.virtual-row {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  contain: layout paint style;
  overflow: hidden;
}

.inline-review-row.synced-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-width: 1120px;
}

.inline-review-row.synced-split.old .review-cell {
  grid-column: 1;
}

.inline-review-row.synced-split.new .review-cell {
  grid-column: 2;
}

.selection-toolbar {
  position: absolute;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  background: rgba(19, 23, 32, 0.98);
  border: 1px solid #3a4356;
  border-radius: 7px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
}

.selection-toolbar button {
  position: relative;
  width: 24px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: 0;
  cursor: pointer;

  &:hover {
    background: rgba(240, 195, 106, 0.12);
    border-radius: 5px;
  }
}

.comment-icon {
  position: absolute;
  top: 5px;
  left: 5px;
  width: 11px;
  height: 8px;
  border: 2px solid #f0c36a;
  border-radius: 5px;

  &::after {
    position: absolute;
    right: -2px;
    bottom: -5px;
    width: 4px;
    height: 4px;
    border-right: 2px solid #f0c36a;
    border-bottom: 2px solid #f0c36a;
    content: "";
  }
}

.ai-icon {
  position: absolute;
  top: 4px;
  left: 5px;
  width: 12px;
  height: 12px;
  color: #8fb3ff;

  &::before,
  &::after {
    position: absolute;
    content: "";
    background: currentColor;
  }

  &::before {
    top: 0;
    left: 5px;
    width: 2px;
    height: 12px;
    border-radius: 999px;
    box-shadow: 0 0 8px rgba(143, 179, 255, 0.55);
  }

  &::after {
    top: 5px;
    left: 0;
    width: 12px;
    height: 2px;
    border-radius: 999px;
    transform: rotate(45deg);
  }
}

.file-diff {
  margin: 0 0 18px;
  border-bottom: 1px solid #252a35;
}

.file-header {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 9px 12px;
  color: #d8dee9;
  background: #171c27;
  border-top: 1px solid #252a35;
  border-bottom: 1px solid #252a35;
  font-size: 13px;
  font-weight: 650;
}

.message,
.empty-file {
  padding: 18px;
  color: #7e8aa0;
  font-size: 13px;
}

.error {
  color: #ff8d8d;
}
</style>
