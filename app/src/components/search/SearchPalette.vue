<template>
  <div v-if="search.overlayOpen" class="search-overlay" role="presentation" @click.self="search.closeOverlay()">
    <Panel
      class="search-palette"
      elevated
      padding="none"
      role="dialog"
      aria-modal="true"
      aria-label="Search changed files"
      @keydown="onKeydown"
    >
      <div class="palette-header">
        <SearchInput
          ref="inputRef"
          :model-value="search.query"
          placeholder="Search files, filters, comments..."
          label="Search changed files"
          @update:model-value="search.setQuery($event)"
        />

        <Button variant="ghost" size="sm" @click="search.closeOverlay()">Close</Button>
      </div>

      <div class="mode-row" role="group" aria-label="Search mode">
        <Button
          v-for="mode in modes"
          :key="mode.value"
          variant="secondary"
          size="sm"
          :pressed="search.mode === mode.value"
          :aria-pressed="search.mode === mode.value"
          @click="search.setMode(mode.value)"
        >
          {{ mode.label }}
        </Button>
      </div>

      <SearchFilterChips :active-filters="search.activeFilters" @toggle="search.toggleFilter($event)" />

      <div class="result-toolbar">
        <div class="result-summary">
          <Badge tone="review">{{ search.results.length }} results</Badge>

          <span v-if="search.selectedResult">{{ search.selectedIndex + 1 }} of {{ search.results.length }}</span>

          <span v-if="search.searchLoading">Searching in core...</span>

          <span v-else-if="search.error">{{ search.error }}</span>
        </div>

        <div class="result-actions">
          <Button variant="secondary" size="sm" :disabled="search.results.length === 0" @click="search.pinResults()">Pin results</Button>

          <Button variant="ghost" size="sm" :disabled="!search.hasActiveSearch" @click="search.clearQuery()">Clear</Button>
        </div>
      </div>

      <div class="palette-results">
        <EmptyState
          v-if="search.mode === 'symbols'"
          align="start"
          bordered
          title="Search mode coming next"
          description="Symbol extraction is not implemented yet. File, content, and comment search are core-backed now."
        />

        <EmptyState
          v-else-if="search.results.length === 0"
          align="start"
          bordered
          title="No search results"
          description="Try a filename, path segment, extension, or one of the filter chips."
        />

        <SearchResultList
          v-else
          :groups="search.groups"
          :results="search.results"
          :selected-index="search.selectedIndex"
          @select="openResult(search.results[$event])"
          @open="openResult($event)"
        />
      </div>

      <footer class="palette-footer">
        <span><kbd>↑↓</kbd> Select</span>

        <span><kbd>Click</kbd>/<kbd>Enter</kbd> Open</span>

        <span><kbd>Shift</kbd> + <kbd>Enter</kbd> Pin</span>

        <span><kbd>Esc</kbd> Close</span>
      </footer>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import Button from '../Button.vue';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import Panel from '../ui/Panel.vue';
import SearchFilterChips from './SearchFilterChips.vue';
import SearchInput from './SearchInput.vue';
import SearchResultList from './SearchResultList.vue';
import { useSearchStore } from '../../stores/search';
import type { SearchMode, SearchResult } from '../../lib/search/searchTypes';

const emit = defineEmits<{
  open: [result: SearchResult];
  preview: [result: SearchResult];
}>();

const search = useSearchStore();
const inputRef = ref<InstanceType<typeof SearchInput> | null>(null);
const modes: { value: SearchMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'files', label: 'Files' },
  { value: 'comments', label: 'Comments' },
  { value: 'content', label: 'Content' },
  { value: 'symbols', label: 'Symbols' },
];

const openResult = (result: SearchResult | undefined = search.selectedResult) => {
  if (!result) return;
  search.rememberQuery();
  search.closeOverlay();
  emit('open', result);
};

const previewResult = () => {
  if (!search.selectedResult) return;
  emit('preview', search.selectedResult);
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    search.nextResult();
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    search.previousResult();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) search.pinResults();
    else openResult();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    search.closeOverlay();
    return;
  }
  if (event.key === ' ' && !isTextInput(event.target)) {
    event.preventDefault();
    previewResult();
  }
};

const isTextInput = (target: EventTarget | null) => {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
};

watch(
  () => search.overlayOpen,
  async (open) => {
    if (!open) return;
    await nextTick();
    inputRef.value?.focus();
    inputRef.value?.select();
  },
);
</script>

<style scoped lang="scss">
.search-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: start center;
  padding: min(12vh, 96px) var(--space-7) var(--space-7);
  background: var(--color-bg-overlay);
}

.search-palette {
  display: grid;
  grid-template-rows: auto auto auto auto minmax(0, 1fr) auto;
  gap: var(--space-5);
  width: min(860px, calc(100vw - 2 * var(--space-7)));
  max-height: min(760px, calc(100vh - 2 * var(--space-7)));
  padding: var(--space-7);
}

.palette-header,
.result-toolbar,
.result-actions,
.result-summary,
.mode-row,
.palette-footer {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
}

.palette-header {
  align-items: stretch;
}

.mode-row {
  flex-wrap: wrap;
}

.result-toolbar {
  justify-content: space-between;
}

.result-summary {
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
}

.palette-results {
  min-height: 260px;
  overflow: auto;
  padding-right: var(--space-2);
}

.palette-footer {
  flex-wrap: wrap;
  justify-content: flex-end;
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
}

kbd {
  padding: 1px var(--space-2);
  color: var(--color-text-secondary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-1);
  font-family: var(--font-mono);
  font-size: 10px;
}

@media (max-width: 720px) {
  .search-overlay {
    padding: var(--space-5);
  }

  .search-palette {
    width: 100%;
    max-height: calc(100vh - 2 * var(--space-5));
  }
}
</style>
