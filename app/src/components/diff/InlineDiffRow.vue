<template>
  <div v-if="row.kind === 'hunk'" class="diff-row hunk">
    <div class="hunk-text">{{ row.hunkHeader ?? row.text }}</div>
  </div>
  <div v-else class="diff-row" :class="row.kind">
    <div class="line-number old">{{ row.oldLine ?? '' }}</div>
    <div class="line-number new">{{ row.newLine ?? '' }}</div>
    <pre class="code">{{ text }}</pre>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { DiffRow } from '../../lib/protocol'

const props = defineProps<{
  row: DiffRow
}>()

const text = computed(() => props.row.oldText ?? props.row.newText ?? props.row.text ?? '')
</script>

<style scoped lang="scss">
.diff-row {
  display: grid;
  grid-template-columns: 64px 64px minmax(0, 1fr);
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

.code {
  min-width: 0;
  margin: 0;
  padding: 0 12px;
  overflow: hidden;
  color: #d8dee9;
  font: inherit;
  line-height: inherit;
  text-overflow: ellipsis;
  white-space: pre;
}

.deleted .line-number,
.deleted .code {
  background: rgba(255, 99, 99, 0.16);
}

.added .line-number,
.added .code {
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
