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
    <div v-else ref="folderScrollRef" class="folder-diffs" @mouseup="captureSelectionComment">
      <div class="folder-spacer" :style="{ height: `${folderTotalSize}px` }">
        <div
          v-for="virtualRow in folderVirtualRows"
          :key="String(virtualRow.key)"
          class="virtual-row"
          :data-index="virtualRow.index"
          :ref="measureFolderElement"
          :style="{ transform: `translateY(${virtualRow.start}px)` }"
        >
          <template v-if="folderItem(virtualRow.index).kind === 'file'">
            <header class="file-header">
              <span>{{ folderModel(virtualRow.index).fileId }}</span>
              <span>{{ folderModel(virtualRow.index).rows.length }} rows</span>
            </header>
          </template>
          <div v-else-if="folderItem(virtualRow.index).kind === 'empty'" class="empty-file">No diff for this file.</div>
          <template v-else-if="folderItem(virtualRow.index).kind === 'row' && viewMode === 'split'">
            <SplitDiffRow
              v-if="folderDiffRow(virtualRow.index)"
              :row="folderDiffRow(virtualRow.index)!"
              :file-id="folderFileId(virtualRow.index)"
              :old-syntax-spans="syntaxForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'old')"
              :new-syntax-spans="syntaxForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'new')"
              :old-comment-count="commentCountForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'old')"
              :new-comment-count="commentCountForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'new')"
              :old-comments-expanded="commentsExpandedForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'old')"
              :new-comments-expanded="commentsExpandedForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'new')"
              :old-review-highlights="reviewHighlightsForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'old')"
              :new-review-highlights="reviewHighlightsForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'new')"
              :comment-hover-disabled="commentHoverDisabled"
              @comment="startLineComment(folderFileId(virtualRow.index), $event)"
              @toggle-comments="toggleComments"
            />
            <div v-else-if="folderReviewRow(virtualRow.index)" class="inline-review-row synced-split" :class="folderReviewRow(virtualRow.index)?.anchor.side">
              <div class="review-cell">
                <InlineReviewBox :entry="folderReviewRow(virtualRow.index)!" v-model:draft-body="draftBody" :error="review.error" @submit="submitComment" @cancel="cancelDraft" @reply="addReply" @collapse="collapseThread" @resolve="resolveThread" @reopen="reopenThread" />
              </div>
            </div>
          </template>
          <template v-else-if="folderItem(virtualRow.index).kind === 'row'">
            <InlineDiffRow
              v-if="folderDiffRow(virtualRow.index)"
              :row="folderDiffRow(virtualRow.index)!"
              :file-id="folderFileId(virtualRow.index)"
              :syntax-spans="syntaxForInlineRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!)"
              :old-comment-count="commentCountForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'old')"
              :new-comment-count="commentCountForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'new')"
              :old-comments-expanded="commentsExpandedForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'old')"
              :new-comments-expanded="commentsExpandedForRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!, 'new')"
              :review-highlights="reviewHighlightsForInlineRow(folderFileId(virtualRow.index), folderDiffRow(virtualRow.index)!)"
              :comment-hover-disabled="commentHoverDisabled"
              @comment="startLineComment(folderFileId(virtualRow.index), $event)"
              @toggle-comments="toggleComments"
            />
            <InlineReviewBox v-else-if="folderReviewRow(virtualRow.index)" :entry="folderReviewRow(virtualRow.index)!" v-model:draft-body="draftBody" :error="review.error" @submit="submitComment" @cancel="cancelDraft" @reply="addReply" @collapse="collapseThread" @resolve="resolveThread" @reopen="reopenThread" />
          </template>
        </div>
      </div>
      <div v-if="selectionDraft" class="selection-toolbar" :style="selectionBubbleStyle">
        <button type="button" title="Comment on selection" aria-label="Comment on selection" @pointerdown.prevent.stop="startSelectionComment">
          <span class="comment-icon" aria-hidden="true" />
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
let loadGeneration = 0;

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
    overscan: 18,
    useAnimationFrameWithResizeObserver: true,
  }))
);

const folderVirtualRows = computed(() => folderVirtualizer.value.getVirtualItems());
const folderTotalSize = computed(() => folderVirtualizer.value.getTotalSize());
const commentHoverDisabled = computed(() => folderVirtualizer.value.isScrolling);

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
  return item.item.row.kind === 'hunk' ? 28 : 24;
};

const folderItem = (index: number): FolderVirtualItem => folderVirtualItems.value[index] ?? { kind: 'empty', key: 'missing', fileId: '' };

const folderModel = (index: number): DiffRenderModel => folderItem(index).model ?? { fileId: '', mode: props.viewMode, context: props.contextMode, syntax: { grammarInstalled: false }, rows: [] };

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

  if (review.draftAnchor && review.draftFile?.id === fileId) {
    addEntry({ kind: 'draft', key: `draft:${review.draftAnchor.side}:${review.draftAnchor.startLine}:${review.draftAnchor.endLine}`, anchor: review.draftAnchor });
  }

  return entries;
};

const displayDiffRow = (item?: DisplayRow) => item?.kind === 'diff' ? item.row : undefined;

const displayReviewRow = (item?: DisplayRow): InlineReviewEntry | undefined => item && item.kind !== 'diff' ? item : undefined;

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

  return reviewHighlightAnchors(fileId, side)
    .map((anchor) => reviewHighlightForLine(anchor, line, text.length))
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
  review.startDraft(selectionDraft.value.file, selectionDraft.value.anchor);
  selectionDraft.value = undefined;
};

const submitComment = async () => {
  const saved = await review.createThread(draftBody.value);
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

onMounted(() => {
  document.addEventListener('selectionchange', clearSelectionDraftWhenSelectionEnds);
});

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', clearSelectionDraftWhenSelectionEnds);
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

.folder-diffs {
  position: relative;
  min-height: 0;
  overflow: auto;
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
