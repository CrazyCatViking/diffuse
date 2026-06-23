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
  background: #151923;
  border-left: 1px solid #252a35;
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
    background: rgba(60, 179, 113, 0.16);
  }

  &.deleted {
    left: 0;
    background: rgba(255, 99, 99, 0.16);
  }
}

.diff-scroll-thumb {
  position: absolute;
  right: 0;
  left: 0;
  z-index: 1;
  min-height: 24px;
  background: rgba(152, 162, 179, 0.42);
  transition: background 120ms ease;
  will-change: top;

  &:hover {
    background: rgba(174, 183, 198, 0.58);
  }
}
</style>
