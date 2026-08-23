<template>
  <span class="workspace-status" :class="`status-${state}`">
    <span class="status-dot" aria-hidden="true" />
    <span class="status-label">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { WorkspaceLoadState } from '../../lib/workbenchContract';

const props = defineProps<{ state: WorkspaceLoadState; compact?: boolean }>();

const label = computed(() => {
  if (props.compact && props.state === 'ready') return 'Ready';
  if (props.state === 'opening') return 'Opening';
  if (props.state === 'closing') return 'Closing';
  if (props.state === 'closed') return 'Closed';
  return 'Ready';
});
</script>

<style scoped lang="scss">
.workspace-status {
  display: inline-flex;
  gap: var(--space-3);
  align-items: center;
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-caption);
}

.status-dot {
  flex: 0 0 auto;
  width: var(--size-workspace-status);
  height: var(--size-workspace-status);
  background: var(--color-success);
  border-radius: var(--radius-pill);
}

.status-opening .status-dot,
.status-closing .status-dot {
  background: var(--color-info);
}

.status-closed .status-dot {
  background: var(--color-text-disabled);
}

.status-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
