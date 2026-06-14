<template>
  <button class="file-row" :class="{ active }" :style="{ '--depth': depth }" @click="$emit('select', file.id)">
    <span class="status">{{ file.status[0].toUpperCase() }}</span>
    <span class="path" :title="file.newPath ?? file.oldPath ?? file.id">{{ name }}</span>
    <span class="counts">+{{ file.additions }} -{{ file.deletions }}</span>
  </button>
</template>

<script setup lang="ts">
import type { ChangedFile } from '../../lib/protocol';

defineProps<{
  file: ChangedFile;
  active: boolean;
  name: string;
  depth: number;
}>();

defineEmits<{
  select: [fileId: string];
}>();
</script>

<style scoped lang="scss">
.file-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 8px 10px 8px calc(10px + (var(--depth) * 16px));
  color: #cbd5e1;
  background: transparent;
  border: 0;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;

  &:hover,
  &.active {
    background: #202635;
  }
}

.status {
  color: #9fb4ff;
  font-size: 12px;
  font-weight: 700;
}

.path {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.counts {
  color: #8b95a7;
  font-size: 12px;
}
</style>
