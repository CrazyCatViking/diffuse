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

    <main v-else class="workspace" :class="{ resizing: fileTreeResizing }" :style="{ gridTemplateColumns: `${fileTreeWidth}px 6px minmax(0, 1fr)` }">
      <ChangedFilesPane
        :files="repo.changedFiles"
        :active-file-id="repo.activeFileId"
        @select-file="repo.selectFile($event)"
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
      <DiffViewer
        :model="diff.current"
        :loading="diff.loading"
        :error="diff.error"
        :view-mode="diff.viewMode"
        :context-mode="diff.contextMode"
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
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ChangedFilesPane from './components/changed-files/ChangedFilesPane.vue';
import DiffViewer from './components/diff/DiffViewer.vue';
import TopBar from './components/layout/TopBar.vue';
import RecentRepositoriesDialog from './components/repositories/RecentRepositoriesDialog.vue';
import SettingsView from './components/settings/SettingsView.vue';
import { useDiffStore } from './stores/diff';
import { useRepoStore } from './stores/repo';

const repo = useRepoStore();
const diff = useDiffStore();
const showRecentRepositories = ref(false);
const showSettings = ref(false);
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
  () => repo.activeFileId,
  (fileId) => {
    if (fileId) void diff.loadDiff(fileId, { silent: diff.current?.fileId === fileId });
    else diff.clear();
  }
);

watch(
  () => repo.changeRevision,
  () => {
    if (!repo.activeFileId) {
      diff.clear();
      return;
    }

    if (diff.current?.fileId === repo.activeFileId && repo.changedFileIds.includes(repo.activeFileId)) {
      diff.markNewChanges();
    }
  }
);
</script>

<style scoped lang="scss">
.app-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
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
