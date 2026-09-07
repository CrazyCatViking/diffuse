<template>
  <span class="workspace-status" :aria-label="accessibleLabel">
    <span class="attention-status" :class="`attention-${attention.state}`">
      <span class="status-symbol" aria-hidden="true">{{ symbol }}</span>
      <span class="status-label">{{ label }}</span>
      <span v-if="relevantCount > 0" class="status-count">{{ relevantCount }}</span>
    </span>

    <span v-if="state === 'degraded'" class="load-health">Degraded</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { WorkspaceAttentionSummary, WorkspaceLoadState } from '../../lib/workbenchContract';

const props = defineProps<{ attention: WorkspaceAttentionSummary; state: WorkspaceLoadState; compact?: boolean }>();

const relevantCount = computed(() => {
  if (props.attention.state === 'input-required') return props.attention.inputRequired;
  if (props.attention.state === 'error') return props.attention.errors;
  if (props.attention.state === 'unread') return props.attention.unread;
  if (props.attention.state === 'running') return props.attention.running;
  return 0;
});
const label = computed(() => {
  if (props.attention.state === 'input-required') return 'Needs input';
  if (props.attention.state === 'error') return 'Error';
  if (props.attention.state === 'unread') return 'Unread';
  if (props.attention.state === 'running') return 'Running';
  if (props.state === 'opening') return 'Opening';
  if (props.state === 'closing') return 'Closing';
  if (props.state === 'closed') return 'Closed';
  return 'Ready';
});
const symbol = computed(() => {
  if (props.attention.state === 'input-required') return '?';
  if (props.attention.state === 'error') return '!';
  if (props.attention.state === 'unread') return '•';
  if (props.attention.state === 'running') return '↻';
  return '✓';
});
const accessibleLabel = computed(() => {
  const counts = [
    `${props.attention.inputRequired} input required`,
    `${props.attention.errors} errors`,
    `${props.attention.unread} unread`,
    `${props.attention.running} running`,
  ].join(', ');
  return `${label.value}, ${counts}${props.state === 'degraded' ? ', load health degraded' : ''}`;
});
</script>

<style scoped lang="scss">
.workspace-status,
.attention-status {
  display: inline-flex;
  gap: var(--space-2);
  align-items: center;
  min-width: 0;
}

.workspace-status {
  flex-wrap: wrap;
  color: var(--color-text-muted);
  font-size: var(--font-size-caption);
}

.status-symbol {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  width: 16px;
  height: 16px;
  color: var(--color-success);
  background: var(--color-success-muted);
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 900;
}

.attention-input-required .status-symbol {
  color: var(--color-warning);
  background: var(--color-warning-muted);
}

.attention-error .status-symbol {
  color: var(--color-danger);
  background: var(--color-danger-muted);
}

.attention-unread .status-symbol,
.attention-running .status-symbol {
  color: var(--color-info);
  background: var(--color-info-muted);
}

.status-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-count,
.load-health {
  font-weight: 800;
}

.load-health {
  color: var(--color-danger);
}
</style>
