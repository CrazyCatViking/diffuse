<template>
  <div v-if="row.kind === 'hunk'" class="diff-row hunk">
    <div class="hunk-text">{{ row.hunkHeader ?? row.text }}</div>
  </div>
  <div v-else class="diff-row" :class="[row.kind, { 'comment-hover-disabled': commentHoverDisabled }]">
    <div class="line-number old">
      <span>{{ row.oldLine ?? '' }}</span>
      <button
        v-if="oldCommentCount > 0 && !oldCommentsExpanded"
        class="collapsed-comment-indicator"
        type="button"
        title="Show collapsed comment"
        aria-label="Show collapsed comment"
        @click="emit('toggleComments', { side: 'old', line: row.oldLine! })"
      >
        <span class="comment-icon" aria-hidden="true" />
      </button>
      <button
        v-if="row.oldLine && oldCommentCount === 0"
        class="comment-bubble"
        type="button"
        title="Add old-side comment"
        aria-label="Add old-side comment"
        @click="emitOldComment"
      >
        <span class="comment-icon" aria-hidden="true" />
      </button>
      <DiagnosticMarker :diagnostics="oldDiagnostics" />
    </div>
    <HighlightedCode
      class="old"
      :text="row.oldText ?? ''"
      :spans="oldSyntaxSpans ?? row.oldSyntaxSpans"
      :review-highlights="oldReviewHighlights"
      :search-highlights="oldSearchHighlights"
      data-review-side="old"
      :data-review-line="row.oldLine"
      :data-review-file-id="fileId"
      :data-review-text="row.oldText ?? ''"
    />
    <div class="line-number new">
      <span>{{ row.newLine ?? '' }}</span>
      <button
        v-if="newCommentCount > 0 && !newCommentsExpanded"
        class="collapsed-comment-indicator"
        type="button"
        title="Show collapsed comment"
        aria-label="Show collapsed comment"
        @click="emit('toggleComments', { side: 'new', line: row.newLine! })"
      >
        <span class="comment-icon" aria-hidden="true" />
      </button>
      <button
        v-if="row.newLine && newCommentCount === 0"
        class="comment-bubble"
        type="button"
        title="Add new-side comment"
        aria-label="Add new-side comment"
        @click="emitNewComment"
      >
        <span class="comment-icon" aria-hidden="true" />
      </button>
      <DiagnosticMarker :diagnostics="newDiagnostics" />
    </div>
    <HighlightedCode
      class="new"
      :text="row.newText ?? ''"
      :spans="newSyntaxSpans ?? row.newSyntaxSpans"
      :review-highlights="newReviewHighlights"
      :search-highlights="newSearchHighlights"
      data-review-side="new"
      :data-review-line="row.newLine"
      :data-review-file-id="fileId"
      :data-review-text="row.newText ?? ''"
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
  fileId?: string;
  oldSyntaxSpans?: SyntaxSpan[];
  newSyntaxSpans?: SyntaxSpan[];
  oldCommentCount?: number;
  newCommentCount?: number;
  oldCommentsExpanded?: boolean;
  newCommentsExpanded?: boolean;
  oldReviewHighlights?: ReviewTextHighlight[];
  newReviewHighlights?: ReviewTextHighlight[];
  oldSearchHighlights?: SearchTextHighlight[];
  newSearchHighlights?: SearchTextHighlight[];
  oldDiagnostics?: LspDiagnostic[];
  newDiagnostics?: LspDiagnostic[];
  commentHoverDisabled?: boolean;
}>();

const emit = defineEmits<{
  comment: [payload: { side: 'old' | 'new'; line: number; text: string; clientX: number; clientY: number }];
  toggleComments: [payload: { side: 'old' | 'new'; line: number }];
}>();

const oldCommentCount = computed(() => props.oldCommentCount ?? 0);
const newCommentCount = computed(() => props.newCommentCount ?? 0);
const oldCommentsExpanded = computed(() => props.oldCommentsExpanded ?? false);
const newCommentsExpanded = computed(() => props.newCommentsExpanded ?? false);
const commentHoverDisabled = computed(() => props.commentHoverDisabled ?? false);
const emitOldComment = (event: MouseEvent) => {
  if (!props.row.oldLine) return;
  emit('comment', { side: 'old', line: props.row.oldLine, text: props.row.oldText ?? '', clientX: event.clientX, clientY: event.clientY });
};

const emitNewComment = (event: MouseEvent) => {
  if (!props.row.newLine) return;
  emit('comment', { side: 'new', line: props.row.newLine, text: props.row.newText ?? '', clientX: event.clientX, clientY: event.clientY });
};
</script>

<style scoped lang="scss">
.diff-row {
  position: relative;
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 64px minmax(0, 1fr);
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

.comment-bubble,
.collapsed-comment-indicator {
  position: absolute;
  top: 3px;
  left: 8px;
  z-index: 2;
  width: 20px;
  height: 18px;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  padding: 0;
}

.comment-bubble {
  opacity: 0;
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

.added {
  .new,
  .new + :deep(.code),
  :deep(.code.new) {
    background: #19312a;
  }
}

.deleted {
  .old,
  .old + :deep(.code),
  :deep(.code.old) {
    background: #362226;
  }
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
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 24px;
}
</style>
