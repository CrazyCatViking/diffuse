<template>
  <aside class="changed-files">
    <div class="pane-title">Changed Files</div>
    <div v-if="files.length === 0" class="empty">No changed files</div>
    <template v-else>
      <template v-for="node in visibleNodes" :key="node.key">
        <div v-if="node.type === 'folder'" class="folder-row" :class="{ active: node.key === activeFolderPath, reviewed: folderReviewed(node) }" :style="{ '--depth': node.depth }">
          <input
            class="review-checkbox"
            type="checkbox"
            :checked="folderReviewed(node)"
            :title="folderReviewed(node) ? 'Mark folder unreviewed' : 'Mark folder reviewed'"
            :aria-label="folderReviewed(node) ? 'Mark folder unreviewed' : 'Mark folder reviewed'"
            @click.stop
            @change="setFolderReviewed(node, ($event.target as HTMLInputElement).checked)"
          />
          <button class="chevron-button" type="button" :aria-label="collapsedFolders.has(node.key) ? `Expand ${node.name}` : `Collapse ${node.name}`" @click="toggleFolder(node.key)">
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
  padding: 12px;
  overflow: auto;
  border-right: 1px solid #252a35;
  background: #151821;
}

.pane-title {
  margin-bottom: 10px;
  color: #7e8aa0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.empty {
  color: #6e7685;
  font-size: 13px;
}

.folder-row {
  display: grid;
  grid-template-columns: 16px calc(18px + (var(--depth) * 16px)) minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 7px 10px;
  color: #aab4c5;
  background: transparent;
  border-radius: 8px;

  &:hover {
    background: #202635;
  }

  &.active {
    background: #202635;
  }
}

.folder-row.reviewed .folder-name {
  color: #92d6a4;
}

.review-checkbox {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: #4b7bec;
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
    background: #2a3140;
  }
}

.folder-select {
  height: 22px;
}

.chevron {
  color: #7e8aa0;
  font-size: 15px;
  line-height: 1;
}

.folder-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
