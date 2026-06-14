<template>
  <section class="folder-diff-viewer">
    <div class="folder-header">
      <div class="folder-meta">
        <span>{{ folderPath }}</span>
        <span class="file-count">{{ files.length }} file{{ files.length === 1 ? '' : 's' }}</span>
      </div>

      <div class="controls">
        <button class="control" :class="{ active: viewMode === 'split' }" type="button" @click="emit('update:viewMode', 'split')">Split</button>
        <button class="control" :class="{ active: viewMode === 'inline' }" type="button" @click="emit('update:viewMode', 'inline')">Inline</button>
        <button class="control" :class="{ active: contextMode === 'full' }" type="button" @click="emit('update:contextMode', contextMode === 'full' ? 'diff' : 'full')">
          {{ contextMode === 'full' ? 'Full file' : 'Diff only' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="message">Loading folder diff...</div>
    <div v-else-if="error" class="message error">{{ error }}</div>
    <div v-else-if="models.length === 0" class="message">No diffs in this folder.</div>
    <div v-else class="folder-diffs">
      <article v-for="model in models" :key="model.fileId" class="file-diff">
        <header class="file-header">
          <span>{{ model.fileId }}</span>
          <span>{{ model.rows.length }} rows</span>
        </header>

        <div v-if="model.rows.length === 0" class="empty-file">No diff for this file.</div>
        <template v-else-if="viewMode === 'split'">
          <SplitDiffRow
            v-for="(row, index) in model.rows"
            :key="`${model.fileId}:${index}`"
            :row="row"
            :old-syntax-spans="syntaxForRow(model.fileId, row, 'old')"
            :new-syntax-spans="syntaxForRow(model.fileId, row, 'new')"
          />
        </template>
        <template v-else>
          <InlineDiffRow
            v-for="(row, index) in model.rows"
            :key="`${model.fileId}:${index}`"
            :row="row"
            :syntax-spans="syntaxForInlineRow(model.fileId, row)"
          />
        </template>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ChangedFile, DiffContextMode, DiffRenderModel, DiffRow, DiffTarget, DiffViewMode, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import { useClient } from '../../lib/useClient';
import InlineDiffRow from './InlineDiffRow.vue';
import SplitDiffRow from './SplitDiffRow.vue';

const props = defineProps<{
  folderPath: string;
  files: ChangedFile[];
  target: DiffTarget;
  viewMode: DiffViewMode;
  contextMode: DiffContextMode;
}>();

const emit = defineEmits<{
  'update:viewMode': [mode: DiffViewMode];
  'update:contextMode': [mode: DiffContextMode];
}>();

const client = useClient();
const models = ref<DiffRenderModel[]>([]);
const loading = ref(false);
const error = ref<string>();
const syntaxSpans = ref<Record<string, SyntaxSpan[]>>({});
let loadGeneration = 0;

const loadFolderDiff = async () => {
  const generation = ++loadGeneration;
  loading.value = true;
  error.value = undefined;
  models.value = [];
  syntaxSpans.value = {};

  try {
    const loaded: DiffRenderModel[] = [];
    for (const file of props.files) {
      const model = await client.getDiffRenderModel(file.id, { mode: props.viewMode, context: props.contextMode }, props.target);
      if (generation !== loadGeneration) return;
      loaded.push(model);
      models.value = [...loaded];
      void loadSyntaxForModel(model, generation);
    }
  } catch (err) {
    if (generation === loadGeneration) error.value = err instanceof Error ? err.message : JSON.stringify(err);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
};

const loadSyntaxForModel = async (model: DiffRenderModel, generation: number) => {
  if (!model.syntax.grammarInstalled) return;

  await Promise.all([
    loadSyntaxSide(model, 'old', maxLineForSide(model.rows, 'old'), generation),
    loadSyntaxSide(model, 'new', maxLineForSide(model.rows, 'new'), generation),
  ]);
};

const loadSyntaxSide = async (model: DiffRenderModel, side: SyntaxSide, maxLine: number, generation: number) => {
  if (maxLine === 0) return;

  try {
    const lines = await client.getSyntaxSpans(model.fileId, side, 1, maxLine, { context: props.contextMode }, props.target);
    if (generation !== loadGeneration) return;

    const next = { ...syntaxSpans.value };
    for (const line of lines) next[syntaxKey(model.fileId, side, line.line)] = line.spans;
    syntaxSpans.value = next;
  } catch {
    // Keep the folder diff usable even if syntax loading fails for a file.
  }
};

const maxLineForSide = (rows: DiffRow[], side: SyntaxSide) => {
  let maxLine = 0;
  for (const row of rows) {
    const line = side === 'old' ? row.oldLine : row.newLine;
    if (line) maxLine = Math.max(maxLine, line);
  }
  return maxLine;
};

const syntaxForRow = (fileId: string, row: DiffRow, side: SyntaxSide) => {
  const line = side === 'old' ? row.oldLine : row.newLine;
  return line ? syntaxSpans.value[syntaxKey(fileId, side, line)] : undefined;
};

const syntaxForInlineRow = (fileId: string, row: DiffRow) => {
  return syntaxForRow(fileId, row, row.kind === 'deleted' ? 'old' : 'new');
};

const syntaxKey = (fileId: string, side: SyntaxSide, line: number) => `${fileId}:${side}:${line}`;

watch(
  () => [props.folderPath, props.files.map((file) => file.id).join('\n'), props.contextMode, JSON.stringify(props.target)],
  () => {
    void loadFolderDiff();
  },
  { immediate: true }
);
</script>

<style scoped lang="scss">
.folder-diff-viewer {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  background: #111318;
}

.folder-header,
.file-header {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.folder-header {
  padding: 10px 14px;
  border-bottom: 1px solid #252a35;
  background: #151821;
}

.folder-meta {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
  color: #f5f7fb;
  font-weight: 650;
}

.file-count,
.file-header span:last-child {
  color: #7e8aa0;
  font-size: 12px;
  font-weight: 500;
}

.controls {
  display: flex;
  gap: 6px;
}

.control {
  color: #cbd5e1;
  background: #202635;
  border: 1px solid #2b3344;
  border-radius: 8px;
  padding: 5px 9px;
  cursor: pointer;

  &.active {
    color: #ffffff;
    background: #2d63d8;
    border-color: #2d63d8;
  }
}

.folder-diffs {
  min-height: 0;
  overflow: auto;
}

.file-diff {
  margin: 0 0 18px;
  border-bottom: 1px solid #252a35;
}

.file-header {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 9px 12px;
  color: #d8dee9;
  background: #171c27;
  border-top: 1px solid #252a35;
  border-bottom: 1px solid #252a35;
  font-size: 13px;
  font-weight: 650;
}

.message,
.empty-file {
  padding: 18px;
  color: #7e8aa0;
  font-size: 13px;
}

.error {
  color: #ff8d8d;
}
</style>
