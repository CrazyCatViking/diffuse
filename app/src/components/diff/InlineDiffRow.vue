<template>
  <div v-if="row.kind === 'hunk'" class="diff-row hunk">
    <div class="hunk-text">{{ row.hunkHeader ?? row.text }}</div>
  </div>
  <div v-else class="diff-row" :class="[row.kind, { 'comment-hover-disabled': commentHoverDisabled }]">
    <div class="line-number old">
      <span>{{ row.oldLine ?? '' }}</span>
      <button v-if="oldCount > 0 && !oldCommentsExpanded" class="collapsed-comment-indicator" type="button" title="Show collapsed comment" aria-label="Show collapsed comment" @click="emit('toggleComments', { side: 'old', line: row.oldLine! })">
        <span class="comment-icon" aria-hidden="true" />
      </button>
      <button v-if="row.oldLine && oldCount === 0" class="comment-bubble" type="button" title="Add old-side comment" aria-label="Add old-side comment" @click="emitOldComment">
        <span class="comment-icon" aria-hidden="true" />
      </button>
    </div>
    <div class="line-number new">
      <span>{{ row.newLine ?? '' }}</span>
      <button v-if="newCount > 0 && !newCommentsExpanded" class="collapsed-comment-indicator" type="button" title="Show collapsed comment" aria-label="Show collapsed comment" @click="emit('toggleComments', { side: 'new', line: row.newLine! })">
        <span class="comment-icon" aria-hidden="true" />
      </button>
      <button v-if="row.newLine && newCount === 0" class="comment-bubble" type="button" title="Add new-side comment" aria-label="Add new-side comment" @click="emitNewComment">
        <span class="comment-icon" aria-hidden="true" />
      </button>
    </div>
    <HighlightedCode
      :text="text"
      :spans="syntaxSpans ?? rowSpans"
      :review-highlights="reviewHighlights"
      :data-review-side="selectionSide"
      :data-review-line="selectionLine"
      :data-review-file-id="fileId"
      :data-review-text="text"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DiffRow, SyntaxSpan } from '../../lib/protocol';
import HighlightedCode, { type ReviewTextHighlight } from './HighlightedCode.vue';

const props = defineProps<{
  row: DiffRow
  fileId?: string
  syntaxSpans?: SyntaxSpan[]
  oldCommentCount?: number
  newCommentCount?: number
  oldCommentsExpanded?: boolean
  newCommentsExpanded?: boolean
  reviewHighlights?: ReviewTextHighlight[]
  commentHoverDisabled?: boolean
}>();

const emit = defineEmits<{
  comment: [payload: { side: 'old' | 'new'; line: number; text: string; clientX: number; clientY: number }]
  toggleComments: [payload: { side: 'old' | 'new'; line: number }]
}>();

const text = computed(() => props.row.oldText ?? props.row.newText ?? props.row.text ?? '');
const rowSpans = computed(() => props.row.kind === 'deleted' ? props.row.oldSyntaxSpans : props.row.newSyntaxSpans);
const selectionSide = computed<'old' | 'new'>(() => props.row.kind === 'deleted' ? 'old' : 'new');
const selectionLine = computed(() => selectionSide.value === 'old' ? props.row.oldLine : props.row.newLine);
const fileId = computed(() => props.fileId);
const oldCount = computed(() => props.oldCommentCount ?? 0);
const newCount = computed(() => props.newCommentCount ?? 0);
const oldCommentsExpanded = computed(() => props.oldCommentsExpanded ?? false);
const newCommentsExpanded = computed(() => props.newCommentsExpanded ?? false);
const commentHoverDisabled = computed(() => props.commentHoverDisabled ?? false);

const emitOldComment = (event: MouseEvent) => {
  if (!props.row.oldLine) return;
  emit('comment', { side: 'old', line: props.row.oldLine, text: props.row.oldText ?? text.value, clientX: event.clientX, clientY: event.clientY });
};

const emitNewComment = (event: MouseEvent) => {
  if (!props.row.newLine) return;
  emit('comment', { side: 'new', line: props.row.newLine, text: props.row.newText ?? text.value, clientX: event.clientX, clientY: event.clientY });
};
</script>

<style scoped lang="scss">
.diff-row {
  position: relative;
  display: grid;
  grid-template-columns: 64px 64px minmax(0, 1fr);
  height: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.025);
  box-sizing: border-box;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
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
  transition: opacity 120ms ease, transform 120ms ease;
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
    content: "";
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

.deleted .line-number,
.deleted :deep(.code) {
  background: #362226;
}

.added .line-number,
.added :deep(.code) {
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
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 24px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
