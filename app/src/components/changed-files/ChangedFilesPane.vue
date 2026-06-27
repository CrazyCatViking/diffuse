<template>
  <aside class="changed-files">
    <button class="overview-row" :class="{ active: overviewActive }" type="button" @click="emit('selectOverview')">
      <span class="overview-icon">R</span>

      <span class="overview-copy">
        <span class="overview-title">Review overview</span>

        <span class="overview-subtitle">Session state, threads, diagnostics</span>
      </span>
    </button>

    <header class="pane-header">
      <h2>Changed files</h2>

      <Badge tone="neutral">{{ fileCountLabel }}</Badge>
    </header>

    <div v-if="files.length > 0" class="search-stack">
      <SearchInput
        :model-value="search.treeQuery"
        compact
        placeholder="Find files, comments, filters..."
        label="Search changed files"
        @update:model-value="search.setTreeQuery($event)"
      />

      <SearchFilterChips :active-filters="search.treeActiveFilters" @toggle="search.toggleTreeFilter($event)" />

      <div v-if="search.treeHasActiveSearch" class="search-summary">
        <Badge tone="review">{{ filteredFiles.length }} matching</Badge>

        <button class="summary-action" type="button" @click="search.pinTreeResults()">Pin results</button>

        <button class="summary-action" type="button" @click="search.clearTreeQuery()">Clear</button>
      </div>
    </div>

    <EmptyState
      v-if="files.length === 0"
      class="sidebar-empty"
      align="start"
      bordered
      title="No changed files"
      description="Pick another compare target or refresh after editing files."
    />

    <EmptyState
      v-else-if="treeListNodes.length === 0"
      class="sidebar-empty"
      align="start"
      bordered
      title="No matching files"
      description="Try a different filename, path segment, or filter."
    />

    <!-- @vue-generic {TreeNode} -->
    <TreeList v-else v-model:collapsed-keys="collapsedFolders" class="changed-file-tree" :nodes="treeListNodes" aria-label="Changed files">
      <template #leading="{ node }">
        <input
          v-if="node.data?.type === 'folder'"
          class="review-checkbox"
          type="checkbox"
          :checked="folderReviewed(node.data)"
          :title="folderReviewed(node.data) ? 'Mark folder unreviewed' : 'Mark folder reviewed'"
          :aria-label="folderReviewed(node.data) ? 'Mark folder unreviewed' : 'Mark folder reviewed'"
          @click.stop
          @change="setFolderReviewed(node.data, ($event.target as HTMLInputElement).checked)"
        />

        <input
          v-else-if="node.data?.type === 'file'"
          class="review-checkbox"
          type="checkbox"
          :checked="reviewedFileIdSet.has(node.data.file.id)"
          :title="reviewedFileIdSet.has(node.data.file.id) ? 'Mark file unreviewed' : 'Mark file reviewed'"
          :aria-label="reviewedFileIdSet.has(node.data.file.id) ? 'Mark file unreviewed' : 'Mark file reviewed'"
          @click.stop
          @change="emit('setReviewed', { fileId: node.data.file.id, reviewed: ($event.target as HTMLInputElement).checked })"
        />
      </template>

      <template #default="{ node }">
        <button
          v-if="node.data?.type === 'folder'"
          class="folder-select"
          type="button"
          :title="node.data.path"
          @click="selectFolder(node.data)"
        >
          <span class="folder-name">{{ node.data.name }}</span>
        </button>

        <button
          v-else-if="node.data?.type === 'file'"
          class="file-select"
          type="button"
          :title="node.data.path"
          @click="emit('selectFile', node.data.file.id)"
        >
          <span class="status" :class="fileStatusClass(node.data.file)">{{ fileStatusLabel(node.data.file) }}</span>

          <span class="file-path">
            <SearchMatchHighlight
              v-if="fileNameRanges(node.data.file.id).length"
              :text="node.data.name"
              :ranges="fileNameRanges(node.data.file.id)"
            />

            <template v-else>{{ node.data.name }}</template>
          </span>
        </button>
      </template>

      <template #actions="{ node }">
        <span v-if="node.data?.type === 'file'" class="file-meta">
          <span class="counts">
            <span class="additions">+{{ node.data.file.additions }}</span>

            <span class="deletions">-{{ node.data.file.deletions }}</span>
          </span>

          <span v-if="fileMetadata(node.data.file.id)?.unresolvedCount" class="meta-pill warning"
            >{{ fileMetadata(node.data.file.id)?.unresolvedCount }} open</span
          >

          <span v-else-if="fileMetadata(node.data.file.id)?.commentCount" class="meta-pill"
            >{{ fileMetadata(node.data.file.id)?.commentCount }} c</span
          >

          <span v-if="fileMetadata(node.data.file.id)?.generated" class="meta-pill">gen</span>
        </span>
      </template>
    </TreeList>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChangedFile } from '../../lib/protocol';
import type { FileSearchMetadata, SearchMatchRange } from '../../lib/search/searchTypes';
import { useSearchStore } from '../../stores/search';
import SearchMatchHighlight from '../search/SearchMatchHighlight.vue';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import TreeList, { type TreeListNode } from '../ui/TreeList.vue';
import SearchFilterChips from '../search/SearchFilterChips.vue';
import SearchInput from '../search/SearchInput.vue';

type TreeFolder = {
  type: 'folder';
  key: string;
  name: string;
  path: string;
  depth: number;
  compactedPaths?: string[];
  children: TreeNode[];
};

type TreeFile = {
  type: 'file';
  key: string;
  name: string;
  path: string;
  depth: number;
  file: ChangedFile;
};

type TreeNode = TreeFolder | TreeFile;
type FolderSummary = {
  files: ChangedFile[];
  reviewed: boolean;
};

const props = defineProps<{
  files: ChangedFile[];
  activeFileId?: string;
  activeFolderPath?: string;
  overviewActive: boolean;
  reviewedFileIds: string[];
}>();

const emit = defineEmits<{
  selectOverview: [];
  selectFile: [fileId: string];
  selectFolder: [folder: { path: string; files: ChangedFile[] }];
  setReviewed: [payload: { fileId: string; reviewed: boolean }];
  setFolderReviewed: [payload: { files: ChangedFile[]; reviewed: boolean }];
}>();

const search = useSearchStore();
const collapsedFolders = ref(new Set<string>());

const reviewedFileIdSet = computed(() => new Set(props.reviewedFileIds));
const filteredFiles = computed(() => {
  if (!search.treeHasActiveSearch) return props.files;
  const resultFileIds = new Set(search.treeResults.map((result) => result.fileId).filter((fileId): fileId is string => Boolean(fileId)));
  return props.files.filter((file) => resultFileIds.has(file.id));
});
const searchFilesById = computed(() => new Map(search.searchableFiles.map((file) => [file.file.id, file])));
const searchResultsByFileId = computed(() => {
  if (!search.treeHasActiveSearch) return new Map<string, (typeof search.treeResults)[number]>();
  const results = new Map<string, (typeof search.treeResults)[number]>();
  for (const result of search.treeResults) {
    if (result.kind === 'file') results.set(result.fileId, result);
  }
  return results;
});
const fileCountLabel = computed(() => {
  if (!search.treeHasActiveSearch) return `${props.files.length} ${props.files.length === 1 ? 'file' : 'files'}`;
  return `${filteredFiles.value.length}/${props.files.length}`;
});
const tree = computed(() => buildTree(filteredFiles.value));
const displayTree = computed(() => compactFolderChains(tree.value));
const folderSummaries = computed(() => buildFolderSummaries(tree.value));
const treeListNodes = computed<TreeListNode<TreeNode>[]>(() => toTreeListNodes(displayTree.value));

const fileNameRanges = (fileId: string): SearchMatchRange[] =>
  search.treeHasActiveSearch
    ? (searchResultsByFileId.value.get(fileId)?.matches.find((match) => match.field === 'name')?.ranges ?? [])
    : [];

const fileMetadata = (fileId: string): FileSearchMetadata | undefined => searchFilesById.value.get(fileId)?.metadata;

const selectFolder = (folder: TreeFolder) => {
  emit('selectFolder', { path: folder.path, files: folderFiles(folder) });
};

const folderReviewed = (folder: TreeFolder) => {
  return folderSummaries.value.get(folder.key)?.reviewed ?? false;
};

const setFolderReviewed = (folder: TreeFolder, reviewed: boolean) => {
  emit('setFolderReviewed', { files: folderFiles(folder), reviewed });
};

const folderFiles = (folder: TreeFolder): ChangedFile[] => {
  const summary = folderSummaries.value.get(folder.key);
  if (summary) return summary.files;

  const files: ChangedFile[] = [];
  for (const child of folder.children) {
    if (child.type === 'file') files.push(child.file);
    else files.push(...folderFiles(child));
  }
  return files;
};

const buildFolderSummaries = (nodes: TreeNode[]): Map<string, FolderSummary> => {
  const summaries = new Map<string, FolderSummary>();
  const collect = (node: TreeNode): ChangedFile[] => {
    if (node.type === 'file') return [node.file];

    const files = node.children.flatMap(collect);
    summaries.set(node.key, {
      files,
      reviewed: files.length > 0 && files.every((file) => reviewedFileIdSet.value.has(file.id)),
    });
    return files;
  };

  for (const node of nodes) collect(node);
  return summaries;
};

const buildTree = (files: ChangedFile[]): TreeNode[] => {
  const root: TreeFolder = { type: 'folder', key: '', name: '', path: '', depth: -1, children: [] };
  const folders = new Map<string, TreeFolder>([['', root]]);

  for (const file of files) {
    const path = file.newPath ?? file.oldPath ?? file.id;
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop() ?? path;
    let parent = root;
    let parentPath = '';

    for (const folderName of parts) {
      const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      let folder = folders.get(folderPath);
      if (!folder) {
        folder = { type: 'folder', key: folderPath, name: folderName, path: folderPath, depth: parent.depth + 1, children: [] };
        folders.set(folderPath, folder);
        parent.children.push(folder);
      }
      parent = folder;
      parentPath = folderPath;
    }

    parent.children.push({ type: 'file', key: file.id, name: fileName, path, depth: parent.depth + 1, file });
  }

  sortTree(root.children);
  return root.children;
};

const compactFolderChains = (nodes: TreeNode[]): TreeNode[] => nodes.map(compactFolderChain);

const compactFolderChain = (node: TreeNode): TreeNode => {
  if (node.type === 'file') return node;

  let folder = node;
  const names = [node.name];
  const compactedPaths = [node.path];
  while (folder.children.length === 1 && folder.children[0]?.type === 'folder') {
    folder = folder.children[0];
    names.push(folder.name);
    compactedPaths.push(folder.path);
  }

  return {
    ...folder,
    name: names.join('/'),
    depth: node.depth,
    compactedPaths,
    children: compactFolderChains(folder.children),
  };
};

const toTreeListNodes = (nodes: TreeNode[]): TreeListNode<TreeNode>[] =>
  nodes.map((node) => ({
    key: node.key,
    label: node.name,
    title: node.path,
    active: node.type === 'folder' ? folderActive(node) : node.file.id === props.activeFileId,
    rowClass: {
      'folder-row': node.type === 'folder',
      'file-row': node.type === 'file',
      reviewed: node.type === 'folder' ? folderReviewed(node) : reviewedFileIdSet.value.has(node.file.id),
    },
    data: node,
    children: node.type === 'folder' ? toTreeListNodes(node.children) : undefined,
  }));

const folderActive = (folder: TreeFolder) => {
  const activePath = props.activeFolderPath;
  if (!activePath) return false;
  return folder.key === activePath || folder.compactedPaths?.includes(activePath) === true;
};

const fileStatusLabel = (file: ChangedFile) => {
  return {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  }[file.status];
};

const fileStatusClass = (file: ChangedFile) => `status-${file.status}`;

const sortTree = (nodes: TreeNode[]) => {
  nodes.sort((first, second) => {
    if (first.type !== second.type) return first.type === 'folder' ? -1 : 1;
    return first.name.localeCompare(second.name);
  });

  for (const node of nodes) {
    if (node.type === 'folder') sortTree(node.children);
  }
};
</script>

<style scoped lang="scss">
.changed-files {
  min-width: 0;
  height: 100%;
  padding: var(--space-6);
  overflow: auto;
  background: var(--color-bg-shell);
  border-right: 1px solid var(--color-border-subtle);
}

.pane-header {
  display: flex;
  gap: var(--space-6);
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-6);
}

.search-stack {
  position: sticky;
  top: calc(-1 * var(--space-6));
  z-index: 2;
  display: grid;
  gap: var(--space-4);
  margin: calc(-1 * var(--space-6)) calc(-1 * var(--space-6)) var(--space-6);
  padding: var(--space-6) var(--space-6) var(--space-5);
  background: var(--color-bg-shell);
  border-bottom: 1px solid var(--color-border-subtle);
  box-shadow: 0 var(--space-3) var(--space-5) var(--color-bg-shell);
}

.search-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.summary-action {
  padding: 0;
  color: var(--color-text-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
  font-size: var(--font-size-label);
  font-weight: 650;

  &:hover {
    color: var(--color-text-primary);
  }
}

h2 {
  margin: var(--space-3) 0 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-sm);
  line-height: 1.2;
}

.overview-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: var(--space-4);
  align-items: center;
  width: 100%;
  min-width: 0;
  margin-bottom: var(--space-6);
  padding: var(--space-5);
  color: var(--color-text-secondary);
  text-align: left;
  cursor: pointer;
  background: var(--color-bg-panel);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-4);
  font: inherit;
  box-shadow: var(--shadow-inset-highlight);
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);

  &:hover {
    background: var(--color-bg-hover);
    border-color: var(--color-border-default);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }

  &.active {
    background: var(--color-review-muted);
    border-color: var(--color-border-default);
  }
}

.overview-icon {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  color: var(--color-review);
  background: var(--color-review-muted);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-3);
  font-size: var(--font-size-body-lg);
  line-height: 1;
}

.overview-copy {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.overview-title,
.overview-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview-title {
  color: var(--color-text-primary);
  font-weight: 700;
}

.overview-subtitle {
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
}

.sidebar-empty {
  padding: var(--space-7);

  :deep(h1) {
    font-size: var(--font-size-heading-sm);
  }

  :deep(p) {
    font-size: var(--font-size-body);
  }
}

.changed-file-tree :deep(.tree-row.reviewed .folder-name),
.changed-file-tree :deep(.tree-row.reviewed .file-path) {
  color: var(--color-success);
}

.review-checkbox {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--color-accent);
  cursor: pointer;

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.folder-select,
.file-select {
  width: 100%;
  min-width: 0;
  padding: 0;
  color: inherit;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  font: inherit;

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.folder-select {
  height: 22px;
}

.file-select {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: var(--space-3);
  align-items: center;
}

.folder-name,
.file-path {
  overflow: hidden;
  font-size: var(--font-size-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-name {
  font-weight: 650;
}

.status {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--color-text-muted);
  background: rgba(143, 151, 166, 0.1);
  border: 1px solid rgba(143, 151, 166, 0.18);
  border-radius: var(--radius-2);
  font-size: var(--font-size-caption);
  font-weight: 700;
}

.status-added {
  color: var(--color-success);
  background: var(--color-success-muted);
  border-color: rgba(91, 184, 119, 0.25);
}

.status-modified,
.status-renamed {
  color: var(--color-ai);
  background: var(--color-ai-muted);
  border-color: rgba(143, 179, 255, 0.25);
}

.status-deleted {
  color: var(--color-danger);
  background: var(--color-danger-muted);
  border-color: rgba(255, 107, 107, 0.25);
}

.file-meta {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
  min-width: 0;
}

.counts {
  display: inline-flex;
  gap: var(--space-3);
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
}

.additions {
  color: var(--color-success);
}

.deletions {
  color: var(--color-danger);
}

.meta-pill {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 0 var(--space-2);
  color: var(--color-text-muted);
  background: rgba(143, 151, 166, 0.1);
  border: 1px solid rgba(143, 151, 166, 0.18);
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 750;
  line-height: 1;
  text-transform: uppercase;
}

.meta-pill.warning {
  color: var(--color-warning);
  background: var(--color-warning-muted);
  border-color: rgba(240, 184, 106, 0.25);
}
</style>
