<template>
  <div v-if="row.kind === 'hunk'" class="diff-row hunk">
    <div class="hunk-text">{{ row.hunkHeader ?? row.text }}</div>
  </div>
  <div v-else class="diff-row" :class="row.kind">
    <div class="line-number old">{{ row.oldLine ?? '' }}</div>
    <HighlightedCode class="old" :text="row.oldText ?? ''" :spans="oldSyntaxSpans ?? row.oldSyntaxSpans" />
    <div class="line-number new">{{ row.newLine ?? '' }}</div>
    <HighlightedCode class="new" :text="row.newText ?? ''" :spans="newSyntaxSpans ?? row.newSyntaxSpans" />
  </div>
</template>

<script setup lang="ts">
import type { DiffRow, SyntaxSpan } from '../../lib/protocol';
import HighlightedCode from './HighlightedCode.vue';

defineProps<{
  row: DiffRow
  oldSyntaxSpans?: SyntaxSpan[]
  newSyntaxSpans?: SyntaxSpan[]
}>();
</script>

<style scoped lang="scss">
.diff-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 64px minmax(0, 1fr);
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

.added {
  .new,
  .new + :deep(.code),
  :deep(.code.new) {
    background: rgba(60, 179, 113, 0.16);
  }
}

.deleted {
  .old,
  .old + :deep(.code),
  :deep(.code.old) {
    background: rgba(255, 99, 99, 0.16);
  }
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
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 24px;
}
</style>
