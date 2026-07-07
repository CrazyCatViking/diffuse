<template>
  <CodeHunkRow v-if="row.kind === 'hunk'" :text="row.hunkText ?? ''" :mode="mode" />

  <div
    v-else-if="mode === 'neutral' && row.inlineLine"
    class="diff-row neutral"
    :class="[row.kind, row.inlineLine.className, { 'comment-hover-disabled': commentHoverDisabled }]"
    :title="row.inlineLine.explanation"
  >
    <CodeLineNumber
      side="old"
      :line-number="row.oldLine?.lineNumber"
      :comment-count="row.oldLine?.commentCount ?? 0"
      :comments-expanded="row.oldLine?.commentsExpanded ?? false"
      :diagnostics="row.oldLine?.diagnostics ?? []"
      title="Add old-side comment"
      @comment="emitLineComment(row.oldLine, $event)"
      @toggle-comments="emitToggleComments(row.oldLine)"
    />

    <CodeLineNumber
      side="new"
      :line-number="row.newLine?.lineNumber"
      :comment-count="row.newLine?.commentCount ?? 0"
      :comments-expanded="row.newLine?.commentsExpanded ?? false"
      :diagnostics="row.newLine?.diagnostics ?? []"
      title="Add new-side comment"
      @comment="emitLineComment(row.newLine, $event)"
      @toggle-comments="emitToggleComments(row.newLine)"
    />

    <CodeText
      :text="row.inlineLine.text"
      :spans="row.inlineLine.syntaxSpans"
      :highlights="row.inlineLine.highlights"
      :data-review-side="row.inlineLine.side"
      :data-review-line="row.inlineLine.lineNumber"
      :data-review-file-id="row.inlineLine.fileId"
      :data-review-text="row.inlineLine.text"
    />
  </div>

  <CodeLine
    v-else-if="sideLine"
    :line="sideLine"
    :kind="sideKind"
    :mode="mode"
    :comment-hover-disabled="commentHoverDisabled"
    @comment="emit('comment', $event)"
    @toggle-comments="emit('toggleComments', $event)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SyntaxSide } from '../../lib/protocol';
import CodeHunkRow from '../code/CodeHunkRow.vue';
import CodeLine from '../code/CodeLine.vue';
import CodeLineNumber from '../code/CodeLineNumber.vue';
import CodeText from '../code/CodeText.vue';
import type { CodeLineCommentPayload, CodeLineModel, CodeLineToggleCommentsPayload } from '../code/codeModels';
import type { DiffCodeRowModel } from './diffViewModels';

const props = withDefaults(
  defineProps<{
    mode: SyntaxSide | 'neutral';
    row: DiffCodeRowModel;
    commentHoverDisabled?: boolean;
  }>(),
  {
    commentHoverDisabled: false,
  },
);

const emit = defineEmits<{
  comment: [payload: CodeLineCommentPayload];
  toggleComments: [payload: CodeLineToggleCommentsPayload];
}>();

const sideLine = computed(() => (props.mode === 'old' ? props.row.oldLine : props.mode === 'new' ? props.row.newLine : undefined));

const sideKind = computed(() => {
  if (props.row.kind === 'modified' && props.mode === 'old') return 'deleted';
  if (props.row.kind === 'modified' && props.mode === 'new') return 'added';
  if (props.mode === 'old' && props.row.kind === 'added') return 'context';
  if (props.mode === 'new' && props.row.kind === 'deleted') return 'context';
  return props.row.kind;
});

const emitLineComment = (line: CodeLineModel | undefined, event: MouseEvent) => {
  if (!line?.side || !line.lineNumber) return;
  emit('comment', { side: line.side, line: line.lineNumber, text: line.text, clientX: event.clientX, clientY: event.clientY });
};

const emitToggleComments = (line: CodeLineModel | undefined) => {
  if (!line?.side || !line.lineNumber) return;
  emit('toggleComments', { side: line.side, line: line.lineNumber });
};
</script>

<style scoped lang="scss">
.diff-row {
  position: relative;
  display: grid;
  height: var(--line-height-code);
  border-bottom: 1px solid var(--color-border-hairline);
  box-sizing: border-box;
  font-family: var(--font-mono);
  font-size: var(--font-size-label);
  line-height: var(--line-height-code);

  &.neutral {
    grid-template-columns: 64px 64px minmax(0, 1fr);
  }
}

.diff-row.added {
  background: var(--color-diff-added-bg);
}

.diff-row.deleted {
  background: var(--color-diff-deleted-bg);
}

.diff-row.context {
  background: var(--color-bg-code);
}

.diff-row.modified {
  background: var(--color-bg-code);
}

.diff-row.cursor-line,
:global(.code-line.cursor-line) {
  box-shadow: inset 3px 0 0 var(--color-border-focus);
}

.diff-row.diff-moved {
  box-shadow: inset 3px 0 0 var(--color-info);
}

.diff-row.diff-moved-from {
  box-shadow: inset 3px 0 0 var(--color-warning);
}

.diff-row.diff-moved-to {
  box-shadow: inset 3px 0 0 var(--color-info);
}

.diff-row.diff-analysis-semantic {
  box-shadow: inset 2px 0 0 var(--color-review);
}

.diff-row.diff-analysis-risk {
  box-shadow:
    inset 2px 0 0 var(--color-warning),
    inset 0 0 0 999px rgba(240, 184, 106, 0.035);
}

.diff-row.diff-analysis-noise {
  opacity: 0.82;
}

.diff-row.diff-moved-from {
  box-shadow: inset 3px 0 0 var(--color-warning);
}

.diff-row.diff-moved-to {
  box-shadow: inset 3px 0 0 var(--color-info);
}
</style>
