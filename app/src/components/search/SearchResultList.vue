<template>
  <div ref="listRef" class="result-list" :class="{ compact }">
    <template v-for="group in indexedGroups" :key="group.id">
      <button class="group-heading" type="button" :aria-expanded="!collapsedGroups.has(group.id)" @click="toggleGroup(group.id)">
        <span class="group-label">
          <span class="group-chevron" aria-hidden="true">{{ collapsedGroups.has(group.id) ? '>' : 'v' }}</span>

          <span>{{ group.label }}</span>
        </span>

        <Badge tone="neutral">{{ group.results.length }}</Badge>
      </button>

      <div v-if="!collapsedGroups.has(group.id)" class="group-results">
        <div v-for="item in group.results" :key="item.result.id" class="result-item" :data-result-index="item.index">
          <SearchResultRow
            :result="item.result"
            :selected="item.index === selectedIndex"
            :compact="compact"
            @select="emit('select', item.index)"
            @open="emit('open', item.result)"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Badge from '../ui/Badge.vue';
import SearchResultRow from './SearchResultRow.vue';
import type { SearchResult, SearchResultGroup } from '../../lib/search/searchTypes';

type IndexedSearchResult = {
  result: SearchResult;
  index: number;
};

type IndexedSearchResultGroup = Omit<SearchResultGroup, 'results'> & {
  results: IndexedSearchResult[];
};

const props = defineProps<{
  groups: SearchResultGroup[];
  results: SearchResult[];
  selectedIndex: number;
  compact?: boolean;
}>();

const emit = defineEmits<{
  select: [index: number];
  open: [result: SearchResult];
}>();

const listRef = ref<HTMLElement | null>(null);
const collapsedGroups = ref(new Set<string>());

const indexedGroups = computed<IndexedSearchResultGroup[]>(() => {
  const indexById = new Map(props.results.map((result, index) => [result.id, index]));
  return props.groups.map((group) => ({
    ...group,
    results: group.results.map((result) => ({ result, index: indexById.get(result.id) ?? -1 })).filter((item) => item.index >= 0),
  }));
});

const toggleGroup = (id: string) => {
  const next = new Set(collapsedGroups.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedGroups.value = next;
};

const expandSelectedGroup = () => {
  const selected = props.results[props.selectedIndex];
  if (!selected) return;

  const group = indexedGroups.value.find((item) => item.results.some((result) => result.result.id === selected.id));
  if (!group || !collapsedGroups.value.has(group.id)) return;

  const next = new Set(collapsedGroups.value);
  next.delete(group.id);
  collapsedGroups.value = next;
};

watch(
  () => props.selectedIndex,
  async () => {
    expandSelectedGroup();
    await nextTick();
    listRef.value?.querySelector<HTMLElement>(`[data-result-index="${props.selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  },
);
</script>

<style scoped lang="scss">
.result-list {
  display: grid;
  gap: var(--space-3);
  min-width: 0;

  &.compact {
    gap: var(--space-2);
  }
}

.group-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-4) var(--space-2) var(--space-2);
  color: var(--color-text-subtle);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: var(--font-size-caption);
  font-weight: 800;
  letter-spacing: 0.08em;
  text-align: left;
  text-transform: uppercase;

  &:hover {
    color: var(--color-text-primary);
  }

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.group-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.group-label span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-chevron {
  flex: 0 0 auto;
  width: 10px;
  color: var(--color-text-subtle);
}

.group-results {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}

.result-item {
  min-width: 0;
}

.compact .group-heading {
  padding: var(--space-3) var(--space-1) var(--space-1);
  font-size: 10px;
}
</style>
