<template>
  <section ref="rootRef" class="diff-viewer">
    <div class="diff-header">
      <div class="file-meta">
        <span>{{ model?.fileId ?? 'No file selected' }}</span>
        <span v-if="model" class="row-count">{{ rows.length }} rows</span>
        <span v-if="hasNewChanges" class="update-status">
          New changes available
          <button class="load-latest" type="button" :disabled="loading" @click="emit('loadLatest')">
            Load latest
          </button>
        </span>
        <span v-if="syntaxMessage" class="syntax-status">
          {{ syntaxMessage }}
          <button class="install-grammar" type="button" :disabled="installingGrammar" @click="emit('installGrammar')">
            {{ installingGrammar ? 'Installing...' : 'Install' }}
          </button>
          <span v-if="grammarInstallStep" class="install-step">{{ grammarInstallStep }}</span>
        </span>
      </div>
      <div class="controls">
        <button
          class="control"
          :class="{ active: viewMode === 'split' }"
          type="button"
          @click="emit('update:viewMode', 'split')"
        >
          Split
        </button>
        <button
          class="control"
          :class="{ active: viewMode === 'inline' }"
          type="button"
          @click="emit('update:viewMode', 'inline')"
        >
          Inline
        </button>
        <button
          v-if="viewMode === 'split'"
          class="control"
          :class="{ active: syncScroll }"
          type="button"
          @click="emit('update:syncScroll', !syncScroll)"
        >
          {{ syncScroll ? 'Synced' : 'Desynced' }}
        </button>
        <button
          class="control"
          :class="{ active: contextMode === 'full' }"
          type="button"
          @click="emit('update:contextMode', contextMode === 'full' ? 'diff' : 'full')"
        >
          {{ contextMode === 'full' ? 'Full file' : 'Diff only' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="message">Loading diff...</div>
    <div v-else-if="error" class="message error">{{ error }}</div>
    <div v-else-if="!model" class="message">Select a changed file to view its diff.</div>
    <div v-else-if="rows.length === 0" class="message">No unstaged diff for this file.</div>
    <div v-else-if="initialSyntaxGateActive" class="syntax-gate" />
    <div v-else-if="viewMode === 'split' && syncScroll" class="pane-shell" :class="{ 'has-diff-scroll': hasSyncedSplitScroll }">
      <div ref="syncedSplitRef" class="pane synced-split-view" @scroll="onSyncedSplitScroll" @mouseup="captureSelectionComment">
        <div class="spacer synced-split-spacer" :style="{ height: `${syncedSplitTotalSize}px` }">
          <div
            v-for="virtualRow in syncedSplitVirtualRows"
            :key="String(virtualRow.key)"
            class="virtual-row"
            :data-index="virtualRow.index"
            :ref="measureSyncedSplitElement"
            :style="{ transform: `translateY(${virtualRow.start}px)` }"
          >
            <template v-if="displayDiffRow(syncedSplitDisplayRows[virtualRow.index])">
              <SplitDiffRow
                :row="displayDiffRow(syncedSplitDisplayRows[virtualRow.index])!"
                :old-syntax-spans="syntaxForRow(displayDiffRow(syncedSplitDisplayRows[virtualRow.index])!, 'old')"
                :new-syntax-spans="syntaxForRow(displayDiffRow(syncedSplitDisplayRows[virtualRow.index])!, 'new')"
                :old-comment-count="commentCountForRow(displayDiffRow(syncedSplitDisplayRows[virtualRow.index])!, 'old')"
                :new-comment-count="commentCountForRow(displayDiffRow(syncedSplitDisplayRows[virtualRow.index])!, 'new')"
                :old-comments-expanded="commentsExpandedForRow(displayDiffRow(syncedSplitDisplayRows[virtualRow.index])!, 'old')"
                :new-comments-expanded="commentsExpandedForRow(displayDiffRow(syncedSplitDisplayRows[virtualRow.index])!, 'new')"
                :old-review-highlights="reviewHighlightsForRow(displayDiffRow(syncedSplitDisplayRows[virtualRow.index])!, 'old')"
                :new-review-highlights="reviewHighlightsForRow(displayDiffRow(syncedSplitDisplayRows[virtualRow.index])!, 'new')"
                :comment-hover-disabled="commentHoverDisabled"
                @comment="startLineComment"
                @toggle-comments="toggleComments"
              />
            </template>
            <div v-else class="inline-review-row synced-split" :class="displayReviewRow(syncedSplitDisplayRows[virtualRow.index])?.anchor.side">
              <div class="review-cell">
                <InlineReviewBox v-if="displayReviewRow(syncedSplitDisplayRows[virtualRow.index])" :entry="displayReviewRow(syncedSplitDisplayRows[virtualRow.index])!" v-model:draft-body="draftBody" :error="review.error" @submit="submitComment" @cancel="cancelDraft" @reply="addReply" @collapse="collapseThread" @resolve="resolveThread" @reopen="reopenThread" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-if="hasSyncedSplitScroll" class="diff-scrollbar" @pointerdown="onScrollbarTrackPointerDown($event, 'syncedSplit')">
        <div
          v-for="marker in syncedSplitMarkers"
          :key="marker.key"
          class="diff-scroll-marker"
          :class="marker.kind"
          :style="marker.style"
        />
        <div class="diff-scroll-thumb" :style="syncedSplitThumbStyle" @pointerdown.stop="onScrollbarThumbPointerDown($event, 'syncedSplit')" />
      </div>
    </div>
    <div v-else-if="viewMode === 'split'" class="split-view">
      <div class="pane-shell old-pane-shell" :class="{ 'has-diff-scroll': hasLeftScroll }">
        <div ref="leftRef" class="pane old-pane" @scroll="onLeftScroll" @mouseup="captureSelectionComment">
          <div class="spacer" :style="{ height: `${leftTotalSize}px` }">
            <div
              v-for="virtualRow in leftVirtualRows"
              :key="`old-${String(virtualRow.key)}`"
              class="virtual-row"
              :data-index="virtualRow.index"
              :ref="measureLeftElement"
              :style="{ transform: `translateY(${virtualRow.start}px)` }"
            >
              <template v-if="displayDiffRow(leftDisplayRows[virtualRow.index])">
              <SplitDiffPaneRow
                :row="displayDiffRow(leftDisplayRows[virtualRow.index])!"
                side="old"
                :syntax-spans="syntaxForRow(displayDiffRow(leftDisplayRows[virtualRow.index])!, 'old')"
                :comment-count="commentCountForRow(displayDiffRow(leftDisplayRows[virtualRow.index])!, 'old')"
                :comments-expanded="commentsExpandedForRow(displayDiffRow(leftDisplayRows[virtualRow.index])!, 'old')"
                :review-highlights="reviewHighlightsForRow(displayDiffRow(leftDisplayRows[virtualRow.index])!, 'old')"
                :comment-hover-disabled="commentHoverDisabled"
                @comment="startLineComment"
                @toggle-comments="toggleComments"
              />
              </template>
              <div v-else class="inline-review-row old">
                <InlineReviewBox v-if="displayReviewRow(leftDisplayRows[virtualRow.index])" :entry="displayReviewRow(leftDisplayRows[virtualRow.index])!" v-model:draft-body="draftBody" :error="review.error" @submit="submitComment" @cancel="cancelDraft" @reply="addReply" @collapse="collapseThread" @resolve="resolveThread" @reopen="reopenThread" />
              </div>
            </div>
          </div>
        </div>
        <div v-if="hasLeftScroll" class="diff-scrollbar" @pointerdown="onScrollbarTrackPointerDown($event, 'left')">
          <div
            v-for="marker in leftMarkers"
            :key="marker.key"
            class="diff-scroll-marker"
            :class="marker.kind"
            :style="marker.style"
          />
          <div class="diff-scroll-thumb" :style="leftThumbStyle" @pointerdown.stop="onScrollbarThumbPointerDown($event, 'left')" />
        </div>
      </div>
      <div class="pane-shell" :class="{ 'has-diff-scroll': hasRightScroll }">
        <div ref="rightRef" class="pane new-pane" @scroll="onRightScroll" @mouseup="captureSelectionComment">
          <div class="spacer" :style="{ height: `${rightTotalSize}px` }">
            <div
              v-for="virtualRow in rightVirtualRows"
              :key="`new-${String(virtualRow.key)}`"
              class="virtual-row"
              :data-index="virtualRow.index"
              :ref="measureRightElement"
              :style="{ transform: `translateY(${virtualRow.start}px)` }"
            >
              <template v-if="displayDiffRow(rightDisplayRows[virtualRow.index])">
              <SplitDiffPaneRow
                :row="displayDiffRow(rightDisplayRows[virtualRow.index])!"
                side="new"
                :syntax-spans="syntaxForRow(displayDiffRow(rightDisplayRows[virtualRow.index])!, 'new')"
                :comment-count="commentCountForRow(displayDiffRow(rightDisplayRows[virtualRow.index])!, 'new')"
                :comments-expanded="commentsExpandedForRow(displayDiffRow(rightDisplayRows[virtualRow.index])!, 'new')"
                :review-highlights="reviewHighlightsForRow(displayDiffRow(rightDisplayRows[virtualRow.index])!, 'new')"
                :comment-hover-disabled="commentHoverDisabled"
                @comment="startLineComment"
                @toggle-comments="toggleComments"
              />
              </template>
              <div v-else class="inline-review-row new">
                <InlineReviewBox v-if="displayReviewRow(rightDisplayRows[virtualRow.index])" :entry="displayReviewRow(rightDisplayRows[virtualRow.index])!" v-model:draft-body="draftBody" :error="review.error" @submit="submitComment" @cancel="cancelDraft" @reply="addReply" @collapse="collapseThread" @resolve="resolveThread" @reopen="reopenThread" />
              </div>
            </div>
          </div>
        </div>
        <div v-if="hasRightScroll" class="diff-scrollbar" @pointerdown="onScrollbarTrackPointerDown($event, 'right')">
          <div
            v-for="marker in rightMarkers"
            :key="marker.key"
            class="diff-scroll-marker"
            :class="marker.kind"
            :style="marker.style"
          />
          <div class="diff-scroll-thumb" :style="rightThumbStyle" @pointerdown.stop="onScrollbarThumbPointerDown($event, 'right')" />
        </div>
      </div>
    </div>
    <div v-else class="pane-shell" :class="{ 'has-diff-scroll': hasInlineScroll }">
      <div ref="inlineRef" class="pane inline-view" @scroll="onInlineScroll" @mouseup="captureSelectionComment">
        <div class="spacer inline-spacer" :style="{ height: `${inlineTotalSize}px` }">
          <div
            v-for="virtualRow in inlineVirtualRows"
            :key="String(virtualRow.key)"
            class="virtual-row"
            :data-index="virtualRow.index"
            :ref="measureInlineElement"
            :style="{ transform: `translateY(${virtualRow.start}px)` }"
          >
            <template v-if="displayDiffRow(inlineDisplayRows[virtualRow.index])">
              <InlineDiffRow
                :row="displayDiffRow(inlineDisplayRows[virtualRow.index])!"
                :syntax-spans="syntaxForInlineRow(displayDiffRow(inlineDisplayRows[virtualRow.index])!)"
                :old-comment-count="commentCountForRow(displayDiffRow(inlineDisplayRows[virtualRow.index])!, 'old')"
                :new-comment-count="commentCountForRow(displayDiffRow(inlineDisplayRows[virtualRow.index])!, 'new')"
                :old-comments-expanded="commentsExpandedForRow(displayDiffRow(inlineDisplayRows[virtualRow.index])!, 'old')"
                :new-comments-expanded="commentsExpandedForRow(displayDiffRow(inlineDisplayRows[virtualRow.index])!, 'new')"
                :review-highlights="reviewHighlightsForInlineRow(displayDiffRow(inlineDisplayRows[virtualRow.index])!)"
                :comment-hover-disabled="commentHoverDisabled"
                @comment="startLineComment"
                @toggle-comments="toggleComments"
              />
            </template>
            <div v-else class="inline-review-row inline">
              <InlineReviewBox v-if="displayReviewRow(inlineDisplayRows[virtualRow.index])" :entry="displayReviewRow(inlineDisplayRows[virtualRow.index])!" v-model:draft-body="draftBody" :error="review.error" @submit="submitComment" @cancel="cancelDraft" @reply="addReply" @collapse="collapseThread" @resolve="resolveThread" @reopen="reopenThread" />
            </div>
          </div>
        </div>
      </div>
      <div v-if="hasInlineScroll" class="diff-scrollbar" @pointerdown="onScrollbarTrackPointerDown($event, 'inline')">
        <div
          v-for="marker in inlineMarkers"
          :key="marker.key"
          class="diff-scroll-marker"
          :class="marker.kind"
          :style="marker.style"
        />
        <div class="diff-scroll-thumb" :style="inlineThumbStyle" @pointerdown.stop="onScrollbarThumbPointerDown($event, 'inline')" />
      </div>
    </div>
    <div
      v-if="selectionDraft"
      class="selection-toolbar"
      :style="selectionBubbleStyle"
    >
      <button type="button" title="Comment on selection" aria-label="Comment on selection" @pointerdown.prevent.stop="startSelectionComment">
        <span class="comment-icon" aria-hidden="true" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { useClient } from '../../lib/useClient';
import type { ChangedFile, DiffContextMode, DiffRenderModel, DiffRow, DiffTarget, DiffViewMode, ReviewAnchor, ReviewThread, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import { useRepoStore } from '../../stores/repo';
import { useReviewStore } from '../../stores/review';
import type { ReviewTextHighlight } from './HighlightedCode.vue';
import InlineReviewBox, { type InlineReviewEntry } from './InlineReviewBox.vue';
import InlineDiffRow from './InlineDiffRow.vue';
import SplitDiffRow from './SplitDiffRow.vue';
import SplitDiffPaneRow from './SplitDiffPaneRow.vue';

const props = defineProps<{
  model?: DiffRenderModel 
  loading: boolean
  error?: string 
  viewMode: DiffViewMode
  contextMode: DiffContextMode
  target: DiffTarget
  syncScroll: boolean
  installingGrammar: boolean
  grammarInstallStep?: string
  hasNewChanges: boolean
}>();

const emit = defineEmits<{
  'update:viewMode': [mode: DiffViewMode]
  'update:contextMode': [mode: DiffContextMode]
  'update:syncScroll': [enabled: boolean]
  installGrammar: []
  loadLatest: []
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
const selectionBubblePosition = ref({ left: 18, top: 52 });
const selectionDraft = ref<{ file: ChangedFile; anchor: ReviewAnchor }>();
const nativeSelectionRange = ref<Range>();
const collapsedCommentStarts = ref(new Set<string>());
const expandedResolvedCommentStarts = ref(new Set<string>());
const syntaxCache = new Map<string, SyntaxSpan[]>();
const syntaxPageStates = new Map<string, 'queued-high' | 'queued-low' | 'loading' | 'done'>();
const highPrioritySyntaxQueue: SyntaxPageRequest[] = [];
const lowPrioritySyntaxQueue: SyntaxPageRequest[] = [];
const syntaxVersion = ref(0);
const initialSyntaxGateActive = ref(false);
let syntaxQueueRunning = false;
let isSyncingScroll = false;
let syncScrollFrame: number | undefined;
let pendingScrollSync: { target: HTMLElement; top: number; left: number } | undefined;
let syntaxPrefetchTimer: number | undefined;
let initialSyntaxGateTimer: number | undefined;
let initialSyntaxGeneration = 0;
let syntaxRequestGeneration = 0;
const syntaxPageSize = 128;
const syntaxPageLookaround = 1;
const initialSyntaxGateMs = 80;
const hasLeftScroll = ref(false);
const hasRightScroll = ref(false);
const hasSyncedSplitScroll = ref(false);
const hasInlineScroll = ref(false);
let paneResizeObserver: ResizeObserver | undefined;
let scrollbarDrag: { pane: PaneKey; startY: number; startScrollTop: number; trackHeight: number } | undefined;
let paneScrollStateFrame: number | undefined;

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

type DisplayRow = {
  kind: 'diff';
  key: string;
  row: DiffRow;
} | InlineReviewEntry;

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

type PaneKey = 'left' | 'right' | 'syncedSplit' | 'inline';

type PaneScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

function emptyScrollMetrics(): PaneScrollMetrics {
  return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
}

const syntaxMessage = computed(() => {
  const syntax = props.model?.syntax;
  if (!syntax?.language) return undefined;
  if (syntax.grammarInstalled) return undefined;

  return `No ${syntax.language} grammar installed`;
});

const activeFile = computed(() => repo.changedFiles.find((file) => file.id === props.model?.fileId));
const fileThreads = computed(() => review.threads.filter((thread) => thread.fileId === props.model?.fileId));
const leftDisplayRows = computed(() => buildDisplayRows('old'));
const rightDisplayRows = computed(() => buildDisplayRows('new'));
const syncedSplitDisplayRows = computed(() => buildDisplayRows());
const inlineDisplayRows = computed(() => buildDisplayRows());
const leftMarkers = computed(() => scrollMarkersForRows(leftDisplayRows.value, 'old'));
const rightMarkers = computed(() => scrollMarkersForRows(rightDisplayRows.value, 'new'));
const syncedSplitMarkers = computed(() => scrollMarkersForRows(syncedSplitDisplayRows.value));
const inlineMarkers = computed(() => scrollMarkersForRows(inlineDisplayRows.value));
const leftScrollMetrics = ref<PaneScrollMetrics>(emptyScrollMetrics());
const rightScrollMetrics = ref<PaneScrollMetrics>(emptyScrollMetrics());
const syncedSplitScrollMetrics = ref<PaneScrollMetrics>(emptyScrollMetrics());
const inlineScrollMetrics = ref<PaneScrollMetrics>(emptyScrollMetrics());
const leftThumbStyle = computed(() => scrollThumbStyle(leftScrollMetrics.value));
const rightThumbStyle = computed(() => scrollThumbStyle(rightScrollMetrics.value));
const syncedSplitThumbStyle = computed(() => scrollThumbStyle(syncedSplitScrollMetrics.value));
const inlineThumbStyle = computed(() => scrollThumbStyle(inlineScrollMetrics.value));
const selectionBubbleStyle = computed(() => ({
  left: `${selectionBubblePosition.value.left}px`,
  top: `${selectionBubblePosition.value.top}px`,
}));

const commentCountForRow = (row: DiffRow, side: SyntaxSide) => {
  const line = side === 'old' ? row.oldLine : row.newLine;
  if (!props.model || !line) return 0;
  return fileThreads.value.filter((thread) => thread.anchor.side === side && thread.anchor.startLine === line).length;
};

const commentsExpandedForRow = (row: DiffRow, side: SyntaxSide) => {
  const line = side === 'old' ? row.oldLine : row.newLine;
  return Boolean(line && commentsExpandedForStart(side, line));
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

const commentStartKey = (side: SyntaxSide, line: number) => `${side}:${line}`;

const commentsExpandedForStart = (side: SyntaxSide, line: number) => {
  const key = commentStartKey(side, line);
  if (collapsedCommentStarts.value.has(key)) return false;
  return fileThreads.value.some((thread) => {
    if (thread.anchor.side !== side || thread.anchor.startLine !== line) return false;
    return thread.status === 'open' || expandedResolvedCommentStarts.value.has(key);
  });
};

const reviewHighlightsForInlineRow = (row: DiffRow) => {
  const side = row.kind === 'deleted' ? 'old' : 'new';
  return reviewHighlightsForRow(row, side);
};

const reviewHighlightsForRow = (row: DiffRow, side: SyntaxSide): ReviewTextHighlight[] => {
  const line = side === 'old' ? row.oldLine : row.newLine;
  const text = side === 'old' ? row.oldText ?? '' : row.newText ?? '';
  if (!line || text.length === 0) return [];

  return reviewHighlightAnchors(side)
    .map((anchor) => reviewHighlightForLine(anchor, line, text.length))
    .filter((highlight): highlight is ReviewTextHighlight => Boolean(highlight));
};

const reviewHighlightAnchors = (side: SyntaxSide) => {
  const anchors = fileThreads.value
    .filter((thread) => commentsExpandedForStart(thread.anchor.side, thread.anchor.startLine))
    .map((thread) => thread.anchor);
  if (review.draftAnchor && review.draftFile?.id === props.model?.fileId) anchors.push(review.draftAnchor);
  const pendingSelection = selectionDraft.value;
  if (pendingSelection && pendingSelection.file.id === props.model?.fileId) anchors.push(pendingSelection.anchor);
  return anchors.filter((anchor) => anchor.side === side && anchor.startColumn !== undefined && anchor.endColumn !== undefined);
};

const reviewHighlightForLine = (anchor: ReviewAnchor, line: number, textLength: number): ReviewTextHighlight | undefined => {
  if (line < anchor.startLine || line > anchor.endLine) return undefined;
  const startColumn = line === anchor.startLine ? anchor.startColumn ?? 0 : 0;
  const endColumn = line === anchor.endLine ? anchor.endColumn ?? textLength : textLength;
  if (endColumn <= startColumn) return undefined;
  return { startColumn, endColumn };
};

const buildDisplayRows = (side?: SyntaxSide): DisplayRow[] => {
  const result: DisplayRow[] = [];
  const reviewEntries = reviewEntriesByEndLine(side);
  rows.value.forEach((row, index) => {
    result.push({ kind: 'diff', key: `diff:${index}`, row });
    const oldEntries = row.oldLine ? reviewEntries.get(`old:${row.oldLine}`) ?? [] : [];
    const newEntries = row.newLine ? reviewEntries.get(`new:${row.newLine}`) ?? [] : [];
    result.push(...oldEntries, ...newEntries);
  });
  return result;
};

const reviewEntriesByEndLine = (side?: SyntaxSide) => {
  const entries = new Map<string, InlineReviewEntry[]>();
  const addEntry = (entry: InlineReviewEntry) => {
    if (side && entry.anchor.side !== side) return;
    if (entry.kind === 'thread' && collapsedCommentStarts.value.has(commentStartKey(entry.anchor.side, entry.anchor.startLine))) return;
    const key = `${entry.anchor.side}:${entry.anchor.endLine}`;
    entries.set(key, [...entries.get(key) ?? [], entry]);
  };

  for (const thread of fileThreads.value) {
    if (thread.status === 'resolved' && !resolvedThreadExpanded(thread)) continue;
    addEntry({ kind: 'thread', key: `thread:${thread.id}`, anchor: thread.anchor, thread });
  }

  if (review.draftAnchor && review.draftFile?.id === props.model?.fileId) {
    addEntry({ kind: 'draft', key: `draft:${review.draftAnchor.side}:${review.draftAnchor.startLine}:${review.draftAnchor.endLine}`, anchor: review.draftAnchor });
  }

  return entries;
};

const resolvedThreadExpanded = (thread: ReviewThread) => expandedResolvedCommentStarts.value.has(commentStartKey(thread.anchor.side, thread.anchor.startLine));

const displayDiffRow = (item?: DisplayRow) => item?.kind === 'diff' ? item.row : undefined;

const displayReviewRow = (item?: DisplayRow): InlineReviewEntry | undefined => item && item.kind !== 'diff' ? item : undefined;

const startLineComment = (payload: { side: 'old' | 'new'; line: number; text: string; clientX: number; clientY: number }) => {
  if (!props.model || !activeFile.value) return;
  selectionDraft.value = undefined;
  nativeSelectionRange.value = undefined;
  draftBody.value = '';
  review.startDraft(activeFile.value, {
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
  if (!selection || !selectedText || selection.rangeCount === 0 || !props.model || !activeFile.value) {
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
  if ((side !== 'old' && side !== 'new') || end.dataset.reviewSide !== side) {
    selectionDraft.value = undefined;
    return;
  }
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
  if (!rect) {
    selectionDraft.value = undefined;
    return;
  }
  positionSelectionToolbar(rect.right, rect.top);
  selectionDraft.value = {
    file: activeFile.value,
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
  return element?.closest<HTMLElement>('[data-review-side][data-review-line]');
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
  const next = new Set(collapsedCommentStarts.value);
  next.add(commentStartKey(thread.anchor.side, thread.anchor.startLine));
  collapsedCommentStarts.value = next;
  const expandedResolved = new Set(expandedResolvedCommentStarts.value);
  expandedResolved.delete(commentStartKey(thread.anchor.side, thread.anchor.startLine));
  expandedResolvedCommentStarts.value = expandedResolved;
};

const reopenThread = async (thread: ReviewThread) => {
  await review.reopenThread(thread);
  const next = new Set(collapsedCommentStarts.value);
  next.delete(commentStartKey(thread.anchor.side, thread.anchor.startLine));
  collapsedCommentStarts.value = next;
  const expandedResolved = new Set(expandedResolvedCommentStarts.value);
  expandedResolved.delete(commentStartKey(thread.anchor.side, thread.anchor.startLine));
  expandedResolvedCommentStarts.value = expandedResolved;
};

const startSelectionComment = (event: PointerEvent) => {
  if (!selectionDraft.value) return;
  draftBody.value = '';
  review.startDraft(selectionDraft.value.file, selectionDraft.value.anchor);
  selectionDraft.value = undefined;
};

const clearNativeSelection = () => {
  nativeSelectionRange.value = undefined;
  window.getSelection()?.removeAllRanges();
};

const positionSelectionToolbar = (clientX: number, clientY: number) => {
  const root = rootRef.value;
  if (!root) return;

  const rect = root.getBoundingClientRect();
  const toolbarWidth = 34;
  const toolbarHeight = 30;
  const gap = 6;
  selectionBubblePosition.value = {
    left: Math.max(12, Math.min(clientX - rect.left + gap, rect.width - toolbarWidth - 12)),
    top: Math.max(48, Math.min(clientY - rect.top - toolbarHeight - gap, rect.height - toolbarHeight - 12)),
  };
};

const clearSelectionDraftWhenSelectionEnds = () => {
  if (!selectionDraft.value) return;
  if (window.getSelection()?.toString().trim()) return;
  selectionDraft.value = undefined;
  nativeSelectionRange.value = undefined;
};

onMounted(() => {
  document.addEventListener('selectionchange', clearSelectionDraftWhenSelectionEnds);
  paneResizeObserver = new ResizeObserver(updatePaneScrollStates);
  if (rootRef.value) paneResizeObserver.observe(rootRef.value);
  updatePaneScrollStatesAfterRender();
});

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', clearSelectionDraftWhenSelectionEnds);
  window.removeEventListener('pointermove', onScrollbarThumbPointerMove);
  window.removeEventListener('pointerup', stopScrollbarThumbDrag);
  if (paneScrollStateFrame !== undefined) cancelAnimationFrame(paneScrollStateFrame);
  paneResizeObserver?.disconnect();
});

const diffTargetFingerprint = () => JSON.stringify({
  base: props.target.base,
  compare: props.target.compare,
  includeStaged: props.target.includeStaged,
  includeUnstaged: props.target.includeUnstaged,
  head: repo.repository?.head,
});

const paneHasVerticalScroll = (element: HTMLElement | null) => Boolean(element && element.scrollHeight > element.clientHeight + 1);

const paneScrollMetrics = (element: HTMLElement | null): PaneScrollMetrics => ({
  scrollTop: element?.scrollTop ?? 0,
  scrollHeight: element?.scrollHeight ?? 0,
  clientHeight: element?.clientHeight ?? 0,
});

const updatePaneScrollStates = () => {
  paneScrollStateFrame = undefined;
  hasLeftScroll.value = paneHasVerticalScroll(leftRef.value);
  hasRightScroll.value = paneHasVerticalScroll(rightRef.value);
  hasSyncedSplitScroll.value = paneHasVerticalScroll(syncedSplitRef.value);
  hasInlineScroll.value = paneHasVerticalScroll(inlineRef.value);
  leftScrollMetrics.value = paneScrollMetrics(leftRef.value);
  rightScrollMetrics.value = paneScrollMetrics(rightRef.value);
  syncedSplitScrollMetrics.value = paneScrollMetrics(syncedSplitRef.value);
  inlineScrollMetrics.value = paneScrollMetrics(inlineRef.value);
};

const schedulePaneScrollStateUpdate = () => {
  if (paneScrollStateFrame !== undefined) return;
  paneScrollStateFrame = requestAnimationFrame(updatePaneScrollStates);
};

const updatePaneScrollStatesAfterRender = () => {
  void nextTick(() => {
    requestAnimationFrame(updatePaneScrollStates);
  });
};

const estimateDisplayItemSize = (item?: DisplayRow) => {
  if (!item) return 24;
  if (item.kind === 'draft') return 220;
  if (item.kind === 'thread') return 150;
  return item.row.kind === 'hunk' ? 28 : 24;
};

const estimateDisplaySize = (items: DisplayRow[]) => (index: number) => estimateDisplayItemSize(items[index]);

const scrollMarkersForRows = (items: DisplayRow[], side?: SyntaxSide): DiffScrollMarker[] => {
  const totalSize = items.reduce((sum, item) => sum + estimateDisplayItemSize(item), 0);
  if (totalSize <= 0) return [];

  const markerRanges: DiffScrollMarkerRange[] = [];
  let offset = 0;
  items.forEach((item) => {
    const size = estimateDisplayItemSize(item);
    if (item.kind === 'diff' && (item.row.kind === 'added' || item.row.kind === 'deleted') && markerVisibleForSide(item.row.kind, side)) {
      const top = offset / totalSize * 100;
      const bottom = Math.max((offset + size) / totalSize * 100, top + 0.45);
      const previous = markerRanges[markerRanges.length - 1];
      if (previous?.kind === item.row.kind && top <= previous.bottom + 0.15) {
        previous.bottom = Math.max(previous.bottom, bottom);
      } else {
        markerRanges.push({ kind: item.row.kind, top, bottom });
      }
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

const markerVisibleForSide = (kind: 'added' | 'deleted', side?: SyntaxSide) => {
  if (side === 'old') return kind === 'deleted';
  if (side === 'new') return kind === 'added';
  return true;
};

const scrollThumbStyle = (metrics: PaneScrollMetrics): CSSProperties => {
  if (metrics.scrollHeight <= metrics.clientHeight || metrics.clientHeight <= 0) return { display: 'none' };
  return {
    top: `${(metrics.scrollTop / metrics.scrollHeight) * 100}%`,
    height: `${Math.max((metrics.clientHeight / metrics.scrollHeight) * 100, 6)}%`,
  };
};

const leftVirtualizer = useVirtualizer(
  computed(() => ({
    count: leftDisplayRows.value.length,
    getScrollElement: () => leftRef.value,
    getItemKey: (index) => leftDisplayRows.value[index]?.key ?? index,
    estimateSize: estimateDisplaySize(leftDisplayRows.value),
    overscan: 12,
    useAnimationFrameWithResizeObserver: true,
  }))
);

const rightVirtualizer = useVirtualizer(
  computed(() => ({
    count: rightDisplayRows.value.length,
    getScrollElement: () => rightRef.value,
    getItemKey: (index) => rightDisplayRows.value[index]?.key ?? index,
    estimateSize: estimateDisplaySize(rightDisplayRows.value),
    overscan: 12,
    useAnimationFrameWithResizeObserver: true,
  }))
);

const syncedSplitVirtualizer = useVirtualizer(
  computed(() => ({
    count: syncedSplitDisplayRows.value.length,
    getScrollElement: () => syncedSplitRef.value,
    getItemKey: (index) => syncedSplitDisplayRows.value[index]?.key ?? index,
    estimateSize: estimateDisplaySize(syncedSplitDisplayRows.value),
    overscan: 12,
    useAnimationFrameWithResizeObserver: true,
  }))
);

const inlineVirtualizer = useVirtualizer(
  computed(() => ({
    count: inlineDisplayRows.value.length,
    getScrollElement: () => inlineRef.value,
    getItemKey: (index) => inlineDisplayRows.value[index]?.key ?? index,
    estimateSize: estimateDisplaySize(inlineDisplayRows.value),
    overscan: 12,
    useAnimationFrameWithResizeObserver: true,
  }))
);

const leftVirtualRows = computed(() => leftVirtualizer.value.getVirtualItems());
const rightVirtualRows = computed(() => rightVirtualizer.value.getVirtualItems());
const syncedSplitVirtualRows = computed(() => syncedSplitVirtualizer.value.getVirtualItems());
const inlineVirtualRows = computed(() => inlineVirtualizer.value.getVirtualItems());
const leftTotalSize = computed(() => leftVirtualizer.value.getTotalSize());
const rightTotalSize = computed(() => rightVirtualizer.value.getTotalSize());
const syncedSplitTotalSize = computed(() => syncedSplitVirtualizer.value.getTotalSize());
const inlineTotalSize = computed(() => inlineVirtualizer.value.getTotalSize());
const commentHoverDisabled = computed(() => {
  return leftVirtualizer.value.isScrolling || rightVirtualizer.value.isScrolling || syncedSplitVirtualizer.value.isScrolling || inlineVirtualizer.value.isScrolling;
});

watch(
  [leftTotalSize, rightTotalSize, syncedSplitTotalSize, inlineTotalSize, () => props.viewMode, () => props.syncScroll],
  updatePaneScrollStatesAfterRender,
  { immediate: true, flush: 'post' }
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

const syntaxKey = (side: SyntaxSide, line: number) => `${side}:${line}`;

const syntaxForRow = (row: DiffRow, side: SyntaxSide) => {
  syntaxVersion.value;
  const line = side === 'old' ? row.oldLine : row.newLine;
  return line ? syntaxCache.get(syntaxKey(side, line)) : undefined;
};

const syntaxForInlineRow = (row: DiffRow) => {
  return syntaxForRow(row, row.kind === 'deleted' ? 'old' : 'new');
};

const syntaxPageKey = (fileId: string, context: DiffContextMode, side: SyntaxSide, page: number) => `${fileId}:${context}:${side}:${page}`;

const runSyntaxQueue = () => {
  if (syntaxQueueRunning) return;
  syntaxQueueRunning = true;

  const runNext = async () => {
    const request = highPrioritySyntaxQueue.shift() ?? lowPrioritySyntaxQueue.shift();
    if (!request) {
      syntaxQueueRunning = false;
      return;
    }

    const state = syntaxPageStates.get(request.key);
    if (state !== 'queued-high' && state !== 'queued-low') {
      void runNext();
      return;
    }

    syntaxPageStates.set(request.key, 'loading');
    try {
      const lines = await client.getSyntaxSpans(request.fileId, request.side, request.startLine, request.endLine, { context: request.context }, props.target);
      const isCurrentRequest = request.generation === syntaxRequestGeneration && props.model?.fileId === request.fileId && props.model.context === request.context;
      if (isCurrentRequest) {
        for (const line of lines) syntaxCache.set(syntaxKey(request.side, line.line), line.spans);
        syntaxVersion.value += 1;
        syntaxPageStates.set(request.key, 'done');
      } else if (request.generation === syntaxRequestGeneration && syntaxPageStates.get(request.key) === 'loading') {
        syntaxPageStates.delete(request.key);
      }
    } catch {
      if (request.generation === syntaxRequestGeneration) syntaxPageStates.delete(request.key);
    }

    void runNext();
  };

  void runNext();
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
  }, 900);
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
    schedulePaneScrollStateUpdate();
  });
};

const paneForKey = (pane: PaneKey) => {
  if (pane === 'left') return leftRef.value;
  if (pane === 'right') return rightRef.value;
  if (pane === 'syncedSplit') return syncedSplitRef.value;
  return inlineRef.value;
};

const onLeftScroll = (event: Event) => {
  schedulePaneScrollStateUpdate();
  if (isSyncingScroll) return;
  syncScrollPosition(event.currentTarget as HTMLElement, rightRef.value);
};

const onRightScroll = (event: Event) => {
  schedulePaneScrollStateUpdate();
  if (isSyncingScroll) return;
  syncScrollPosition(event.currentTarget as HTMLElement, leftRef.value);
};

const onSyncedSplitScroll = () => {
  schedulePaneScrollStateUpdate();
};

const onInlineScroll = () => {
  schedulePaneScrollStateUpdate();
};

const onScrollbarTrackPointerDown = (event: PointerEvent, pane: PaneKey) => {
  const element = paneForKey(pane);
  const track = event.currentTarget as HTMLElement;
  if (!element || track.clientHeight <= 0) return;

  const thumbHeight = Math.max((element.clientHeight / element.scrollHeight) * track.clientHeight, 24);
  const trackTop = track.getBoundingClientRect().top;
  const targetTop = event.clientY - trackTop - thumbHeight / 2;
  element.scrollTop = Math.max(0, Math.min(targetTop / track.clientHeight * element.scrollHeight, element.scrollHeight - element.clientHeight));
  schedulePaneScrollStateUpdate();
};

const onScrollbarThumbPointerDown = (event: PointerEvent, pane: PaneKey) => {
  const element = paneForKey(pane);
  const track = (event.currentTarget as HTMLElement).parentElement;
  if (!element || !track || track.clientHeight <= 0) return;

  scrollbarDrag = { pane, startY: event.clientY, startScrollTop: element.scrollTop, trackHeight: track.clientHeight };
  window.addEventListener('pointermove', onScrollbarThumbPointerMove);
  window.addEventListener('pointerup', stopScrollbarThumbDrag, { once: true });
};

const onScrollbarThumbPointerMove = (event: PointerEvent) => {
  if (!scrollbarDrag) return;
  const element = paneForKey(scrollbarDrag.pane);
  if (!element || scrollbarDrag.trackHeight <= 0) return;

  const deltaY = event.clientY - scrollbarDrag.startY;
  element.scrollTop = scrollbarDrag.startScrollTop + deltaY / scrollbarDrag.trackHeight * element.scrollHeight;
  schedulePaneScrollStateUpdate();
};

const stopScrollbarThumbDrag = () => {
  scrollbarDrag = undefined;
  window.removeEventListener('pointermove', onScrollbarThumbPointerMove);
};

watch(
  () => props.syncScroll,
  (enabled, wasEnabled) => {
    if (props.viewMode !== 'split' || enabled === wasEnabled) return;

    const source = wasEnabled ? syncedSplitRef.value : leftRef.value ?? rightRef.value;
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
  }
);

watch(
  () => `${props.model?.fileId ?? ''}:${props.model?.context ?? ''}`,
  () => {
    syntaxRequestGeneration += 1;
    syntaxCache.clear();
    syntaxPageStates.clear();
    highPrioritySyntaxQueue.length = 0;
    lowPrioritySyntaxQueue.length = 0;
    syntaxQueueRunning = false;
    if (syntaxPrefetchTimer !== undefined) window.clearTimeout(syntaxPrefetchTimer);
    syntaxPrefetchTimer = undefined;
    if (initialSyntaxGateTimer !== undefined) window.clearTimeout(initialSyntaxGateTimer);
    initialSyntaxGateTimer = undefined;
    initialSyntaxGateActive.value = false;
    syntaxVersion.value += 1;
    startInitialSyntaxGate();
  }
);

watch(
  [leftVirtualRows, rightVirtualRows, syncedSplitVirtualRows, inlineVirtualRows, () => props.model?.syntax.grammarInstalled, () => props.viewMode, () => props.syncScroll],
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
  { immediate: true, flush: 'post' }
);
</script>

<style scoped lang="scss">
.diff-viewer {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  height: 100%;
  background: #111318;
  overflow: hidden;
}

.diff-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
  height: 40px;
  padding: 0 14px;
  align-items: center;
  color: #98a2b3;
  background: #151821;
  border-bottom: 1px solid #252a35;
  font-size: 12px;
}

.file-meta,
.controls {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.file-meta {
  overflow: hidden;

  span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.row-count {
  flex: 0 0 auto;
  color: #687386;
}

.syntax-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  padding: 2px 7px;
  color: #d3a45f;
  background: rgba(211, 164, 95, 0.12);
  border: 1px solid rgba(211, 164, 95, 0.2);
  border-radius: 999px;
}

.update-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  padding: 2px 7px;
  color: #8fd6ff;
  background: rgba(77, 166, 255, 0.12);
  border: 1px solid rgba(77, 166, 255, 0.24);
  border-radius: 999px;
}

.install-grammar,
.load-latest {
  padding: 0 6px;
  border-radius: 999px;
  cursor: pointer;
  font: inherit;

  &:disabled {
    cursor: default;
    opacity: 0.65;
  }
}

.install-grammar {
  color: #f3c98b;
  background: rgba(211, 164, 95, 0.16);
  border: 1px solid rgba(211, 164, 95, 0.28);
}

.load-latest {
  color: #d7f1ff;
  background: rgba(77, 166, 255, 0.16);
  border: 1px solid rgba(77, 166, 255, 0.32);
}

.install-step {
  max-width: 220px;
  overflow: hidden;
  color: #aeb7c6;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.controls {
  flex: 0 0 auto;
}

.control {
  height: 26px;
  padding: 0 10px;
  color: #98a2b3;
  background: #111722;
  border: 1px solid #2a3140;
  border-radius: 7px;
  cursor: pointer;
  font: inherit;

  &.active {
    color: #f5f7fb;
    background: #24406f;
    border-color: #3865ad;
  }
}

.message {
  padding: 24px;
  color: #7e8aa0;

  &.error {
    color: #ff8d8d;
  }
}

.syntax-gate {
  min-height: 0;
  background: #111318;
}

.split-view {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-height: 0;
}

.pane-shell {
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

.old-pane-shell {
  border-right: 1px solid #252a35;
}

.pane {
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

.inline-view {
  min-width: 0;
}

.synced-split-view {
  min-width: 0;
}

.spacer {
  position: relative;
  min-width: 560px;
}

.synced-split-spacer {
  min-width: 1120px;
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

.inline-spacer {
  min-width: 900px;
}

.virtual-row {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;

  z-index: 1;
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
  font: inherit;

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

.review-panel {
  position: absolute;
  z-index: 5;
  display: grid;
  gap: 12px;
  width: 340px;
  max-height: calc(100% - 76px);
  padding: 14px;
  overflow: auto;
  color: #d7deea;
  background: rgba(19, 23, 32, 0.96);
  border: 1px solid #30384a;
  border-radius: 12px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.36);
}

.review-panel-header,
.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.review-error {
  color: #ff9d9d;
  font-size: 11px;
}

.comment-composer,
.thread-list {
  display: grid;
  gap: 10px;
}

.comment-anchor,
.thread-anchor {
  color: #98a2b3;
  font-size: 12px;
  text-transform: uppercase;
}

textarea {
  min-height: 96px;
  padding: 10px;
  resize: vertical;
  color: #f4f7fb;
  background: #0f131b;
  border: 1px solid #30384a;
  border-radius: 8px;
  font: inherit;
}

.composer-actions button,
.thread button {
  padding: 6px 10px;
  color: #d7e6ff;
  background: #1b2c4a;
  border: 1px solid #38527d;
  border-radius: 7px;
  cursor: pointer;
  font: inherit;

  &:disabled {
    cursor: default;
    opacity: 0.55;
  }
}

.thread {
  display: grid;
  gap: 8px;
  padding: 10px;
  background: #10151f;
  border: 1px solid #252d3d;
  border-radius: 9px;

  p {
    margin: 0;
    color: #eef3fb;
    white-space: pre-wrap;
  }
}
</style>
