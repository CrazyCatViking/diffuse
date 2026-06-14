<template>
  <div v-if="row.kind === 'hunk'" class="diff-row hunk">
    <div class="hunk-text">{{ row.hunkHeader ?? row.text }}</div>
  </div>
  <div v-else class="diff-row" :class="[row.kind, side]">
    <div class="line-number">{{ lineNumber }}</div>
    <HighlightedCode :text="text" :spans="syntaxSpans ?? rowSpans" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DiffRow, SyntaxSpan } from '../../lib/protocol';
import HighlightedCode from './HighlightedCode.vue';

const props = defineProps<{
  row: DiffRow
  side: 'old' | 'new'
  syntaxSpans?: SyntaxSpan[]
}>();

const lineNumber = computed(() => props.side === 'old' ? props.row.oldLine ?? '' : props.row.newLine ?? '');
const text = computed(() => props.side === 'old' ? props.row.oldText ?? '' : props.row.newText ?? '');
const rowSpans = computed(() => props.side === 'old' ? props.row.oldSyntaxSpans : props.row.newSyntaxSpans);
</script>

<style scoped lang="scss">
.diff-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  height: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.025);
  box-sizing: border-box;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 24px;
}

.line-number {
  padding: 0 10px;
  color: #596273;
  background: #12151d;
  border-right: 1px solid #252a35;
  text-align: right;
  user-select: none;
}

.deleted.old .line-number,
.deleted.old :deep(.code) {
  background: rgba(255, 99, 99, 0.16);
}

.added.new .line-number,
.added.new :deep(.code) {
  background: rgba(60, 179, 113, 0.16);
}

.hunk {
  display: block;
  height: 28px;
  color: #9fb4ff;
  background: #1b2233;
  border-top: 1px solid #27324a;
  border-bottom: 1px solid #27324a;
}

.hunk-text {
  padding: 2px 12px;
  overflow: hidden;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 24px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
