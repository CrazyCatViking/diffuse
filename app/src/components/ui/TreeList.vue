<template>
  <div class="tree-list" :class="`density-${density}`" role="tree" :aria-label="ariaLabel">
    <div
      v-for="item in visibleItems"
      :key="item.node.key"
      class="tree-row"
      :class="[
        item.node.rowClass,
        item.node.tone ? `tone-${item.node.tone}` : undefined,
        { active: item.node.active, branch: item.hasChildren, leaf: !item.hasChildren },
      ]"
      :style="{ '--tree-depth': item.depth }"
      role="treeitem"
      :aria-expanded="item.hasChildren ? !item.collapsed : undefined"
      :aria-selected="item.node.active || undefined"
    >
      <span class="tree-leading-cell">
        <slot name="leading" :node="item.node" :depth="item.depth" :collapsed="item.collapsed" :has-children="item.hasChildren" />
      </span>

      <button
        v-if="item.hasChildren"
        class="tree-toggle"
        type="button"
        :aria-label="item.collapsed ? `Expand ${item.node.label}` : `Collapse ${item.node.label}`"
        @click="toggleNode(item.node.key)"
      >
        {{ item.collapsed ? '>' : 'v' }}
      </button>

      <span v-else class="tree-toggle-placeholder" aria-hidden="true" />

      <div class="tree-main">
        <slot :node="item.node" :depth="item.depth" :collapsed="item.collapsed" :has-children="item.hasChildren">
          <button class="tree-default-action" type="button" :title="item.node.title ?? item.node.label" @click="emit('select', item.node)">
            {{ item.node.label }}
          </button>
        </slot>
      </div>

      <slot name="actions" :node="item.node" :depth="item.depth" :collapsed="item.collapsed" :has-children="item.hasChildren" />
    </div>
  </div>
</template>

<script lang="ts">
export type TreeListTone = 'success' | 'warning' | 'danger' | 'info' | 'review' | 'ai' | 'neutral';

export type TreeListNode<T = unknown> = {
  key: string;
  label: string;
  title?: string;
  active?: boolean;
  tone?: TreeListTone;
  rowClass?: string | string[] | Record<string, boolean>;
  data?: T;
  children?: TreeListNode<T>[];
};

type VisibleTreeItem<T> = {
  node: TreeListNode<T>;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
};

type TreeListSlotProps<T> = VisibleTreeItem<T>;
</script>

<script setup lang="ts" generic="T = unknown">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    nodes: TreeListNode<T>[];
    collapsedKeys: Set<string>;
    ariaLabel: string;
    density?: 'normal' | 'compact';
  }>(),
  {
    density: 'normal',
  },
);

const emit = defineEmits<{
  'update:collapsedKeys': [keys: Set<string>];
  select: [node: TreeListNode<T>];
}>();

defineSlots<{
  leading?: (props: TreeListSlotProps<T>) => unknown;
  default?: (props: TreeListSlotProps<T>) => unknown;
  actions?: (props: TreeListSlotProps<T>) => unknown;
}>();

const visibleItems = computed<VisibleTreeItem<T>[]>(() => {
  const items: VisibleTreeItem<T>[] = [];
  const collect = (nodes: TreeListNode<T>[], depth: number) => {
    for (const node of nodes) {
      const hasChildren = Boolean(node.children?.length);
      const collapsed = hasChildren && props.collapsedKeys.has(node.key);
      items.push({ node, depth, hasChildren, collapsed });
      if (hasChildren && !collapsed) collect(node.children ?? [], depth + 1);
    }
  };

  collect(props.nodes, 0);
  return items;
});

const toggleNode = (key: string) => {
  const next = new Set(props.collapsedKeys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  emit('update:collapsedKeys', next);
};
</script>

<style scoped lang="scss">
.tree-list {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.tree-row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  gap: var(--space-3);
  align-items: center;
  min-width: 0;
  padding: var(--space-3) var(--space-4);
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);
}

.density-compact .tree-row {
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.tree-row:hover {
  background: var(--color-bg-hover);
  border-color: var(--color-border-subtle);
}

.tree-row.active {
  background: var(--color-bg-active);
  border-color: var(--color-border-default);
}

.tree-row.branch {
  color: var(--color-text-primary);
  background: var(--color-bg-panel);
  border-color: var(--color-border-subtle);
  border-left-color: var(--color-border-default);
  border-left-width: 2px;
}

.tree-row.branch:hover,
.tree-row.branch.active {
  background: var(--color-bg-active);
  border-color: var(--color-border-default);
}

.tree-row.tone-success {
  color: var(--color-success);
}

.tree-row.tone-warning {
  color: var(--color-warning);
}

.tree-row.tone-danger {
  color: var(--color-danger);
}

.tree-leading-cell {
  display: grid;
  place-items: center;
  min-width: 0;
}

.tree-toggle,
.tree-toggle-placeholder {
  margin-left: calc(var(--tree-depth) * var(--space-6));
}

.tree-toggle {
  display: grid;
  place-items: center;
  width: 18px;
  height: 22px;
  padding: 0;
  color: var(--color-text-subtle);
  background: transparent;
  border: 0;
  border-radius: 0;
  cursor: pointer;
  font: inherit;
  font-size: var(--font-size-caption);
  line-height: 1;

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-active);
  }

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.tree-toggle-placeholder {
  width: 18px;
  height: 1px;
}

.tree-main {
  min-width: 0;
}

.tree-default-action {
  width: 100%;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  color: inherit;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}
</style>
