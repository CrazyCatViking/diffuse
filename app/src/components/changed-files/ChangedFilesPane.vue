<template>
  <aside class="changed-files">
    <header class="pane-header">
      <div>
        <Badge tone="review">Workspace</Badge>

        <h2>Changed files</h2>
      </div>

      <Badge tone="neutral">{{ files.length }} {{ files.length === 1 ? 'file' : 'files' }}</Badge>
    </header>

    <EmptyState
      v-if="files.length === 0"
      class="sidebar-empty"
      align="start"
      bordered
      title="No changed files"
      description="Pick another compare target or refresh after editing files."
    />

    <template v-else>
      <template v-for="node in visibleNodes" :key="node.key">
        <div
          v-if="node.type === 'folder'"
          class="folder-row"
          :class="{ active: node.key === activeFolderPath, reviewed: folderReviewed(node) }"
          :style="{ '--depth': node.depth }"
        >
          <input
            class="review-checkbox"
            type="checkbox"
            :checked="folderReviewed(node)"
            :title="folderReviewed(node) ? 'Mark folder unreviewed' : 'Mark folder reviewed'"
            :aria-label="folderReviewed(node) ? 'Mark folder unreviewed' : 'Mark folder reviewed'"
            @click.stop
            @change="setFolderReviewed(node, ($event.target as HTMLInputElement).checked)"
          />

          <button
            class="chevron-button"
            type="button"
            :aria-label="collapsedFolders.has(node.key) ? `Expand ${node.name}` : `Collapse ${node.name}`"
            @click="toggleFolder(node.key)"
          >
            <span class="chevron">{{ collapsedFolders.has(node.key) ? '›' : '⌄' }}</span>
          </button>

          <button class="folder-select" type="button" :title="node.path" @click="selectFolder(node)">
            <span class="folder-name">{{ node.name }}</span>
          </button>
        </div>

        <ChangedFileRow
          v-else
          :file="node.file"
          :name="node.name"
          :depth="node.depth"
          :active="node.file.id === activeFileId"
          :reviewed="reviewedFileIds.includes(node.file.id)"
          @select="$emit('selectFile', $event)"
          @set-reviewed="$emit('setReviewed', $event)"
        />
      </template>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChangedFile } from '../../lib/protocol';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import ChangedFileRow from './ChangedFileRow.vue';

type TreeFolder = {
  type: 'folder';
  key: string;
  name: string;
  path: string;
  depth: number;
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

const props = defineProps<{
  files: ChangedFile[];
  activeFileId?: string;
  activeFolderPath?: string;
  reviewedFileIds: string[];
}>();

const emit = defineEmits<{
  selectFile: [fileId: string];
  selectFolder: [folder: { path: string; files: ChangedFile[] }];
  setReviewed: [payload: { fileId: string; reviewed: boolean }];
  setFolderReviewed: [payload: { files: ChangedFile[]; reviewed: boolean }];
}>();

const collapsedFolders = ref(new Set<string>());

const tree = computed(() => buildTree(props.files));
const visibleNodes = computed(() => visibleTreeNodes(tree.value));

const toggleFolder = (key: string) => {
  const next = new Set(collapsedFolders.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedFolders.value = next;
};

const selectFolder = (folder: TreeFolder) => {
  emit('selectFolder', { path: folder.path, files: folderFiles(folder) });
};

const folderReviewed = (folder: TreeFolder) => {
  const files = folderFiles(folder);
  return files.length > 0 && files.every((file) => props.reviewedFileIds.includes(file.id));
};

const setFolderReviewed = (folder: TreeFolder, reviewed: boolean) => {
  emit('setFolderReviewed', { files: folderFiles(folder), reviewed });
};

const folderFiles = (folder: TreeFolder): ChangedFile[] => {
  const files: ChangedFile[] = [];
  for (const child of folder.children) {
    if (child.type === 'file') files.push(child.file);
    else files.push(...folderFiles(child));
  }
  return files;
};

const visibleTreeNodes = (nodes: TreeNode[]): TreeNode[] => {
  const visible: TreeNode[] = [];
  for (const node of nodes) {
    visible.push(node);
    if (node.type === 'folder' && !collapsedFolders.value.has(node.key)) {
      visible.push(...visibleTreeNodes(node.children));
    }
  }
  return visible;
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
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: var(--space-6);
}

h2 {
  margin: var(--space-3) 0 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-sm);
  line-height: 1.2;
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

.folder-row {
  display: grid;
  grid-template-columns: 16px calc(18px + (var(--depth) * 16px)) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: center;
  width: 100%;
  padding: var(--space-4) var(--space-5);
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-3);
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);

  &:hover {
    background: var(--color-bg-hover);
  }

  &.active {
    background: var(--color-bg-active);
    border-color: var(--color-border-default);
  }
}

.folder-row.reviewed .folder-name {
  color: var(--color-success);
}

.review-checkbox {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.chevron-button,
.folder-select {
  min-width: 0;
  padding: 0;
  color: inherit;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
}

.chevron-button {
  display: grid;
  justify-self: end;
  place-items: center;
  width: 18px;
  height: 22px;
  border-radius: 5px;

  &:hover {
    background: var(--color-bg-active);
  }
}

.folder-select {
  height: 22px;
}

.chevron {
  color: var(--color-text-subtle);
  font-size: 15px;
  line-height: 1;
}

.folder-name {
  overflow: hidden;
  font-size: var(--font-size-body);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
