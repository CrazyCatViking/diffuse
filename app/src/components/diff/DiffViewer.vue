<template>
  <section class="diff-viewer">
    <div class="diff-header">
      <span>{{ model?.fileId ?? 'No file selected' }}</span>
      <span v-if="model">{{ rows.length }} rows</span>
    </div>

    <div v-if="loading" class="message">Loading diff...</div>
    <div v-else-if="error" class="message error">{{ error }}</div>
    <div v-else-if="!model" class="message">Select a changed file to view its diff.</div>
    <div v-else-if="rows.length === 0" class="message">No unstaged diff for this file.</div>
    <div v-else ref="parentRef" class="rows">
      <div class="spacer" :style="{ height: `${totalSize}px` }">
        <div
          v-for="virtualRow in virtualRows"
          :key="String(virtualRow.key)"
          class="virtual-row"
          :style="{ transform: `translateY(${virtualRow.start}px)` }"
        >
          <SplitDiffRow :row="rows[virtualRow.index]" />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { DiffRenderModel } from '../../lib/protocol'
import SplitDiffRow from './SplitDiffRow.vue'

const props = defineProps<{
  model: DiffRenderModel | null
  loading: boolean
  error: string | null
}>()

const parentRef = ref<HTMLElement | null>(null)
const rows = computed(() => props.model?.rows ?? [])

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => parentRef.value,
    estimateSize: (index) => (rows.value[index]?.kind === 'hunk' ? 28 : 24),
    overscan: 12
  }))
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())
</script>

<style scoped lang="scss">
.diff-viewer {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  height: 100%;
  background: #111318;

  overflow: auto;
}

.diff-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
  height: 40px;
  padding: 0 14px;
  align-items: center;
  color: #98a2b3;
  background: #151821;
  border-bottom: 1px solid #252a35;
  font-size: 12px;
}

.message {
  padding: 24px;
  color: #7e8aa0;

  &.error {
    color: #ff8d8d;
  }
}

.rows {
  min-height: 0;
  overflow: auto;
}

.spacer {
  position: relative;
  min-width: 900px;
}

.virtual-row {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;

  z-index: 1;
}
</style>
