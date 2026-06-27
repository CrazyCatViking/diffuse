<template>
  <button class="result-row" :class="{ selected, compact }" type="button" @click="emit('select')" @dblclick="emit('open')">
    <span class="kind" :class="`kind-${result.kind}`">{{ kindLabel }}</span>

    <span class="result-main">
      <span class="result-title">
        <SearchMatchHighlight :text="result.title" :ranges="titleRanges" />
      </span>

      <span v-if="result.subtitle" class="result-subtitle">
        <SearchMatchHighlight :text="result.subtitle" :ranges="subtitleRanges" />
      </span>

      <span v-if="!compact && result.kind === 'content'" class="result-preview">
        <SearchMatchHighlight :text="result.preview" :ranges="previewRanges" />
      </span>
    </span>

    <span class="result-meta">
      <template v-if="result.kind === 'file'">
        <Badge :tone="statusTone">{{ result.file.status }}</Badge>

        <Badge v-if="result.metadata.unresolvedCount > 0" tone="warning">{{ result.metadata.unresolvedCount }} open</Badge>

        <Badge v-else-if="result.metadata.commentCount > 0" tone="info">{{ result.metadata.commentCount }} comments</Badge>

        <Badge v-if="result.metadata.generated" tone="neutral">Generated</Badge>

        <Badge v-if="result.metadata.test" tone="ai">Test</Badge>

        <Badge v-if="result.metadata.docs" tone="review">Docs</Badge>
      </template>

      <template v-else-if="result.kind === 'comment'">
        <Badge :tone="result.thread.status === 'open' ? 'warning' : 'success'">{{ result.thread.status }}</Badge>

        <Badge tone="neutral">{{ result.thread.anchor.side }}:{{ result.thread.anchor.startLine }}</Badge>
      </template>

      <template v-else-if="result.kind === 'content'">
        <Badge tone="info">{{ result.side }}:{{ result.line }}</Badge>
      </template>

      <template v-else-if="result.kind === 'symbol'">
        <Badge tone="ai">{{ result.symbolKind }}</Badge>

        <Badge tone="neutral">{{ result.side }}:{{ result.line }}</Badge>
      </template>
    </span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Badge from '../ui/Badge.vue';
import SearchMatchHighlight from './SearchMatchHighlight.vue';
import type { SearchResult } from '../../lib/search/searchTypes';

const props = defineProps<{
  result: SearchResult;
  selected: boolean;
  compact?: boolean;
}>();

const emit = defineEmits<{
  select: [];
  open: [];
}>();

const kindLabel = computed(() => {
  if (props.compact) {
    if (props.result.kind === 'comment') return 'C';
    if (props.result.kind === 'content') return 'T';
    if (props.result.kind === 'symbol') return 'S';
    return 'F';
  }
  if (props.result.kind === 'comment') return 'Comment';
  if (props.result.kind === 'content') return 'Content';
  if (props.result.kind === 'symbol') return 'Symbol';
  return 'File';
});
const titleRanges = computed(() => props.result.matches.find((match) => match.field === (props.result.kind === 'symbol' ? 'symbol' : 'name'))?.ranges ?? []);
const subtitleRanges = computed(() => {
  const field = props.result.kind === 'comment' ? 'body' : 'path';
  return props.result.matches.find((match) => match.field === field)?.ranges ?? [];
});
const previewRanges = computed(() => props.result.matches.find((match) => match.field === 'body')?.ranges ?? []);
const statusTone = computed(() => {
  if (props.result.kind !== 'file') return 'neutral';
  if (props.result.file.status === 'added') return 'success';
  if (props.result.file.status === 'deleted') return 'danger';
  if (props.result.file.status === 'renamed') return 'ai';
  return 'info';
});
</script>

<style scoped lang="scss">
.result-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) auto;
  gap: var(--space-5);
  align-items: center;
  width: 100%;
  min-width: 0;
  padding: var(--space-5) var(--space-6);
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-4);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);

  &:hover,
  &.selected {
    background: var(--color-bg-hover);
  }

  &.selected {
    border-color: var(--color-border-default);
    box-shadow: var(--shadow-inset-highlight);
  }
}

.result-row.compact {
  grid-template-columns: 20px minmax(0, 1fr);
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-3);
}

.kind {
  display: grid;
  place-items: center;
  width: 64px;
  height: 24px;
  color: var(--color-text-muted);
  background: rgba(143, 151, 166, 0.1);
  border: 1px solid rgba(143, 151, 166, 0.18);
  border-radius: var(--radius-2);
  font-size: var(--font-size-caption);
  font-weight: 800;
}

.result-row.compact .kind {
  width: 20px;
  height: 20px;
  font-size: 10px;
}

.kind-comment {
  color: var(--color-review);
  background: var(--color-review-muted);
  border-color: rgba(240, 195, 106, 0.25);
}

.kind-content {
  color: var(--color-info);
  background: var(--color-info-muted);
  border-color: rgba(77, 166, 255, 0.25);
}

.kind-symbol {
  color: var(--color-ai);
  background: var(--color-ai-muted);
  border-color: rgba(167, 139, 250, 0.25);
}

.result-main {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.result-row.compact .result-main {
  gap: 1px;
}

.result-title,
.result-subtitle,
.result-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-title {
  color: var(--color-text-primary);
  font-size: var(--font-size-body);
  font-weight: 700;
}

.result-subtitle {
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
}

.result-preview {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.result-row.compact .result-title {
  font-size: var(--font-size-label);
}

.result-row.compact .result-subtitle {
  font-size: var(--font-size-caption);
}

.result-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
  min-width: 0;
}

.result-row.compact .result-meta {
  display: none;
}
</style>
