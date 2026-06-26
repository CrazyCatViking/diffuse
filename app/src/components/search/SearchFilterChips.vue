<template>
  <div class="filter-chips" role="group" aria-label="Search filters">
    <Button
      v-for="filter in filters"
      :key="filter.kind"
      variant="secondary"
      size="sm"
      :pressed="activeFilters.includes(filter.kind)"
      :aria-pressed="activeFilters.includes(filter.kind)"
      :title="filter.description"
      @click="emit('toggle', filter.kind)"
    >
      {{ filter.label }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import Button from '../Button.vue';
import { searchFilterDefinitions, type SearchFilterKind } from '../../lib/search/searchTypes';

defineProps<{
  activeFilters: SearchFilterKind[];
}>();

const emit = defineEmits<{
  toggle: [filter: SearchFilterKind];
}>();

const filters = searchFilterDefinitions;
</script>

<style scoped lang="scss">
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
</style>
