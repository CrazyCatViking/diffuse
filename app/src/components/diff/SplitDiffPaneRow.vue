<template>
  <div v-if="row.kind === 'hunk'" class="diff-row hunk">
    <div class="hunk-text">{{ row.hunkHeader ?? row.text }}</div>
  </div>
  <div v-else class="diff-row" :class="[row.kind, side, { 'comment-hover-disabled': commentHoverDisabled }]">
    <div class="line-number">
      <span>{{ lineNumber }}</span>
      <button
        v-if="commentCount > 0 && !commentsExpanded"
        class="collapsed-comment-indicator"
        type="button"
        title="Show collapsed comment"
        aria-label="Show collapsed comment"
        @click="emit('toggleComments', { side, line: line! })"
      >
        <span class="comment-icon" aria-hidden="true" />
      </button>
      <DiagnosticMarker :diagnostics="diagnostics" />
    </div>
    <button
      v-if="line && commentCount === 0"
      class="comment-bubble"
      type="button"
      title="Add comment"
      aria-label="Add comment"
      @click="emitComment"
    >
      <span class="comment-icon" aria-hidden="true" />
    </button>
    <HighlightedCode
      :text="text"
      :spans="syntaxSpans ?? rowSpans"
      :review-highlights="reviewHighlights"
      :search-highlights="searchHighlights"
      :data-review-side="side"
      :data-review-line="line"
      :data-review-file-id="fileId"
      :data-review-text="text"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DiffRow, LspDiagnostic, SyntaxSpan } from '../../lib/protocol';
import DiagnosticMarker from './DiagnosticMarker.vue';
import HighlightedCode, { type ReviewTextHighlight, type SearchTextHighlight } from './HighlightedCode.vue';

const props = defineProps<{
  row: DiffRow;
  side: 'old' | 'new';
  fileId?: string;
  syntaxSpans?: SyntaxSpan[];
  commentCount?: number;
  commentsExpanded?: boolean;
  reviewHighlights?: ReviewTextHighlight[];
  searchHighlights?: SearchTextHighlight[];
  diagnostics?: LspDiagnostic[];
  commentHoverDisabled?: boolean;
}>();

const emit = defineEmits<{
  comment: [payload: { side: 'old' | 'new'; line: number; text: string; clientX: number; clientY: number }];
  toggleComments: [payload: { side: 'old' | 'new'; line: number }];
}>();

const line = computed(() => (props.side === 'old' ? props.row.oldLine : props.row.newLine));
const lineNumber = computed(() => line.value ?? '');
const text = computed(() => (props.side === 'old' ? (props.row.oldText ?? '') : (props.row.newText ?? '')));
const fileId = computed(() => props.fileId);
const rowSpans = computed(() => (props.side === 'old' ? props.row.oldSyntaxSpans : props.row.newSyntaxSpans));
const commentCount = computed(() => props.commentCount ?? 0);
const commentsExpanded = computed(() => props.commentsExpanded ?? false);
const commentHoverDisabled = computed(() => props.commentHoverDisabled ?? false);
const diagnostics = computed(() => props.diagnostics ?? []);

const emitComment = (event: MouseEvent) => {
  if (!line.value) return;
  emit('comment', { side: props.side, line: line.value, text: text.value, clientX: event.clientX, clientY: event.clientY });
};
</script>

<style scoped lang="scss">
.diff-row {
  position: relative;
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  height: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.025);
  box-sizing: border-box;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 24px;
}

.line-number {
  position: relative;
  padding: 0 10px 0 30px;
  color: #596273;
  background: #12151d;
  border-right: 1px solid #252a35;
  text-align: right;
  user-select: none;
}

.comment-bubble {
  position: absolute;
  top: 3px;
  left: 8px;
  z-index: 2;
  width: 20px;
  height: 18px;
  color: #111318;
  background: transparent;
  border: 0;
  opacity: 0;
  cursor: pointer;
  font: inherit;
  padding: 0;
  transform: translateX(-4px);
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.comment-icon {
  position: absolute;
  top: 4px;
  left: 3px;
  width: 10px;
  height: 7px;
  border: 2px solid #f0c36a;
  border-radius: 4px;

  &::after {
    position: absolute;
    right: -2px;
    bottom: -5px;
    width: 4px;
    height: 4px;
    border-right: 2px solid #f0c36a;
    border-bottom: 2px solid #f0c36a;
    content: '';
  }
}

.diff-row:hover .comment-bubble,
.comment-bubble:focus-visible {
  opacity: 1;
  transform: translateX(0);
}

.diff-row.comment-hover-disabled:hover .comment-bubble {
  opacity: 0;
  transform: translateX(-4px);
}

.collapsed-comment-indicator {
  position: absolute;
  top: 3px;
  left: 8px;
  width: 20px;
  height: 18px;
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 0;

  .comment-icon {
    opacity: 1;
  }
}

.deleted.old .line-number,
.deleted.old :deep(.code) {
  background: #362226;
}

.added.new .line-number,
.added.new :deep(.code) {
  background: #19312a;
}

.hunk {
  display: block;
  height: 28px;
  color: #9fb4ff;
  background: #1b2233;
  border-top: 1px solid #27324a;
  border-bottom: 1px solid #27324a;
}

.hunk-text {
  padding: 2px 12px;
  overflow: hidden;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 24px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
