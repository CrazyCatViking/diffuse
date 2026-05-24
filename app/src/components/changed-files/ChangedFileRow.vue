<script setup lang="ts">
import type { ChangedFile } from '../../lib/protocol'

defineProps<{
  file: ChangedFile
  active: boolean
}>()

defineEmits<{
  select: [fileId: string]
}>()
</script>

<template>
  <button class="file-row" :class="{ active }" @click="$emit('select', file.id)">
    <span class="status">{{ file.status[0].toUpperCase() }}</span>
    <span class="path">{{ file.newPath ?? file.oldPath ?? file.id }}</span>
    <span class="counts">+{{ file.additions }} -{{ file.deletions }}</span>
  </button>
</template>

<style scoped lang="scss">
.file-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 8px 10px;
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
