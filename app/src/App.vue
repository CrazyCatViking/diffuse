<template>
  <div class="app-shell">
    <TopBar
      :repo-path="repo.repository?.root"
      :version="repo.version?.version"
      :loading="repo.loading"
      :error="repo.error"
      @open-repository="repo.pickAndOpenRepository()"
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
        @update:view-mode="diff.setViewMode($event)"
        @update:context-mode="diff.setContextMode($event)"
        @update:sync-scroll="diff.setSyncScroll($event)"
      />
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue'
import ChangedFilesPane from './components/changed-files/ChangedFilesPane.vue'
import DiffViewer from './components/diff/DiffViewer.vue'
import TopBar from './components/layout/TopBar.vue'
import { useDiffStore } from './stores/diff'
import { useRepoStore } from './stores/repo'

const repo = useRepoStore()
const diff = useDiffStore()

onMounted(async () => {
  try {
    await repo.loadVersion()
  } catch (error) {
    repo.error = error instanceof Error ? error.message : String(error)
  }
})

watch(
  () => repo.activeFileId,
  (fileId) => {
    if (fileId) void diff.loadDiff(fileId)
    else diff.clear()
  }
)
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
