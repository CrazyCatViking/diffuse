<template>
  <div class="rail-entry" :class="{ selected }">
    <button
      :ref="(element) => $emit('register', element as HTMLButtonElement | null)"
      class="workspace-tab"
      type="button"
      role="tab"
      :tabindex="tabindex"
      :aria-selected="selected"
      aria-controls="workbench-content"
      :aria-label="accessibleLabel"
      :title="`${workspace.displayName}\n${workspace.root}`"
      @click="$emit('select')"
      @keydown="$emit('keydown', $event)"
    >
      <span class="workspace-monogram" aria-hidden="true">{{ monogram }}</span>
      <span class="workspace-name">{{ workspace.displayName }}</span>
      <WorkspaceAttentionBadge :state="workspace.state" compact />
    </button>

    <button
      class="close-workspace"
      type="button"
      :aria-label="`Close ${workspace.displayName} workspace`"
      title="Close workspace"
      @click.stop="$emit('close')"
    >
      ×
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { WorkspaceSummary } from '../../lib/workbenchContract';
import WorkspaceAttentionBadge from './WorkspaceAttentionBadge.vue';

const props = defineProps<{ workspace: WorkspaceSummary; selected: boolean; tabindex: number }>();

defineEmits<{
  select: [];
  close: [];
  keydown: [event: KeyboardEvent];
  register: [element: HTMLButtonElement | null];
}>();

const monogram = computed(() => props.workspace.displayName.trim().slice(0, 2).toUpperCase() || 'WS');
const accessibleLabel = computed(
  () => `${props.workspace.displayName}, ${props.workspace.root}, ${props.selected ? 'selected, ' : ''}${props.workspace.state}`,
);
</script>

<style scoped lang="scss">
.rail-entry {
  position: relative;
  display: grid;
  width: 100%;
}

.workspace-tab {
  display: grid;
  gap: var(--space-2);
  place-items: center;
  width: 100%;
  min-height: var(--size-workspace-rail-item);
  padding: var(--space-4) var(--space-2);
  color: var(--color-text-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-3);
  cursor: pointer;

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
  }
}

.selected .workspace-tab {
  color: var(--color-text-primary);
  background: var(--color-bg-selected);
  border-color: var(--color-border-strong);
}

.workspace-monogram {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
  font-family: var(--font-mono);
  font-size: var(--font-size-label);
  font-weight: 800;
}

.workspace-name {
  width: 100%;
  overflow: hidden;
  font-size: var(--font-size-caption);
  font-weight: 700;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.close-workspace {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: none;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  color: var(--color-text-muted);
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-pill);
  cursor: pointer;

  &:focus-visible {
    display: grid;
    outline: 2px solid var(--color-border-focus);
  }
}

.rail-entry:hover .close-workspace,
.rail-entry:focus-within .close-workspace {
  display: grid;
}

@media (max-width: 900px) {
  .workspace-name,
  :deep(.status-label) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
}
</style>
