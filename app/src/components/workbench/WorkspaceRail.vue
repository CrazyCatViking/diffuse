<template>
  <nav class="workspace-rail" aria-label="Workspaces">
    <div class="rail-actions">
      <button class="rail-utility" type="button" aria-label="Open workspace" title="Open workspace" @click="$emit('open')">+</button>
    </div>

    <div class="workspace-tabs" role="tablist" aria-orientation="vertical">
      <button
        :ref="(element) => registerTab(0, element as HTMLButtonElement | null)"
        class="overview-tab"
        type="button"
        role="tab"
        :tabindex="overviewSelected ? 0 : -1"
        :aria-selected="overviewSelected"
        aria-controls="workbench-content"
        aria-label="Workbench overview"
        title="Workbench overview"
        @click="$emit('overview')"
        @keydown="handleTabKeydown($event, 0)"
      >
        <span aria-hidden="true">⌂</span>
        <span class="utility-label">Overview</span>
      </button>

      <WorkspaceRailItem
        v-for="(workspace, index) in workspaces"
        :key="workspace.workspaceId"
        :workspace="workspace"
        :selected="workspace.workspaceId === activeWorkspaceId"
        :tabindex="workspace.workspaceId === activeWorkspaceId ? 0 : -1"
        @register="registerTab(index + 1, $event)"
        @select="$emit('select', workspace.workspaceId)"
        @close="requestClose(workspace.workspaceId, index)"
        @keydown="handleTabKeydown($event, index + 1)"
      />
    </div>

    <button class="rail-utility switcher" type="button" aria-label="All workspaces" title="All workspaces" @click="$emit('switch')">
      <span aria-hidden="true">⌕</span>
      <span class="utility-label">All</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { nextTick } from 'vue';
import type { WorkspaceSummary } from '../../lib/workbenchContract';
import WorkspaceRailItem from './WorkspaceRailItem.vue';

const props = defineProps<{ workspaces: WorkspaceSummary[]; activeWorkspaceId: string | null; overviewSelected: boolean }>();

const emit = defineEmits<{
  overview: [];
  open: [];
  switch: [];
  select: [workspaceId: string];
  close: [workspaceId: string];
}>();

const tabElements: (HTMLButtonElement | null)[] = [];

const registerTab = (index: number, element: HTMLButtonElement | null) => {
  tabElements[index] = element;
};

const requestClose = async (workspaceId: string, workspaceIndex: number) => {
  emit('close', workspaceId);
  await nextTick();
  await nextTick();
  tabElements[Math.min(workspaceIndex + 1, props.workspaces.length)]?.focus();
};

const handleTabKeydown = (event: KeyboardEvent, index: number) => {
  let target = index;
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') target = (index + 1) % (props.workspaces.length + 1);
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
    target = (index - 1 + props.workspaces.length + 1) % (props.workspaces.length + 1);
  else if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = props.workspaces.length;
  else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (index === 0) emit('overview');
    else emit('select', props.workspaces[index - 1].workspaceId);
    return;
  } else return;

  event.preventDefault();
  tabElements[target]?.focus();
};
</script>

<style scoped lang="scss">
.workspace-rail {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: var(--space-4);
  width: var(--size-workspace-rail);
  min-height: 0;
  padding: var(--space-4);
  background: var(--color-bg-shell);
  border-right: 1px solid var(--color-border-subtle);
}

.workspace-tabs {
  display: grid;
  gap: var(--space-3);
  align-content: start;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
}

.rail-actions {
  display: grid;
}

.overview-tab,
.rail-utility {
  display: grid;
  gap: var(--space-2);
  place-items: center;
  min-height: 46px;
  padding: var(--space-3);
  color: var(--color-text-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-3);
  cursor: pointer;
  font-size: var(--font-size-body-lg);

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
  }
}

.overview-tab[aria-selected='true'] {
  color: var(--color-text-primary);
  background: var(--color-bg-selected);
  border-color: var(--color-border-strong);
}

.utility-label {
  font-size: var(--font-size-caption);
  font-weight: 700;
}

@media (max-width: 900px) {
  .workspace-rail {
    width: var(--size-workspace-rail-narrow);
    padding-inline: var(--space-2);
  }

  .utility-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
}
</style>
