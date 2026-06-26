<template>
  <span>
    <template v-for="segment in segments" :key="`${segment.start}:${segment.end}:${segment.highlight}`">
      <mark v-if="segment.highlight">{{ segment.text }}</mark>

      <span v-else>{{ segment.text }}</span>
    </template>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SearchMatchRange } from '../../lib/search/searchTypes';

const props = defineProps<{
  text: string;
  ranges?: SearchMatchRange[];
}>();

const segments = computed(() => {
  const ranges = [...(props.ranges ?? [])].sort((first, second) => first.start - second.start || first.end - second.end);
  const result: { text: string; highlight: boolean; start: number; end: number }[] = [];
  let offset = 0;

  for (const range of ranges) {
    const start = Math.max(0, Math.min(props.text.length, range.start));
    const end = Math.max(start, Math.min(props.text.length, range.end));
    if (start > offset) result.push({ text: props.text.slice(offset, start), highlight: false, start: offset, end: start });
    if (end > start) result.push({ text: props.text.slice(start, end), highlight: true, start, end });
    offset = end;
  }

  if (offset < props.text.length) result.push({ text: props.text.slice(offset), highlight: false, start: offset, end: props.text.length });
  if (result.length === 0) result.push({ text: props.text, highlight: false, start: 0, end: props.text.length });
  return result;
});
</script>

<style scoped lang="scss">
mark {
  color: var(--color-text-primary);
  background: var(--color-review-muted);
  border-radius: var(--radius-1);
  box-shadow: inset 0 -1px 0 rgba(240, 195, 106, 0.42);
}
</style>
