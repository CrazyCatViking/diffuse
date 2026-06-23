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
      <button class="search-button" type="button" :disabled="!hasSearchMatches" title="Previous match" @click="emit('moveSearch', -1)">Prev</button>
      <button class="search-button" type="button" :disabled="!hasSearchMatches" title="Next match" @click="emit('moveSearch', 1)">Next</button>
    </div>
    <button v-else-if="searchEnabled" class="control" type="button" title="Search file (Ctrl+F or /)" @click="emit('openSearch')">Search</button>
    <button class="control" :class="{ active: viewMode === 'split' }" type="button" @click="emit('update:viewMode', 'split')">Split</button>
    <button class="control" :class="{ active: viewMode === 'inline' }" type="button" @click="emit('update:viewMode', 'inline')">Inline</button>
    <button v-if="showSyncScroll && viewMode === 'split'" class="control" :class="{ active: syncScroll }" type="button" @click="emit('update:syncScroll', !syncScroll)">
      {{ syncScroll ? 'Synced' : 'Desynced' }}
    </button>
    <button class="control" :class="{ active: contextMode === 'full' }" type="button" @click="emit('update:contextMode', contextMode === 'full' ? 'diff' : 'full')">
      {{ contextMode === 'full' ? 'Full file' : 'Diff only' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { DiffContextMode, DiffViewMode } from '../../lib/protocol';

const props = withDefaults(defineProps<{
  viewMode: DiffViewMode;
  contextMode: DiffContextMode;
  searchEnabled?: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
  searchStatus?: string;
  hasSearchMatches?: boolean;
  showSyncScroll?: boolean;
  syncScroll?: boolean;
}>(), {
  searchEnabled: false,
  searchOpen: false,
  searchQuery: '',
  searchStatus: '0/0',
  hasSearchMatches: false,
  showSyncScroll: false,
  syncScroll: false,
});

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

watch(() => props.searchOpen, (open) => {
  if (!open) {
    searchInputRef.value?.blur();
    return;
  }
  void nextTick(() => {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  });
});
</script>

<style scoped lang="scss">
.controls {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  min-width: 0;
  gap: 8px;
}

.control {
  height: 26px;
  padding: 0 10px;
  color: #98a2b3;
  background: #111722;
  border: 1px solid #2a3140;
  border-radius: 7px;
  cursor: pointer;
  font: inherit;

  &.active {
    color: #f5f7fb;
    background: #24406f;
    border-color: #3865ad;
  }
}

.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px;
  background: #0f141d;
  border: 1px solid #2a3140;
  border-radius: 8px;
}

.search-input {
  width: 190px;
  height: 22px;
  padding: 0 8px;
  color: #f5f7fb;
  background: #111722;
  border: 1px solid #30394b;
  border-radius: 6px;
  font: inherit;
  outline: none;

  &:focus {
    border-color: #5c83c7;
    box-shadow: 0 0 0 2px rgba(92, 131, 199, 0.18);
  }
}

.search-count {
  min-width: 54px;
  color: #98a2b3;
  text-align: center;
}

.search-button {
  height: 22px;
  padding: 0 8px;
  color: #d7e6ff;
  background: #162238;
  border: 1px solid #334765;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
}
</style>
