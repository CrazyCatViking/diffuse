<template>
  <div v-if="showSelectionToolbar" class="selection-toolbar" :style="selectionStyle">
    <span class="selection-toolbar-label">Review selection</span>

    <button
      type="button"
      title="Comment on selection"
      aria-label="Comment on selection"
      @pointerdown.prevent.stop="emit('commentSelection')"
    >
      <span class="comment-icon" aria-hidden="true" />

      <span>Comment</span>
    </button>

    <button
      type="button"
      title="Ask AI about selection"
      aria-label="Ask AI about selection"
      @pointerdown.prevent.stop="emit('chatSelection')"
    >
      <span class="ai-icon" aria-hidden="true" />

      <span>Ask AI</span>
    </button>
  </div>

  <div v-if="lspHover.visible" class="lsp-hover" :class="{ loading: lspHover.loading }" :style="lspHoverStyle">
    <div v-if="lspHover.loading">Loading hover...</div>

    <pre v-else>{{ lspHover.contents }}</pre>
  </div>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';

defineProps<{
  showSelectionToolbar: boolean;
  selectionStyle: CSSProperties;
  lspHover: {
    visible: boolean;
    loading: boolean;
    contents: string;
  };
  lspHoverStyle: CSSProperties;
}>();

const emit = defineEmits<{
  commentSelection: [];
  chatSelection: [];
}>();
</script>

<style scoped lang="scss">
.selection-toolbar {
  position: absolute;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  color: var(--color-text-secondary);
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  box-shadow: var(--shadow-popover);
}

.selection-toolbar-label {
  padding: 0 var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
  font-weight: 650;
  white-space: nowrap;
}

.selection-toolbar button {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 28px;
  padding: 0 var(--space-4) 0 28px;
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
  cursor: pointer;
  font: inherit;
  font-size: var(--font-size-label);
  font-weight: 650;
  white-space: nowrap;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);

  &:hover {
    background: var(--color-review-muted);
    border-color: rgba(240, 195, 106, 0.32);
  }

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.comment-icon {
  position: absolute;
  top: 8px;
  left: 10px;
  width: 11px;
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

.ai-icon {
  position: absolute;
  top: 7px;
  left: 10px;
  width: 12px;
  height: 12px;
  color: var(--color-ai);

  &::before,
  &::after {
    position: absolute;
    content: '';
    background: currentColor;
  }

  &::before {
    top: 0;
    left: 5px;
    width: 2px;
    height: 12px;
    border-radius: 999px;
    box-shadow: 0 0 8px var(--color-ai-muted);
  }

  &::after {
    top: 5px;
    left: 0;
    width: 12px;
    height: 2px;
    border-radius: 999px;
    transform: rotate(45deg);
  }
}

.lsp-hover {
  position: fixed;
  z-index: 20;
  max-width: 420px;
  max-height: 260px;
  padding: var(--space-5) var(--space-6);
  overflow: auto;
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  box-shadow: var(--shadow-popover);
  pointer-events: none;

  &.loading {
    color: var(--color-text-muted);
  }

  pre {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--font-size-label);
    line-height: 1.45;
    white-space: pre-wrap;
  }
}
</style>
