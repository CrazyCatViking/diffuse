<template>
  <div class="file-row" :class="{ active, reviewed }" :style="{ '--depth': depth }" role="button" tabindex="0" @click="$emit('select', file.id)" @keydown.enter="$emit('select', file.id)" @keydown.space.prevent="$emit('select', file.id)">
    <input
      class="review-checkbox"
      type="checkbox"
      :checked="reviewed"
      :title="reviewed ? 'Mark file unreviewed' : 'Mark file reviewed'"
      :aria-label="reviewed ? 'Mark file unreviewed' : 'Mark file reviewed'"
      @click.stop
      @change="$emit('setReviewed', { fileId: file.id, reviewed: ($event.target as HTMLInputElement).checked })"
    />
    <span class="status">{{ file.status[0].toUpperCase() }}</span>
    <span class="path" :title="file.newPath ?? file.oldPath ?? file.id">{{ name }}</span>
    <span class="counts">+{{ file.additions }} -{{ file.deletions }}</span>
  </div>
</template>

<script setup lang="ts">
import type { ChangedFile } from '../../lib/protocol';

defineProps<{
  file: ChangedFile;
  active: boolean;
  reviewed: boolean;
  name: string;
  depth: number;
}>();

defineEmits<{
  select: [fileId: string];
  setReviewed: [payload: { fileId: string; reviewed: boolean }];
}>();
</script>

<style scoped lang="scss">
.file-row {
  display: grid;
  grid-template-columns: 16px calc(22px + (var(--depth) * 16px)) minmax(0, 1fr) auto;
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

.file-row.reviewed .path {
  color: #92d6a4;
}

.status {
  justify-self: end;
  color: #9fb4ff;
  font-size: 12px;
  font-weight: 700;
}

.review-checkbox {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: #4b7bec;
  cursor: pointer;
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
