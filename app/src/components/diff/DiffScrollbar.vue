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
  kind: 'added' | 'deleted';
  style: CSSProperties;
};

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
  width: 50%;
  min-height: 2px;
  opacity: 0.95;

  &.added {
    right: 0;
    background: var(--color-diff-added-bg);
  }

  &.deleted {
    left: 0;
    background: var(--color-diff-deleted-bg);
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
