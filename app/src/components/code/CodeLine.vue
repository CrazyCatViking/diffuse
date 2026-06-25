<template>
  <div :class="['code-line', kind, mode, line.className, { 'comment-hover-disabled': commentHoverDisabled }]">
    <CodeLineNumber
      :side="line.side"
      :line-number="line.lineNumber"
      :comment-count="line.commentCount ?? 0"
      :comments-expanded="line.commentsExpanded ?? false"
      :diagnostics="line.diagnostics ?? []"
      :commentable="line.commentable ?? true"
      :title="line.title ?? 'Add comment'"
      @comment="emitComment"
      @toggle-comments="emitToggleComments"
    />

    <CodeText
      :text="line.text"
      :spans="line.syntaxSpans"
      :highlights="line.highlights"
      :data-review-side="selectableSide"
      :data-review-line="selectableLine"
      :data-review-file-id="selectableFileId"
      :data-review-text="selectableText"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import CodeLineNumber from './CodeLineNumber.vue';
import CodeText from './CodeText.vue';
import type { CodeLineCommentPayload, CodeLineModel, CodeLineToggleCommentsPayload } from './codeModels';

const props = withDefaults(
  defineProps<{
    line: CodeLineModel;
    kind?: string;
    mode?: string;
    commentHoverDisabled?: boolean;
  }>(),
  {
    kind: 'context',
    mode: undefined,
    commentHoverDisabled: false,
  },
);

const emit = defineEmits<{
  comment: [payload: CodeLineCommentPayload];
  toggleComments: [payload: CodeLineToggleCommentsPayload];
}>();

const isSelectable = computed(() => props.line.selectable !== false && props.line.side && props.line.lineNumber);
const selectableSide = computed(() => (isSelectable.value ? props.line.side : undefined));
const selectableLine = computed(() => (isSelectable.value ? props.line.lineNumber : undefined));
const selectableFileId = computed(() => (isSelectable.value ? props.line.fileId : undefined));
const selectableText = computed(() => (isSelectable.value ? props.line.text : undefined));

const emitComment = (event: MouseEvent) => {
  if (!props.line.side || !props.line.lineNumber) return;
  emit('comment', { side: props.line.side, line: props.line.lineNumber, text: props.line.text, clientX: event.clientX, clientY: event.clientY });
};

const emitToggleComments = () => {
  if (!props.line.side || !props.line.lineNumber) return;
  emit('toggleComments', { side: props.line.side, line: props.line.lineNumber });
};
</script>

<style scoped lang="scss">
.code-line {
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
}

.code-line.added {
  background: rgba(63, 185, 80, 0.1);
}

.code-line.deleted {
  background: rgba(248, 81, 73, 0.1);
}

.code-line.context {
  background: #111318;
}
</style>
