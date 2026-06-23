<template>
  <div v-if="row.kind === 'hunk'" class="diff-row hunk" :class="mode">
    <div class="hunk-text">{{ row.hunkHeader ?? row.text }}</div>
  </div>
  <div v-else class="diff-row" :class="[row.kind, mode, { 'comment-hover-disabled': commentHoverDisabled }]">
    <template v-if="mode === 'neutral'">
      <LineNumber
        side="old"
        :line="row.oldLine"
        :comment-count="oldCommentCount"
        :comments-expanded="oldCommentsExpanded"
        :diagnostics="oldDiagnostics"
        title="Add old-side comment"
        @comment="emitOldComment"
        @toggle-comments="emitToggleComments"
      />
      <LineNumber
        side="new"
        :line="row.newLine"
        :comment-count="newCommentCount"
        :comments-expanded="newCommentsExpanded"
        :diagnostics="newDiagnostics"
        title="Add new-side comment"
        @comment="emitNewComment"
        @toggle-comments="emitToggleComments"
      />
      <HighlightedCode
        :text="neutralText"
        :spans="syntaxSpans ?? neutralRowSpans"
        :review-highlights="reviewHighlights"
        :search-highlights="searchHighlights"
        :data-review-side="neutralSelectionSide"
        :data-review-line="neutralSelectionLine"
        :data-review-file-id="fileId"
        :data-review-text="neutralText"
      />
    </template>
    <template v-else>
      <LineNumber
        :side="mode"
        :line="sideLine"
        :comment-count="sideCommentCount"
        :comments-expanded="sideCommentsExpanded"
        :diagnostics="diagnostics"
        title="Add comment"
        @comment="emitSideComment"
        @toggle-comments="emitToggleComments"
      />
      <HighlightedCode
        :text="sideText"
        :spans="syntaxSpans ?? sideRowSpans"
        :review-highlights="reviewHighlights"
        :search-highlights="searchHighlights"
        :data-review-side="mode"
        :data-review-line="sideLine"
        :data-review-file-id="fileId"
        :data-review-text="sideText"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, type PropType } from 'vue';
import type { DiffRow, LspDiagnostic, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import DiagnosticMarker from './DiagnosticMarker.vue';
import HighlightedCode, { type ReviewTextHighlight, type SearchTextHighlight } from './HighlightedCode.vue';

const props = withDefaults(
  defineProps<{
    mode: SyntaxSide | 'neutral';
    row: DiffRow;
    fileId?: string;
    syntaxSpans?: SyntaxSpan[];
    oldCommentCount?: number;
    newCommentCount?: number;
    oldCommentsExpanded?: boolean;
    newCommentsExpanded?: boolean;
    reviewHighlights?: ReviewTextHighlight[];
    searchHighlights?: SearchTextHighlight[];
    oldDiagnostics?: LspDiagnostic[];
    newDiagnostics?: LspDiagnostic[];
    commentHoverDisabled?: boolean;
  }>(),
  {
    oldCommentCount: 0,
    newCommentCount: 0,
    oldCommentsExpanded: false,
    newCommentsExpanded: false,
    oldDiagnostics: () => [],
    newDiagnostics: () => [],
    commentHoverDisabled: false,
  },
);

const emit = defineEmits<{
  comment: [payload: { side: SyntaxSide; line: number; text: string; clientX: number; clientY: number }];
  toggleComments: [payload: { side: SyntaxSide; line: number }];
}>();

const sideLine = computed(() => (props.mode === 'old' ? props.row.oldLine : props.row.newLine));
const sideText = computed(() => (props.mode === 'old' ? (props.row.oldText ?? '') : (props.row.newText ?? '')));
const sideRowSpans = computed(() => (props.mode === 'old' ? props.row.oldSyntaxSpans : props.row.newSyntaxSpans));
const sideCommentCount = computed(() => (props.mode === 'old' ? props.oldCommentCount : props.newCommentCount));
const sideCommentsExpanded = computed(() => (props.mode === 'old' ? props.oldCommentsExpanded : props.newCommentsExpanded));
const diagnostics = computed(() => (props.mode === 'old' ? props.oldDiagnostics : props.newDiagnostics));
const neutralSelectionSide = computed<SyntaxSide>(() => (props.row.kind === 'deleted' ? 'old' : 'new'));
const neutralSelectionLine = computed(() => (neutralSelectionSide.value === 'old' ? props.row.oldLine : props.row.newLine));
const neutralText = computed(() => props.row.oldText ?? props.row.newText ?? props.row.text ?? '');
const neutralRowSpans = computed(() => (props.row.kind === 'deleted' ? props.row.oldSyntaxSpans : props.row.newSyntaxSpans));

const emitSideComment = (event: MouseEvent) => {
  if (props.mode === 'neutral' || !sideLine.value) return;
  emit('comment', { side: props.mode, line: sideLine.value, text: sideText.value, clientX: event.clientX, clientY: event.clientY });
};

const emitOldComment = (event: MouseEvent) => {
  if (!props.row.oldLine) return;
  emit('comment', {
    side: 'old',
    line: props.row.oldLine,
    text: props.row.oldText ?? neutralText.value,
    clientX: event.clientX,
    clientY: event.clientY,
  });
};

const emitNewComment = (event: MouseEvent) => {
  if (!props.row.newLine) return;
  emit('comment', {
    side: 'new',
    line: props.row.newLine,
    text: props.row.newText ?? neutralText.value,
    clientX: event.clientX,
    clientY: event.clientY,
  });
};

const emitToggleComments = (payload: { side: SyntaxSide; line: number }) => {
  emit('toggleComments', payload);
};

const LineNumber = defineComponent({
  props: {
    side: { type: String as PropType<SyntaxSide>, required: true },
    line: Number,
    commentCount: { type: Number, required: true },
    commentsExpanded: { type: Boolean, required: true },
    diagnostics: { type: Array as PropType<LspDiagnostic[]>, required: true },
    title: { type: String, required: true },
  },
  emits: ['comment', 'toggleComments'],
  setup(lineProps, { emit: lineEmit }) {
    return () =>
      h('div', { class: ['line-number', lineProps.side] }, [
        h('span', lineProps.line ?? ''),
        lineProps.line && lineProps.commentCount > 0 && !lineProps.commentsExpanded
          ? h(
              'button',
              {
                class: 'collapsed-comment-indicator',
                type: 'button',
                title: 'Show collapsed comment',
                'aria-label': 'Show collapsed comment',
                onClick: () => lineEmit('toggleComments', { side: lineProps.side, line: lineProps.line }),
              },
              [h('span', { class: 'comment-icon', 'aria-hidden': 'true' })],
            )
          : undefined,
        lineProps.line && lineProps.commentCount === 0
          ? h(
              'button',
              {
                class: 'comment-bubble',
                type: 'button',
                title: lineProps.title,
                'aria-label': lineProps.title,
                onClick: (event: MouseEvent) => lineEmit('comment', event),
              },
              [h('span', { class: 'comment-icon', 'aria-hidden': 'true' })],
            )
          : undefined,
        h(DiagnosticMarker, { diagnostics: lineProps.diagnostics }),
      ]);
  },
});
</script>

<style scoped lang="scss">
.diff-row {
  position: relative;
  display: grid;
  height: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.025);
  box-sizing: border-box;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 24px;

  &.old,
  &.new {
    grid-template-columns: 64px minmax(0, 1fr);
  }

  &.neutral {
    grid-template-columns: 64px 64px minmax(0, 1fr);
  }
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
  padding: 0;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
}

.comment-bubble {
  opacity: 0;
  transform: translateX(-4px);
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.diff-row:hover:not(.comment-hover-disabled) .comment-bubble,
.comment-bubble:focus-visible {
  opacity: 1;
  transform: translateX(0);
}

.comment-icon {
  position: absolute;
  top: 4px;
  left: 4px;
  width: 10px;
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
    content: '';
  }
}

.collapsed-comment-indicator .comment-icon {
  border-color: #8fb3ff;

  &::after {
    border-color: #8fb3ff;
  }
}

.diff-row.added {
  background: rgba(63, 185, 80, 0.1);
}

.diff-row.deleted {
  background: rgba(248, 81, 73, 0.1);
}

.diff-row.context {
  background: #111318;
}

.diff-row.hunk {
  display: block;
  height: 28px;
  color: #8fb3ff;
  background: #101827;
  border-top: 1px solid #26334a;
  border-bottom: 1px solid #26334a;
  line-height: 28px;
}

.hunk-text {
  padding: 0 14px;
  font-weight: 600;
}
</style>
