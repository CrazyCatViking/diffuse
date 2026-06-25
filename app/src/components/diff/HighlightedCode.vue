<template>
  <CodeText :text="text" :spans="spans" :highlights="highlights" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SyntaxSpan } from '../../lib/protocol';
import CodeText from '../code/CodeText.vue';
import type { CodeTextHighlight } from '../code/codeModels';

const props = defineProps<{
  text: string;
  spans?: SyntaxSpan[];
  reviewHighlights?: ReviewTextHighlight[];
  searchHighlights?: SearchTextHighlight[];
}>();

export type ReviewTextHighlight = {
  startColumn: number;
  endColumn: number;
};

export type SearchTextHighlight = ReviewTextHighlight & {
  active?: boolean;
};

const highlights = computed<CodeTextHighlight[]>(() => [
  ...(props.reviewHighlights ?? []).map((highlight) => ({
    kind: 'review' as const,
    startColumn: highlight.startColumn,
    endColumn: highlight.endColumn,
  })),
  ...(props.searchHighlights ?? []).map((highlight) => ({
    kind: highlight.active ? ('active-search' as const) : ('search' as const),
    startColumn: highlight.startColumn,
    endColumn: highlight.endColumn,
  })),
]);
</script>
