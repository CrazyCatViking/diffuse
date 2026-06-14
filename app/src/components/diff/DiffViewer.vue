<template>
  <section class="diff-viewer">
    <div class="diff-header">
      <div class="file-meta">
        <span>{{ model?.fileId ?? 'No file selected' }}</span>
        <span v-if="model" class="row-count">{{ rows.length }} rows</span>
        <span v-if="hasNewChanges" class="update-status">
          New changes available
          <button class="load-latest" type="button" :disabled="loading" @click="emit('loadLatest')">
            Load latest
          </button>
        </span>
        <span v-if="syntaxMessage" class="syntax-status">
          {{ syntaxMessage }}
          <button class="install-grammar" type="button" :disabled="installingGrammar" @click="emit('installGrammar')">
            {{ installingGrammar ? 'Installing...' : 'Install' }}
          </button>
          <span v-if="grammarInstallStep" class="install-step">{{ grammarInstallStep }}</span>
        </span>
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
    <div v-else-if="initialSyntaxGateActive" class="syntax-gate" />
    <div v-else-if="viewMode === 'split'" class="split-view">
      <div ref="leftRef" class="pane old-pane" @scroll="onLeftScroll">
        <div class="spacer" :style="{ height: `${leftTotalSize}px` }">
          <div
            v-for="virtualRow in leftVirtualRows"
            :key="`old-${String(virtualRow.key)}`"
            class="virtual-row"
            :style="{ transform: `translateY(${virtualRow.start}px)` }"
          >
            <SplitDiffPaneRow :row="rows[virtualRow.index]" side="old" :syntax-spans="syntaxForRow(rows[virtualRow.index], 'old')" />
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
            <SplitDiffPaneRow :row="rows[virtualRow.index]" side="new" :syntax-spans="syntaxForRow(rows[virtualRow.index], 'new')" />
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
          <InlineDiffRow :row="rows[virtualRow.index]" :syntax-spans="syntaxForInlineRow(rows[virtualRow.index])" />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { useClient } from '../../lib/useClient';
import type { DiffContextMode, DiffRenderModel, DiffRow, DiffViewMode, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import InlineDiffRow from './InlineDiffRow.vue';
import SplitDiffPaneRow from './SplitDiffPaneRow.vue';

const props = defineProps<{
  model?: DiffRenderModel 
  loading: boolean
  error?: string 
  viewMode: DiffViewMode
  contextMode: DiffContextMode
  syncScroll: boolean
  installingGrammar: boolean
  grammarInstallStep?: string
  hasNewChanges: boolean
}>();

const emit = defineEmits<{
  'update:viewMode': [mode: DiffViewMode]
  'update:contextMode': [mode: DiffContextMode]
  'update:syncScroll': [enabled: boolean]
  installGrammar: []
  loadLatest: []
}>();

const leftRef = ref<HTMLElement | null>(null);
const rightRef = ref<HTMLElement | null>(null);
const inlineRef = ref<HTMLElement | null>(null);
const rows = computed(() => props.model?.rows ?? []);
const client = useClient();
const syntaxCache = new Map<string, SyntaxSpan[]>();
const syntaxPageStates = new Map<string, 'queued-high' | 'queued-low' | 'loading' | 'done'>();
const highPrioritySyntaxQueue: SyntaxPageRequest[] = [];
const lowPrioritySyntaxQueue: SyntaxPageRequest[] = [];
const syntaxVersion = ref(0);
const initialSyntaxGateActive = ref(false);
let syntaxQueueRunning = false;
let isSyncingScroll = false;
let syntaxPrefetchTimer: number | undefined;
let initialSyntaxGateTimer: number | undefined;
let initialSyntaxGeneration = 0;
let syntaxRequestGeneration = 0;
const syntaxPageSize = 128;
const syntaxPageLookaround = 1;
const initialSyntaxGateMs = 80;

type SyntaxPageRequest = {
  key: string;
  fileId: string;
  context: DiffContextMode;
  side: SyntaxSide;
  page: number;
  startLine: number;
  endLine: number;
  generation: number;
};

const syntaxMessage = computed(() => {
  const syntax = props.model?.syntax;
  if (!syntax?.language) return undefined;
  if (syntax.grammarInstalled) return undefined;

  return `No ${syntax.language} grammar installed`;
});

const estimateSize = (index: number) => (rows.value[index]?.kind === 'hunk' ? 28 : 24);

const leftVirtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => leftRef.value,
    estimateSize,
    overscan: 12
  }))
);

const rightVirtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => rightRef.value,
    estimateSize,
    overscan: 12
  }))
);

const inlineVirtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => inlineRef.value,
    estimateSize,
    overscan: 12
  }))
);

const leftVirtualRows = computed(() => leftVirtualizer.value.getVirtualItems());
const rightVirtualRows = computed(() => rightVirtualizer.value.getVirtualItems());
const inlineVirtualRows = computed(() => inlineVirtualizer.value.getVirtualItems());
const leftTotalSize = computed(() => leftVirtualizer.value.getTotalSize());
const rightTotalSize = computed(() => rightVirtualizer.value.getTotalSize());
const inlineTotalSize = computed(() => inlineVirtualizer.value.getTotalSize());

const syntaxKey = (side: SyntaxSide, line: number) => `${side}:${line}`;

const syntaxForRow = (row: DiffRow, side: SyntaxSide) => {
  syntaxVersion.value;
  const line = side === 'old' ? row.oldLine : row.newLine;
  return line ? syntaxCache.get(syntaxKey(side, line)) : undefined;
};

const syntaxForInlineRow = (row: DiffRow) => {
  return syntaxForRow(row, row.kind === 'deleted' ? 'old' : 'new');
};

const syntaxPageKey = (fileId: string, context: DiffContextMode, side: SyntaxSide, page: number) => `${fileId}:${context}:${side}:${page}`;

const runSyntaxQueue = () => {
  if (syntaxQueueRunning) return;
  syntaxQueueRunning = true;

  const runNext = async () => {
    const request = highPrioritySyntaxQueue.shift() ?? lowPrioritySyntaxQueue.shift();
    if (!request) {
      syntaxQueueRunning = false;
      return;
    }

    const state = syntaxPageStates.get(request.key);
    if (state !== 'queued-high' && state !== 'queued-low') {
      void runNext();
      return;
    }

    syntaxPageStates.set(request.key, 'loading');
    try {
      const lines = await client.getSyntaxSpans(request.fileId, request.side, request.startLine, request.endLine, { context: request.context });
      const isCurrentRequest = request.generation === syntaxRequestGeneration && props.model?.fileId === request.fileId && props.model.context === request.context;
      if (isCurrentRequest) {
        for (const line of lines) syntaxCache.set(syntaxKey(request.side, line.line), line.spans);
        syntaxVersion.value += 1;
        syntaxPageStates.set(request.key, 'done');
      } else if (request.generation === syntaxRequestGeneration && syntaxPageStates.get(request.key) === 'loading') {
        syntaxPageStates.delete(request.key);
      }
    } catch {
      if (request.generation === syntaxRequestGeneration) syntaxPageStates.delete(request.key);
    }

    void runNext();
  };

  void runNext();
};

const requestSyntaxPage = (side: SyntaxSide, page: number, priority: 'high' | 'low') => {
  const model = props.model;
  if (!model?.syntax.grammarInstalled || page < 0) return false;

  const requestKey = syntaxPageKey(model.fileId, model.context, side, page);
  const existingState = syntaxPageStates.get(requestKey);
  if (existingState === 'done' || existingState === 'loading' || existingState === 'queued-high') return false;
  if (existingState === 'queued-low' && priority === 'low') return false;

  const fileId = model.fileId;
  const context = model.context;
  const startLine = page * syntaxPageSize + 1;
  const endLine = startLine + syntaxPageSize - 1;
  const request = { key: requestKey, fileId, context, side, page, startLine, endLine, generation: syntaxRequestGeneration };
  if (priority === 'high') {
    syntaxPageStates.set(requestKey, 'queued-high');
    highPrioritySyntaxQueue.push(request);
  } else {
    syntaxPageStates.set(requestKey, 'queued-low');
    lowPrioritySyntaxQueue.push(request);
  }
  runSyntaxQueue();
  return true;
};

const requestSyntaxPages = (side: SyntaxSide, startLine: number, endLine: number, priority: 'high' | 'low') => {
  const firstPage = Math.max(0, Math.floor((startLine - 1) / syntaxPageSize) - syntaxPageLookaround);
  const lastPage = Math.floor((endLine - 1) / syntaxPageSize) + syntaxPageLookaround;
  for (let page = firstPage; page <= lastPage; page += 1) requestSyntaxPage(side, page, priority);
};

const requestSyntaxForVirtualRows = (virtualRows: { index: number }[], side: SyntaxSide) => {
  let startLine = Number.POSITIVE_INFINITY;
  let endLine = 0;
  for (const virtualRow of virtualRows) {
    const row = rows.value[virtualRow.index];
    const line = side === 'old' ? row?.oldLine : row?.newLine;
    if (!line) continue;
    startLine = Math.min(startLine, line);
    endLine = Math.max(endLine, line);
  }
  if (Number.isFinite(startLine)) {
    requestSyntaxPages(side, startLine, endLine, 'high');
    scheduleSyntaxPrefetch();
  }
};

const firstLineForSide = (side: SyntaxSide) => {
  for (const row of rows.value) {
    const line = side === 'old' ? row.oldLine : row.newLine;
    if (line) return line;
  }
  return undefined;
};

const requestInitialSyntaxPages = () => {
  if (!props.model?.syntax.grammarInstalled) return;
  const oldLine = firstLineForSide('old');
  const newLine = firstLineForSide('new');
  if (oldLine) requestSyntaxPages('old', oldLine, oldLine, 'high');
  if (newLine) requestSyntaxPages('new', newLine, newLine, 'high');
};

const releaseInitialSyntaxGate = (generation: number) => {
  if (generation !== initialSyntaxGeneration) return;
  if (initialSyntaxGateTimer !== undefined) window.clearTimeout(initialSyntaxGateTimer);
  initialSyntaxGateTimer = undefined;
  initialSyntaxGateActive.value = false;
};

const startInitialSyntaxGate = () => {
  initialSyntaxGeneration += 1;
  const generation = initialSyntaxGeneration;
  if (!props.model?.syntax.grammarInstalled || rows.value.length === 0) {
    releaseInitialSyntaxGate(generation);
    return;
  }

  initialSyntaxGateActive.value = true;
  requestInitialSyntaxPages();
  initialSyntaxGateTimer = window.setTimeout(() => releaseInitialSyntaxGate(generation), initialSyntaxGateMs);

  const waitForInitialPages = async () => {
    while (generation === initialSyntaxGeneration && highPrioritySyntaxQueue.length > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 8));
    }
    releaseInitialSyntaxGate(generation);
  };
  void waitForInitialPages();
};

const maxLineForSide = (side: SyntaxSide) => {
  let maxLine = 0;
  for (const row of rows.value) {
    const line = side === 'old' ? row.oldLine : row.newLine;
    if (line) maxLine = Math.max(maxLine, line);
  }
  return maxLine;
};

const prefetchSyntaxSide = (side: SyntaxSide) => {
  const maxLine = maxLineForSide(side);
  if (maxLine === 0) return;
  const lastPage = Math.floor((maxLine - 1) / syntaxPageSize);
  for (let page = 0; page <= lastPage; page += 1) requestSyntaxPage(side, page, 'low');
};

const prefetchAllSyntaxPages = () => {
  if (!props.model?.syntax.grammarInstalled) return;
  if (highPrioritySyntaxQueue.length > 0) {
    scheduleSyntaxPrefetch();
    return;
  }
  prefetchSyntaxSide('old');
  prefetchSyntaxSide('new');
};

const scheduleSyntaxPrefetch = () => {
  if (syntaxPrefetchTimer !== undefined) window.clearTimeout(syntaxPrefetchTimer);
  syntaxPrefetchTimer = window.setTimeout(() => {
    syntaxPrefetchTimer = undefined;
    prefetchAllSyntaxPages();
  }, 900);
};

const syncScrollPosition = (source: HTMLElement, target: HTMLElement | null) => {
  if (!props.syncScroll || !target) return;
  isSyncingScroll = true;
  target.scrollTop = source.scrollTop;
  target.scrollLeft = source.scrollLeft;
  requestAnimationFrame(() => {
    isSyncingScroll = false;
  });
};

const onLeftScroll = (event: Event) => {
  if (isSyncingScroll) return;
  syncScrollPosition(event.currentTarget as HTMLElement, rightRef.value);
};

const onRightScroll = (event: Event) => {
  if (isSyncingScroll) return;
  syncScrollPosition(event.currentTarget as HTMLElement, leftRef.value);
};

watch(
  () => props.syncScroll,
  (enabled) => {
    if (enabled && leftRef.value && rightRef.value) syncScrollPosition(leftRef.value, rightRef.value);
  }
);

watch(
  () => `${props.model?.fileId ?? ''}:${props.model?.context ?? ''}`,
  () => {
    syntaxRequestGeneration += 1;
    syntaxCache.clear();
    syntaxPageStates.clear();
    highPrioritySyntaxQueue.length = 0;
    lowPrioritySyntaxQueue.length = 0;
    syntaxQueueRunning = false;
    if (syntaxPrefetchTimer !== undefined) window.clearTimeout(syntaxPrefetchTimer);
    syntaxPrefetchTimer = undefined;
    if (initialSyntaxGateTimer !== undefined) window.clearTimeout(initialSyntaxGateTimer);
    initialSyntaxGateTimer = undefined;
    initialSyntaxGateActive.value = false;
    syntaxVersion.value += 1;
    startInitialSyntaxGate();
  }
);

watch(
  [leftVirtualRows, rightVirtualRows, inlineVirtualRows, () => props.model?.syntax.grammarInstalled, () => props.viewMode],
  () => {
    if (props.viewMode === 'split') {
      requestSyntaxForVirtualRows(leftVirtualRows.value, 'old');
      requestSyntaxForVirtualRows(rightVirtualRows.value, 'new');
    } else {
      requestSyntaxForVirtualRows(inlineVirtualRows.value, 'old');
      requestSyntaxForVirtualRows(inlineVirtualRows.value, 'new');
    }
  },
  { immediate: true, flush: 'post' }
);
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

.syntax-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  padding: 2px 7px;
  color: #d3a45f;
  background: rgba(211, 164, 95, 0.12);
  border: 1px solid rgba(211, 164, 95, 0.2);
  border-radius: 999px;
}

.update-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  padding: 2px 7px;
  color: #8fd6ff;
  background: rgba(77, 166, 255, 0.12);
  border: 1px solid rgba(77, 166, 255, 0.24);
  border-radius: 999px;
}

.install-grammar,
.load-latest {
  padding: 0 6px;
  border-radius: 999px;
  cursor: pointer;
  font: inherit;

  &:disabled {
    cursor: default;
    opacity: 0.65;
  }
}

.install-grammar {
  color: #f3c98b;
  background: rgba(211, 164, 95, 0.16);
  border: 1px solid rgba(211, 164, 95, 0.28);
}

.load-latest {
  color: #d7f1ff;
  background: rgba(77, 166, 255, 0.16);
  border: 1px solid rgba(77, 166, 255, 0.32);
}

.install-step {
  max-width: 220px;
  overflow: hidden;
  color: #aeb7c6;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.syntax-gate {
  min-height: 0;
  background: #111318;
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
