<template>
  <div class="app-shell">
    <TopBar
      :repo-path="repo.repository?.root"
      :version="repo.version?.version"
      :loading="repo.loading"
      :error="repo.error"
      @open-repository="showRecentRepositories = true"
      @refresh="repo.refreshChangedFiles()"
    />

    <RecentRepositoriesDialog
      v-if="showRecentRepositories"
      :repositories="repo.recentRepositories"
      :loading="repo.loading"
      @close="showRecentRepositories = false"
      @open-new="openNewRepository"
      @open-recent="openRecentRepository"
    />

    <main class="workspace">
      <ChangedFilesPane
        :files="repo.changedFiles"
        :active-file-id="repo.activeFileId"
        @select-file="repo.selectFile($event)"
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
import { onMounted, ref, watch } from 'vue';
import ChangedFilesPane from './components/changed-files/ChangedFilesPane.vue';
import DiffViewer from './components/diff/DiffViewer.vue';
import TopBar from './components/layout/TopBar.vue';
import RecentRepositoriesDialog from './components/repositories/RecentRepositoriesDialog.vue';
import { useDiffStore } from './stores/diff';
import { useRepoStore } from './stores/repo';

const repo = useRepoStore();
const diff = useDiffStore();
const showRecentRepositories = ref(false);

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
  grid-template-columns: 320px minmax(0, 1fr);
  min-height: 0;
}
</style>
