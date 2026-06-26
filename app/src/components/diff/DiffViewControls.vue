<template>
  <div class="controls">
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
import type { DiffContextMode, DiffViewMode } from '../../lib/protocol';
import Button from '../Button.vue';

const props = withDefaults(
  defineProps<{
    viewMode: DiffViewMode;
    contextMode: DiffContextMode;
    showSyncScroll?: boolean;
    syncScroll?: boolean;
  }>(),
  {
    showSyncScroll: false,
    syncScroll: false,
  },
);

const emit = defineEmits<{
  'update:viewMode': [mode: DiffViewMode];
  'update:contextMode': [mode: DiffContextMode];
  'update:syncScroll': [enabled: boolean];
}>();
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

.mode-group {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
}
</style>
