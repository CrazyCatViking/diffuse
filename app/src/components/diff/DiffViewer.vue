<template>
  <section class="diff-viewer">
    <div class="diff-header">
      <div class="file-meta">
        <span>{{ model?.fileId ?? 'No file selected' }}</span>
        <span v-if="model" class="row-count">{{ rows.length }} rows</span>
      </div>
      <div class="controls">
        <button
          class="control"
          :class="{ active: viewMode === 'split' }"
          type="button"
          @click="emit('update:viewMode', 'split')"
        >
          Split
        </button>
        <button
          class="control"
          :class="{ active: viewMode === 'inline' }"
          type="button"
          @click="emit('update:viewMode', 'inline')"
        >
          Inline
        </button>
        <button
          v-if="viewMode === 'split'"
          class="control"
          :class="{ active: syncScroll }"
          type="button"
          @click="emit('update:syncScroll', !syncScroll)"
        >
          {{ syncScroll ? 'Synced' : 'Desynced' }}
        </button>
        <button
          class="control"
          :class="{ active: contextMode === 'full' }"
          type="button"
          @click="emit('update:contextMode', contextMode === 'full' ? 'diff' : 'full')"
        >
          {{ contextMode === 'full' ? 'Full file' : 'Diff only' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="message">Loading diff...</div>
    <div v-else-if="error" class="message error">{{ error }}</div>
    <div v-else-if="!model" class="message">Select a changed file to view its diff.</div>
    <div v-else-if="rows.length === 0" class="message">No unstaged diff for this file.</div>
    <div v-else-if="viewMode === 'split'" class="split-view">
      <div ref="leftRef" class="pane old-pane" @scroll="onLeftScroll">
        <div class="spacer" :style="{ height: `${leftTotalSize}px` }">
          <div
            v-for="virtualRow in leftVirtualRows"
            :key="`old-${String(virtualRow.key)}`"
            class="virtual-row"
            :style="{ transform: `translateY(${virtualRow.start}px)` }"
          >
            <SplitDiffPaneRow :row="rows[virtualRow.index]" side="old" />
          </div>
        </div>
      </div>
      <div ref="rightRef" class="pane new-pane" @scroll="onRightScroll">
        <div class="spacer" :style="{ height: `${rightTotalSize}px` }">
          <div
            v-for="virtualRow in rightVirtualRows"
            :key="`new-${String(virtualRow.key)}`"
            class="virtual-row"
            :style="{ transform: `translateY(${virtualRow.start}px)` }"
          >
            <SplitDiffPaneRow :row="rows[virtualRow.index]" side="new" />
          </div>
        </div>
      </div>
    </div>
    <div v-else ref="inlineRef" class="pane inline-view">
      <div class="spacer inline-spacer" :style="{ height: `${inlineTotalSize}px` }">
        <div
          v-for="virtualRow in inlineVirtualRows"
          :key="String(virtualRow.key)"
          class="virtual-row"
          :style="{ transform: `translateY(${virtualRow.start}px)` }"
        >
          <InlineDiffRow :row="rows[virtualRow.index]" />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { DiffContextMode, DiffRenderModel, DiffViewMode } from '../../lib/protocol'
import InlineDiffRow from './InlineDiffRow.vue'
import SplitDiffPaneRow from './SplitDiffPaneRow.vue'

const props = defineProps<{
  model?: DiffRenderModel 
  loading: boolean
  error?: string 
  viewMode: DiffViewMode
  contextMode: DiffContextMode
  syncScroll: boolean
}>()

const emit = defineEmits<{
  'update:viewMode': [mode: DiffViewMode]
  'update:contextMode': [mode: DiffContextMode]
  'update:syncScroll': [enabled: boolean]
}>()

const leftRef = ref<HTMLElement | null>(null)
const rightRef = ref<HTMLElement | null>(null)
const inlineRef = ref<HTMLElement | null>(null)
const rows = computed(() => props.model?.rows ?? [])
let isSyncingScroll = false

const estimateSize = (index: number) => (rows.value[index]?.kind === 'hunk' ? 28 : 24)

const leftVirtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => leftRef.value,
    estimateSize,
    overscan: 12
  }))
)

const rightVirtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => rightRef.value,
    estimateSize,
    overscan: 12
  }))
)

const inlineVirtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => inlineRef.value,
    estimateSize,
    overscan: 12
  }))
)

const leftVirtualRows = computed(() => leftVirtualizer.value.getVirtualItems())
const rightVirtualRows = computed(() => rightVirtualizer.value.getVirtualItems())
const inlineVirtualRows = computed(() => inlineVirtualizer.value.getVirtualItems())
const leftTotalSize = computed(() => leftVirtualizer.value.getTotalSize())
const rightTotalSize = computed(() => rightVirtualizer.value.getTotalSize())
const inlineTotalSize = computed(() => inlineVirtualizer.value.getTotalSize())

const syncScrollPosition = (source: HTMLElement, target: HTMLElement | null) => {
  if (!props.syncScroll || !target) return
  isSyncingScroll = true
  target.scrollTop = source.scrollTop
  target.scrollLeft = source.scrollLeft
  requestAnimationFrame(() => {
    isSyncingScroll = false
  })
}

const onLeftScroll = (event: Event) => {
  if (isSyncingScroll) return
  syncScrollPosition(event.currentTarget as HTMLElement, rightRef.value)
}

const onRightScroll = (event: Event) => {
  if (isSyncingScroll) return
  syncScrollPosition(event.currentTarget as HTMLElement, leftRef.value)
}

watch(
  () => props.syncScroll,
  (enabled) => {
    if (enabled && leftRef.value && rightRef.value) syncScrollPosition(leftRef.value, rightRef.value)
  }
)
</script>

<style scoped lang="scss">
.diff-viewer {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  height: 100%;
  background: #111318;
  overflow: hidden;
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

.file-meta,
.controls {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.file-meta {
  overflow: hidden;

  span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.row-count {
  flex: 0 0 auto;
  color: #687386;
}

.controls {
  flex: 0 0 auto;
}

.control {
  height: 26px;
  padding: 0 10px;
  color: #98a2b3;
  background: #111722;
  border: 1px solid #2a3140;
  border-radius: 7px;
  cursor: pointer;
  font: inherit;

  &.active {
    color: #f5f7fb;
    background: #24406f;
    border-color: #3865ad;
  }
}

.message {
  padding: 24px;
  color: #7e8aa0;

  &.error {
    color: #ff8d8d;
  }
}

.split-view {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-height: 0;
}

.pane {
  min-height: 0;
  overflow: auto;
}

.old-pane {
  border-right: 1px solid #252a35;
}

.inline-view {
  min-width: 0;
}

.spacer {
  position: relative;
  min-width: 560px;
}

.inline-spacer {
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
