<template>
  <div class="diff-scrollbar" @pointerdown="emit('trackPointerDown', $event)">
    <div v-for="marker in markers" :key="marker.key" class="diff-scroll-marker" :class="marker.kind" :style="marker.style" />

    <div class="diff-scroll-thumb" :style="thumbStyle" @pointerdown.stop="emit('thumbPointerDown', $event)" />
  </div>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';

export type DiffScrollMarker = {
  key: string;
  kind: DiffScrollMarkerKind;
  style: CSSProperties;
};

export type DiffScrollMarkerKind =
  | 'added'
  | 'deleted'
  | 'review'
  | 'diagnostic-error'
  | 'diagnostic-warning'
  | 'diagnostic-info'
  | 'analysis-move'
  | 'analysis-semantic'
  | 'analysis-risk'
  | 'analysis-noise'
  | 'search'
  | 'active-search';

defineProps<{
  markers: DiffScrollMarker[];
  thumbStyle: CSSProperties;
}>();

const emit = defineEmits<{
  trackPointerDown: [event: PointerEvent];
  thumbPointerDown: [event: PointerEvent];
}>();
</script>

<style scoped lang="scss">
.diff-scrollbar {
  position: relative;
  grid-column: 2;
  grid-row: 1;
  z-index: 4;
  width: 18px;
  height: 100%;
  background: var(--color-scrollbar-track);
  border-left: 1px solid var(--color-border-subtle);
  cursor: default;
  user-select: none;
}

.diff-scroll-marker {
  position: absolute;
  min-height: 3px;
  opacity: 0.95;
  border-radius: var(--radius-pill);
  pointer-events: none;

  &.added {
    right: 2px;
    width: 5px;
    background: var(--color-success);
  }

  &.deleted {
    left: 2px;
    width: 5px;
    background: var(--color-danger);
  }

  &.review {
    right: 5px;
    left: 5px;
    min-height: 5px;
    background: var(--color-review);
    box-shadow: 0 0 8px rgba(240, 195, 106, 0.24);
  }

  &.diagnostic-error,
  &.diagnostic-warning,
  &.diagnostic-info {
    right: 1px;
    width: 3px;
    min-height: 5px;
  }

  &.diagnostic-error {
    background: var(--color-danger);
  }

  &.diagnostic-warning {
    background: var(--color-warning);
  }

  &.diagnostic-info {
    background: var(--color-info);
  }

  &.analysis-move,
  &.analysis-semantic,
  &.analysis-risk,
  &.analysis-noise {
    left: 7px;
    width: 4px;
    min-height: 5px;
  }

  &.analysis-move {
    background: var(--color-ai);
  }

  &.analysis-semantic {
    background: var(--color-review);
  }

  &.analysis-risk {
    background: var(--color-warning);
    box-shadow: 0 0 8px rgba(240, 184, 106, 0.36);
  }

  &.analysis-noise {
    background: var(--color-text-subtle);
    opacity: 0.72;
  }

  &.search,
  &.active-search {
    right: 4px;
    left: 4px;
    background: rgba(255, 214, 102, 0.56);
  }

  &.active-search {
    right: 2px;
    left: 2px;
    min-height: 6px;
    background: #ffe08a;
    box-shadow: 0 0 10px rgba(255, 224, 138, 0.42);
  }
}

.diff-scroll-thumb {
  position: absolute;
  right: 0;
  left: 0;
  z-index: 1;
  min-height: 24px;
  background: var(--color-scrollbar-thumb);
  transition: background var(--transition-fast);
  will-change: top;

  &:hover {
    background: var(--color-scrollbar-thumb-hover);
  }
}
</style>
