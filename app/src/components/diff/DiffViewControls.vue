<template>
  <div class="controls">
    <div v-if="searchEnabled && searchOpen" class="search-box">
      <input
        ref="searchInputRef"
        :value="searchQuery"
        class="search-input"
        type="search"
        placeholder="Search file"
        @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent="emit('moveSearch', $event.shiftKey ? -1 : 1)"
        @keydown.esc.prevent="emit('closeSearch')"
      />

      <span class="search-count">{{ searchStatus }}</span>

      <Button variant="ghost" size="sm" :disabled="!hasSearchMatches" title="Previous match" @click="emit('moveSearch', -1)"> Prev </Button>

      <Button variant="ghost" size="sm" :disabled="!hasSearchMatches" title="Next match" @click="emit('moveSearch', 1)"> Next </Button>
    </div>

    <Button v-else-if="searchEnabled" variant="ghost" size="sm" title="Search file (Ctrl+F or /)" @click="emit('openSearch')">
      Search
    </Button>

    <div class="mode-group" role="group" aria-label="Diff layout">
      <Button
        variant="secondary"
        size="sm"
        :pressed="viewMode === 'split'"
        :aria-pressed="viewMode === 'split'"
        @click="emit('update:viewMode', 'split')"
      >
        Split
      </Button>

      <Button
        variant="secondary"
        size="sm"
        :pressed="viewMode === 'inline'"
        :aria-pressed="viewMode === 'inline'"
        @click="emit('update:viewMode', 'inline')"
      >
        Inline
      </Button>
    </div>

    <Button
      v-if="showSyncScroll && viewMode === 'split'"
      variant="secondary"
      size="sm"
      :pressed="syncScroll"
      :aria-pressed="syncScroll"
      @click="emit('update:syncScroll', !syncScroll)"
    >
      {{ syncScroll ? 'Synced' : 'Desynced' }}
    </Button>

    <Button
      variant="secondary"
      size="sm"
      :pressed="contextMode === 'full'"
      :aria-pressed="contextMode === 'full'"
      @click="emit('update:contextMode', contextMode === 'full' ? 'diff' : 'full')"
    >
      {{ contextMode === 'full' ? 'Full file' : 'Diff only' }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { DiffContextMode, DiffViewMode } from '../../lib/protocol';
import Button from '../Button.vue';

const props = withDefaults(
  defineProps<{
    viewMode: DiffViewMode;
    contextMode: DiffContextMode;
    searchEnabled?: boolean;
    searchOpen?: boolean;
    searchQuery?: string;
    searchStatus?: string;
    hasSearchMatches?: boolean;
    showSyncScroll?: boolean;
    syncScroll?: boolean;
  }>(),
  {
    searchEnabled: false,
    searchOpen: false,
    searchQuery: '',
    searchStatus: '0/0',
    hasSearchMatches: false,
    showSyncScroll: false,
    syncScroll: false,
  },
);

const emit = defineEmits<{
  'update:viewMode': [mode: DiffViewMode];
  'update:contextMode': [mode: DiffContextMode];
  'update:syncScroll': [enabled: boolean];
  'update:searchQuery': [query: string];
  openSearch: [];
  closeSearch: [];
  moveSearch: [direction: number];
}>();

const searchInputRef = ref<HTMLInputElement | null>(null);

watch(
  () => props.searchOpen,
  (open) => {
    if (!open) {
      searchInputRef.value?.blur();
      return;
    }
    void nextTick(() => {
      searchInputRef.value?.focus();
      searchInputRef.value?.select();
    });
  },
);
</script>

<style scoped lang="scss">
.controls {
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  flex-wrap: wrap;
  min-width: 0;
  gap: var(--space-4);
}

.search-box {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-1);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
}

.mode-group {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
}

.search-input {
  width: min(220px, 28vw);
  height: 26px;
  padding: 0 var(--space-4);
  color: var(--color-text-primary);
  background: var(--color-bg-shell);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-2);
  font: inherit;
  outline: none;

  &:focus {
    border-color: var(--color-border-focus);
    box-shadow: 0 0 0 2px var(--color-accent-muted);
  }
}

.search-count {
  min-width: 54px;
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
  text-align: center;
}
</style>
