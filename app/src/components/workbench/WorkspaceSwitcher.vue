<template>
  <div class="switcher-overlay" @mousedown.self="$emit('close')" @keydown="handleDialogKeydown">
    <Panel class="switcher" elevated role="dialog" aria-modal="true" aria-labelledby="workspace-switcher-title">
      <header class="switcher-header">
        <div>
          <h2 id="workspace-switcher-title">All Workspaces</h2>
          <p>Jump to an open workspace or reopen a recent repository.</p>
        </div>

        <Button ref="closeButton" variant="ghost" size="sm" @click="$emit('close')">Close</Button>
      </header>

      <input
        ref="searchInput"
        v-model="query"
        class="switcher-search"
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls="workspace-switcher-list"
        :aria-activedescendant="items.length > 0 ? `workspace-option-${selectedIndex}` : undefined"
        aria-label="Search workspaces"
        placeholder="Search names and paths"
        @keydown.down.prevent="moveSelection(1)"
        @keydown.up.prevent="moveSelection(-1)"
        @keydown.enter.prevent="activateSelected"
      />

      <div id="workspace-switcher-list" class="switcher-list" role="listbox" aria-label="Workspaces">
        <button
          v-for="(item, index) in items"
          :id="`workspace-option-${index}`"
          :key="item.key"
          class="switcher-option"
          :class="{ selected: index === selectedIndex }"
          type="button"
          role="option"
          tabindex="-1"
          :aria-selected="index === selectedIndex"
          @mouseenter="selectedIndex = index"
          @click="activate(item)"
        >
          <span class="option-main">
            <strong>{{ item.name }}</strong>
            <span>{{ item.path }}</span>
          </span>
          <WorkspaceAttentionBadge v-if="item.workspace" :state="item.workspace.state" />
          <span v-else class="recent-label">Recent</span>
        </button>

        <EmptyState v-if="items.length === 0" title="No matching workspaces" description="Try another repository name or path." />
      </div>

      <footer class="switcher-footer">
        <Button @click="$emit('openNew')">Open Workspace</Button>
      </footer>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { WorkspaceSummary } from '../../lib/workbenchContract';
import type { RecentRepository } from '../../stores/repo';
import Button from '../Button.vue';
import EmptyState from '../ui/EmptyState.vue';
import Panel from '../ui/Panel.vue';
import WorkspaceAttentionBadge from './WorkspaceAttentionBadge.vue';

type SwitcherItem = { key: string; name: string; path: string; workspace?: WorkspaceSummary; recent?: RecentRepository };

const props = defineProps<{ workspaces: WorkspaceSummary[]; recentRepositories: RecentRepository[] }>();
const emit = defineEmits<{
  close: [];
  openNew: [];
  select: [workspaceId: string];
  openRecent: [path: string];
}>();

const query = ref('');
const selectedIndex = ref(0);
const searchInput = ref<HTMLInputElement>();
const items = computed<SwitcherItem[]>(() => {
  const normalized = query.value.trim().toLocaleLowerCase();
  const openRoots = new Set(props.workspaces.map((workspace) => workspace.root));
  const all: SwitcherItem[] = [
    ...props.workspaces.map((workspace) => ({
      key: `workspace:${workspace.workspaceId}`,
      name: workspace.displayName,
      path: workspace.root,
      workspace,
    })),
    ...props.recentRepositories
      .filter((repository) => !openRoots.has(repository.path))
      .map((recent) => ({ key: `recent:${recent.path}`, name: recent.name, path: recent.path, recent })),
  ];
  return normalized ? all.filter((item) => `${item.name} ${item.path}`.toLocaleLowerCase().includes(normalized)) : all;
});

const moveSelection = (delta: -1 | 1) => {
  if (items.value.length === 0) return;
  selectedIndex.value = (selectedIndex.value + delta + items.value.length) % items.value.length;
};

const activateSelected = () => {
  const item = items.value[selectedIndex.value];
  if (item) activate(item);
};

const activate = (item: SwitcherItem) => {
  if (item.workspace) emit('select', item.workspace.workspaceId);
  else if (item.recent) emit('openRecent', item.recent.path);
};

const handleDialogKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  const dialog = (event.currentTarget as HTMLElement).querySelector('[role="dialog"]');
  const focusable = dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')] : [];
  if (focusable.length === 0) return;
  const current = focusable.indexOf(document.activeElement as HTMLElement);
  const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current + 1) % focusable.length;
  event.preventDefault();
  focusable[next].focus();
};

watch(
  () => items.value.length,
  (length) => {
    selectedIndex.value = Math.min(selectedIndex.value, Math.max(0, length - 1));
  },
);

onMounted(async () => {
  await nextTick();
  searchInput.value?.focus();
});
</script>

<style scoped lang="scss">
.switcher-overlay {
  position: fixed;
  z-index: 120;
  inset: 0;
  display: grid;
  place-items: start center;
  padding: min(12vh, var(--space-10)) var(--space-7);
  background: var(--color-bg-overlay);
}

.switcher {
  display: grid;
  gap: var(--space-7);
  width: min(720px, 100%);
  max-height: min(720px, calc(100vh - var(--space-10) * 2));
  overflow: hidden;
}

.switcher-header,
.switcher-footer,
.switcher-option {
  display: flex;
  gap: var(--space-7);
  align-items: center;
  justify-content: space-between;
}

h2,
p {
  margin: 0;
}

p {
  margin-top: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
}

.switcher-search {
  width: 100%;
  padding: var(--space-6) var(--space-7);
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  outline: 0;

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.switcher-list {
  display: grid;
  gap: var(--space-2);
  min-height: 120px;
  overflow-y: auto;
}

.switcher-option {
  width: 100%;
  padding: var(--space-6);
  color: var(--color-text-secondary);
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-3);
  cursor: pointer;

  &:hover,
  &.selected {
    color: var(--color-text-primary);
    background: var(--color-bg-hover);
    border-color: var(--color-border-default);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
  }
}

.option-main {
  display: grid;
  gap: var(--space-2);
  min-width: 0;

  span {
    overflow: hidden;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--font-size-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.recent-label {
  color: var(--color-text-subtle);
  font-size: var(--font-size-caption);
}

.switcher-footer {
  justify-content: flex-end;
  padding-top: var(--space-5);
  border-top: 1px solid var(--color-border-subtle);
}
</style>
