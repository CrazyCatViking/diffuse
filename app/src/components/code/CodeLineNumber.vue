<template>
  <div class="line-number" :class="side">
    <span>{{ lineNumber ?? '' }}</span>

    <button
      v-if="lineNumber && commentCount > 0 && !commentsExpanded"
      class="collapsed-comment-indicator"
      type="button"
      title="Show collapsed comment"
      aria-label="Show collapsed comment"
      @click="emit('toggleComments')"
    >
      <span class="comment-icon" aria-hidden="true" />
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
import type { LspDiagnostic, SyntaxSide } from '../../lib/protocol';
import DiagnosticMarker from '../diff/DiagnosticMarker.vue';

withDefaults(
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
</script>

<style scoped lang="scss">
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
</style>
