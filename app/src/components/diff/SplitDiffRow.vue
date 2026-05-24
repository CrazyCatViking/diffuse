<script setup lang="ts">
import type { DiffRow } from '../../lib/protocol'

defineProps<{
  row: DiffRow
}>()
</script>

<template>
  <div v-if="row.kind === 'hunk'" class="diff-row hunk">
    <div class="hunk-text">{{ row.hunkHeader ?? row.text }}</div>
  </div>
  <div v-else class="diff-row" :class="row.kind">
    <div class="line-number old">{{ row.oldLine ?? '' }}</div>
    <pre class="code old">{{ row.oldText ?? '' }}</pre>
    <div class="line-number new">{{ row.newLine ?? '' }}</div>
    <pre class="code new">{{ row.newText ?? '' }}</pre>
  </div>
</template>

<style scoped lang="scss">
.diff-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 64px minmax(0, 1fr);
  min-height: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.025);
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

.added {
  .new,
  .new + .code,
  .code.new {
    background: rgba(60, 179, 113, 0.16);
  }
}

.deleted {
  .old,
  .old + .code,
  .code.old {
    background: rgba(255, 99, 99, 0.16);
  }
}

.hunk {
  display: block;
  min-height: 28px;
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
