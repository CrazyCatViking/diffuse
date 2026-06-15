<template>
  <div class="app-shell">
    <TopBar
      :repo-path="repo.repository?.root"
      :version="repo.version?.version"
      :loading="repo.loading"
      :error="repo.error"
      @open-repository="showRecentRepositories = true"
      @refresh="repo.refreshChangedFiles()"
      @open-settings="showSettings = true"
    />

    <RecentRepositoriesDialog
      v-if="showRecentRepositories"
      :repositories="repo.recentRepositories"
      :loading="repo.loading"
      @close="showRecentRepositories = false"
      @open-new="openNewRepository"
      @open-recent="openRecentRepository"
    />

    <SettingsView v-if="showSettings" @close="showSettings = false" />

    <template v-else>
      <DiffTargetBar
        :target="repo.diffTarget"
        :defaults="repo.diffTargetDefaults"
        :branches="repo.branches"
        :loading="repo.loading"
        @apply="applyDiffTarget"
        @reset="repo.resetDiffTarget()"
      />

      <ReviewAgentBar
        :enabled="Boolean(repo.repository && repo.changedFiles.length > 0)"
        :loading="review.loading"
        :progress="review.progress"
        :active-run="review.activeRun"
        :open-thread-count="review.openThreads.length"
        :error="review.error"
        @start="review.startAgentReview()"
        @stop="review.stopAgentReview()"
      />

      <main class="workspace" :class="{ resizing: fileTreeResizing }" :style="{ gridTemplateColumns: `${fileTreeWidth}px 6px minmax(0, 1fr)` }">
        <ChangedFilesPane
          :files="repo.changedFiles"
          :active-file-id="repo.activeFileId"
          :active-folder-path="selectedFolder?.path"
          @select-file="selectFile"
          @select-folder="selectFolder"
        />
        <div
          class="resize-handle"
          role="separator"
          aria-label="Resize file tree"
          aria-orientation="vertical"
          :aria-valuenow="fileTreeWidth"
          :aria-valuemin="minFileTreeWidth"
          :aria-valuemax="maxFileTreeWidth"
          @pointerdown="startFileTreeResize"
        />
        <FolderDiffViewer
          v-if="selectedFolder"
          :folder-path="selectedFolder.path"
          :files="selectedFolder.files"
          :target="repo.diffTarget"
          :view-mode="diff.viewMode"
          :context-mode="diff.contextMode"
          @update:view-mode="diff.setViewMode($event)"
          @update:context-mode="diff.setContextMode($event)"
        />
        <DiffViewer
          v-else
          :model="diff.current"
          :loading="diff.loading"
          :error="diff.error"
          :view-mode="diff.viewMode"
          :context-mode="diff.contextMode"
          :target="repo.diffTarget"
          :sync-scroll="diff.syncScroll"
          :installing-grammar="diff.installingGrammar"
          :grammar-install-step="diff.grammarInstallStep"
          :has-new-changes="diff.hasNewChanges"
          @update:view-mode="diff.setViewMode($event)"
          @update:context-mode="diff.setContextMode($event)"
          @update:sync-scroll="diff.setSyncScroll($event)"
          @install-grammar="diff.installMissingGrammar()"
          @load-latest="repo.activeFileId && diff.loadDiff(repo.activeFileId)"
        />
      </main>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ChangedFilesPane from './components/changed-files/ChangedFilesPane.vue';
import DiffTargetBar from './components/diff/DiffTargetBar.vue';
import DiffViewer from './components/diff/DiffViewer.vue';
import FolderDiffViewer from './components/diff/FolderDiffViewer.vue';
import TopBar from './components/layout/TopBar.vue';
import RecentRepositoriesDialog from './components/repositories/RecentRepositoriesDialog.vue';
import ReviewAgentBar from './components/review/ReviewAgentBar.vue';
import SettingsView from './components/settings/SettingsView.vue';
import type { ChangedFile, DiffTarget } from './lib/protocol';
import { useDiffStore } from './stores/diff';
import { useRepoStore } from './stores/repo';
import { useReviewStore } from './stores/review';

const repo = useRepoStore();
const diff = useDiffStore();
const review = useReviewStore();
const showRecentRepositories = ref(false);
const showSettings = ref(false);
const selectedFolder = ref<{ path: string; files: ChangedFile[] }>();
const fileTreeWidthStorageKey = 'diffuse.fileTreeWidth';
const minFileTreeWidth = 220;
const maxFileTreeWidth = 640;
let resizeStartX = 0;
let resizeStartWidth = 0;

function loadFileTreeWidth() {
  const savedWidth = Number(window.localStorage.getItem(fileTreeWidthStorageKey));
  if (!Number.isFinite(savedWidth)) return 320;
  return clampFileTreeWidth(savedWidth);
}

function clampFileTreeWidth(width: number) {
  return Math.min(maxFileTreeWidth, Math.max(minFileTreeWidth, Math.round(width)));
}

const fileTreeWidth = ref(loadFileTreeWidth());
const fileTreeResizing = ref(false);

const startFileTreeResize = (event: PointerEvent) => {
  event.preventDefault();
  resizeStartX = event.clientX;
  resizeStartWidth = fileTreeWidth.value;
  fileTreeResizing.value = true;
  window.addEventListener('pointermove', resizeFileTree);
  window.addEventListener('pointerup', stopFileTreeResize, { once: true });
};

const resizeFileTree = (event: PointerEvent) => {
  fileTreeWidth.value = clampFileTreeWidth(resizeStartWidth + event.clientX - resizeStartX);
};

const stopFileTreeResize = () => {
  if (!fileTreeResizing.value) return;
  fileTreeResizing.value = false;
  window.removeEventListener('pointermove', resizeFileTree);
  window.localStorage.setItem(fileTreeWidthStorageKey, String(fileTreeWidth.value));
};

const openNewRepository = async () => {
  await repo.pickAndOpenRepository();
  if (repo.repository && !repo.error) showRecentRepositories.value = false;
};

const openRecentRepository = async (path: string) => {
  await repo.openRepository(path);
  if (!repo.error) showRecentRepositories.value = false;
};

const applyDiffTarget = async (target: DiffTarget) => {
  await repo.setDiffTarget(target);
};

const selectFile = (fileId: string) => {
  selectedFolder.value = undefined;
  repo.selectFile(fileId);
};

const selectFolder = (folder: { path: string; files: ChangedFile[] }) => {
  selectedFolder.value = { path: folder.path, files: sortFilesLikeSidebar(folder.files) };
  repo.activeFileId = undefined;
};

const changedFilePath = (file: ChangedFile) => file.newPath ?? file.oldPath ?? file.id;

const sortFilesLikeSidebar = (files: ChangedFile[]) => {
  return [...files].sort((first, second) => compareSidebarPaths(changedFilePath(first), changedFilePath(second)));
};

const compareSidebarPaths = (firstPath: string, secondPath: string) => {
  const firstParts = firstPath.split('/').filter(Boolean);
  const secondParts = secondPath.split('/').filter(Boolean);
  const length = Math.min(firstParts.length, secondParts.length);

  for (let index = 0; index < length; index += 1) {
    if (firstParts[index] === secondParts[index]) continue;

    const firstIsFolder = index < firstParts.length - 1;
    const secondIsFolder = index < secondParts.length - 1;
    if (firstIsFolder !== secondIsFolder) return firstIsFolder ? -1 : 1;

    return firstParts[index].localeCompare(secondParts[index]);
  }

  return firstParts.length - secondParts.length;
};

onMounted(async () => {
  try {
    await repo.loadVersion();
  } catch (error) {
    repo.error = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', resizeFileTree);
  window.removeEventListener('pointerup', stopFileTreeResize);
});

watch(
  () => repo.repository?.root,
  (root) => {
    if (root) {
      void review.ensureSession();
    } else {
      review.clear();
    }
  }
);

watch(
  () => repo.activeFileId,
  (fileId) => {
    if (selectedFolder.value) return;
    if (fileId) void diff.loadDiff(fileId, { silent: diff.current?.fileId === fileId });
    else diff.clear();
  }
);

watch(
  () => repo.changeRevision,
  () => {
    if (selectedFolder.value) {
      const folderPath = selectedFolder.value.path;
      const files = sortFilesLikeSidebar(repo.changedFiles.filter((file) => changedFilePath(file).startsWith(`${folderPath}/`)));
      selectedFolder.value = files.length > 0 ? { path: folderPath, files } : undefined;
      return;
    }

    if (!repo.activeFileId) {
      diff.clear();
      return;
    }

    if (diff.current?.fileId === repo.activeFileId && repo.changedFileIds.includes(repo.activeFileId)) {
      diff.markNewChanges();
    }
  }
);

watch(
  () => repo.diffTarget,
  () => {
    if (selectedFolder.value) return;
    if (repo.activeFileId) void diff.loadDiff(repo.activeFileId);
    else diff.clear();
  },
  { deep: true }
);
</script>

<style scoped lang="scss">
.app-shell {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.workspace {
  display: grid;
  min-height: 0;

  &.resizing {
    cursor: col-resize;
    user-select: none;
  }
}

.resize-handle {
  position: relative;
  min-height: 0;
  cursor: col-resize;
  background: #151821;

  &::before {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 2px;
    width: 1px;
    content: '';
    background: #252a35;
  }

  &:hover,
  .resizing & {
    background: #202635;

    &::before {
      background: #4b7bec;
    }
  }
}
</style>
