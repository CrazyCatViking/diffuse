<template>
  <div v-if="showSelectionToolbar" class="selection-toolbar" :style="selectionStyle">
    <button
      type="button"
      title="Comment on selection"
      aria-label="Comment on selection"
      @pointerdown.prevent.stop="emit('commentSelection')"
    >
      <span class="comment-icon" aria-hidden="true" />
    </button>

    <button
      type="button"
      title="Ask AI about selection"
      aria-label="Ask AI about selection"
      @pointerdown.prevent.stop="emit('chatSelection')"
    >
      <span class="ai-icon" aria-hidden="true" />
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
    content: '';
  }
}

.ai-icon {
  position: absolute;
  top: 4px;
  left: 5px;
  width: 12px;
  height: 12px;
  color: #8fb3ff;

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
    box-shadow: 0 0 8px rgba(143, 179, 255, 0.55);
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
  padding: 10px 12px;
  overflow: auto;
  color: #e9eef8;
  background: rgba(12, 16, 24, 0.98);
  border: 1px solid #344159;
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
  pointer-events: none;

  &.loading {
    color: #98a2b3;
  }

  pre {
    margin: 0;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
  }
}
</style>
