<template>
  <div
    class="file-row"
    :class="{ active, reviewed }"
    :style="{ '--depth': depth }"
    role="button"
    tabindex="0"
    @click="$emit('select', file.id)"
    @keydown.enter="$emit('select', file.id)"
    @keydown.space.prevent="$emit('select', file.id)"
  >
    <input
      class="review-checkbox"
      type="checkbox"
      :checked="reviewed"
      :title="reviewed ? 'Mark file unreviewed' : 'Mark file reviewed'"
      :aria-label="reviewed ? 'Mark file unreviewed' : 'Mark file reviewed'"
      @click.stop
      @change="$emit('setReviewed', { fileId: file.id, reviewed: ($event.target as HTMLInputElement).checked })"
    />

    <span class="status" :class="statusClass">{{ statusLabel }}</span>

    <span class="path" :title="file.newPath ?? file.oldPath ?? file.id">{{ name }}</span>

    <span class="counts">
      <span class="additions">+{{ file.additions }}</span>

      <span class="deletions">-{{ file.deletions }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ChangedFile } from '../../lib/protocol';

const props = defineProps<{
  file: ChangedFile;
  active: boolean;
  reviewed: boolean;
  name: string;
  depth: number;
}>();

const statusLabel = computed(() => {
  return {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  }[props.file.status];
});

const statusClass = computed(() => `status-${props.file.status}`);

defineEmits<{
  select: [fileId: string];
  setReviewed: [payload: { fileId: string; reviewed: boolean }];
}>();
</script>

<style scoped lang="scss">
.file-row {
  display: grid;
  grid-template-columns: 16px calc(22px + (var(--depth) * 16px)) minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: center;
  width: 100%;
  padding: var(--space-4) var(--space-5);
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-3);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);

  &:hover {
    background: var(--color-bg-hover);
  }

  &.active {
    background: var(--color-bg-active);
    border-color: var(--color-border-default);
  }
}

.file-row.reviewed .path {
  color: var(--color-success);
}

.status {
  display: inline-grid;
  place-items: center;
  justify-self: end;
  width: 20px;
  height: 20px;
  color: var(--color-text-muted);
  background: rgba(143, 151, 166, 0.1);
  border: 1px solid rgba(143, 151, 166, 0.18);
  border-radius: var(--radius-2);
  font-size: var(--font-size-caption);
  font-weight: 700;
}

.status-added {
  color: var(--color-success);
  background: var(--color-success-muted);
  border-color: rgba(91, 184, 119, 0.25);
}

.status-modified,
.status-renamed {
  color: var(--color-ai);
  background: var(--color-ai-muted);
  border-color: rgba(143, 179, 255, 0.25);
}

.status-deleted {
  color: var(--color-danger);
  background: var(--color-danger-muted);
  border-color: rgba(255, 107, 107, 0.25);
}

.review-checkbox {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.path {
  overflow: hidden;
  font-size: var(--font-size-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.counts {
  display: inline-flex;
  gap: var(--space-3);
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
}

.additions {
  color: var(--color-success);
}

.deletions {
  color: var(--color-danger);
}
</style>
