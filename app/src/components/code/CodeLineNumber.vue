<template>
  <div class="line-number" :class="side">
    <span>{{ lineNumber ?? '' }}</span>

    <button
      v-if="lineNumber && commentCount > 0 && !commentsExpanded"
      class="collapsed-comment-indicator"
      type="button"
      :title="collapsedCommentLabel"
      :aria-label="collapsedCommentLabel"
      @click="emit('toggleComments')"
    >
      <span class="comment-icon" aria-hidden="true" />

      <span class="comment-count">{{ collapsedCommentCountLabel }}</span>
    </button>

    <button
      v-else-if="lineNumber && commentable && commentCount === 0"
      class="comment-bubble"
      type="button"
      :title="title"
      :aria-label="title"
      @click="emit('comment', $event)"
    >
      <span class="comment-icon" aria-hidden="true" />
    </button>

    <DiagnosticMarker :diagnostics="diagnostics" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { LspDiagnostic, SyntaxSide } from '../../lib/protocol';
import DiagnosticMarker from '../diff/DiagnosticMarker.vue';

const props = withDefaults(
  defineProps<{
    side?: SyntaxSide;
    lineNumber?: number;
    commentCount?: number;
    commentsExpanded?: boolean;
    diagnostics?: LspDiagnostic[];
    commentable?: boolean;
    title?: string;
  }>(),
  {
    commentCount: 0,
    commentsExpanded: false,
    diagnostics: () => [],
    commentable: true,
    title: 'Add comment',
  },
);

const emit = defineEmits<{
  comment: [event: MouseEvent];
  toggleComments: [];
}>();

const collapsedCommentLabel = computed(() => {
  return props.commentCount === 1 ? 'Show 1 collapsed comment' : `Show ${props.commentCount} collapsed comments`;
});
const collapsedCommentCountLabel = computed(() => (props.commentCount > 99 ? '99+' : String(props.commentCount)));
</script>

<style scoped lang="scss">
.line-number {
  position: relative;
  padding: 0 var(--space-5) 0 var(--space-10);
  color: var(--color-text-disabled);
  background: var(--color-bg-line-number);
  border-right: 1px solid var(--color-border-subtle);
  text-align: right;
  user-select: none;
}

.comment-bubble,
.collapsed-comment-indicator {
  position: absolute;
  top: 3px;
  left: 8px;
  z-index: 2;
  height: 18px;
  padding: 0;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
}

.comment-bubble {
  width: 20px;
  opacity: 0;
  transform: translateX(-4px);
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.collapsed-comment-indicator {
  top: 2px;
  left: 6px;
  width: 24px;
  height: 20px;
}

:global(.code-line:hover:not(.comment-hover-disabled)) .comment-bubble,
:global(.diff-row:hover:not(.comment-hover-disabled)) .comment-bubble,
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
  border: 2px solid var(--color-review);
  border-radius: 5px;

  &::after {
    position: absolute;
    right: -2px;
    bottom: -5px;
    width: 4px;
    height: 4px;
    border-right: 2px solid var(--color-review);
    border-bottom: 2px solid var(--color-review);
    content: '';
  }
}

.collapsed-comment-indicator .comment-icon {
  top: 3px;
  left: 2px;
  border-color: var(--color-review);

  &::after {
    border-color: var(--color-review);
  }
}

.comment-count {
  position: absolute;
  top: 1px;
  right: 0;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  color: var(--color-bg-code);
  background: var(--color-review);
  border-radius: var(--radius-pill);
  font-family: var(--font-ui);
  font-size: 9px;
  font-weight: 800;
  line-height: 14px;
  text-align: center;
  box-sizing: border-box;
}
</style>
