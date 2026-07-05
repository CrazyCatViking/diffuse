<template>
  <div class="app-shell">
    <TopBar
      :repo-path="repo.repository?.root"
      :version="repo.version?.version"
      :loading="repo.loading"
      :error="repo.error"
      @open-repository="showRecentRepositories = true"
      @open-search="search.openOverlay()"
      @refresh="repo.refreshChangedFiles()"
      @open-settings="showSettings = true"
    >
      <template #repository-controls>
        <DiffTargetMenu
          v-if="repo.repository"
          :target="repo.diffTarget"
          :defaults="repo.diffTargetDefaults"
          :branches="repo.branches"
          :loading="repo.loading"
          @apply="applyDiffTarget"
          @reset="repo.resetDiffTarget()"
        />
      </template>
    </TopBar>

    <RecentRepositoriesDialog
      v-if="showRecentRepositories"
      :repositories="repo.recentRepositories"
      :loading="repo.loading"
      @close="showRecentRepositories = false"
      @open-new="openNewRepository"
      @open-recent="openRecentRepository"
    />

    <SettingsView v-if="showSettings" @close="showSettings = false" />

    <main v-else-if="!repo.repository" class="start-screen">
      <RepositoryStartView
        :repositories="repo.recentRepositories"
        :loading="repo.loading"
        :error="repo.error"
        @open-new="openNewRepository"
        @open-recent="openRecentRepository"
      />
    </main>

    <template v-else>
      <main
        class="workspace"
        :class="{ resizing: fileTreeResizing, 'has-pinned-search': search.drawerOpen }"
        :style="{ '--file-tree-width': `${fileTreeWidth}px` }"
      >
        <ChangedFilesPane />

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

        <RouterView />

        <SearchResultsDrawer v-if="repo.repository" class="workspace-search-drawer" @open="openSearchResult" />
      </main>
    </template>

    <SearchPalette v-if="repo.repository" @open="openSearchResult" @preview="previewSearchResult" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import ChangedFilesPane from './components/changed-files/ChangedFilesPane.vue';
import DiffTargetMenu from './components/diff/DiffTargetMenu.vue';
import TopBar from './components/layout/TopBar.vue';
import RecentRepositoriesDialog from './components/repositories/RecentRepositoriesDialog.vue';
import RepositoryStartView from './components/repositories/RepositoryStartView.vue';
import SearchPalette from './components/search/SearchPalette.vue';
import SearchResultsDrawer from './components/search/SearchResultsDrawer.vue';
import SettingsView from './components/settings/SettingsView.vue';
import type { SearchResult } from './lib/search/searchTypes';
import { overviewRoute, searchResultDiffRoute, threadDiffRoute } from './lib/workspaceRoutes';
import type { DiffTarget } from './lib/protocol';
import { useCursorStore } from './stores/cursor';
import { useDiffStore } from './stores/diff';
import { useRepoStore } from './stores/repo';
import { useReviewStore } from './stores/review';
import { useSearchStore } from './stores/search';

const repo = useRepoStore();
const diff = useDiffStore();
const cursor = useCursorStore();
const review = useReviewStore();
const search = useSearchStore();
const router = useRouter();
const showRecentRepositories = ref(false);
const showSettings = ref(false);
const fileTreeWidthStorageKey = 'diffuse.fileTreeWidth';
const minFileTreeWidth = 220;
const maxFileTreeWidth = 640;
let resizeStartX = 0;
let resizeStartWidth = 0;
const globalKeydownOptions = { capture: true };
const keyboardDefaultSuppressionOptions = { capture: false };

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
  if (repo.repository && !repo.error) {
    showRecentRepositories.value = false;
    await router.replace(overviewRoute());
  }
};

const openRecentRepository = async (path: string) => {
  await repo.openRepository(path);
  if (!repo.error) {
    showRecentRepositories.value = false;
    await router.replace(overviewRoute());
  }
};

const applyDiffTarget = async (target: DiffTarget) => {
  await repo.setDiffTarget(target);
};

const openSearchResult = (result: SearchResult) => {
  void previewSearchResult(result);
};

const previewSearchResult = async (result: SearchResult) => {
  if (result.kind === 'comment') {
    await router.push(threadDiffRoute(result.thread));
    return;
  }

  if (result.fileId) {
    if (result.kind === 'content' || result.kind === 'symbol') diff.setContextMode('full');
    const targetRoute = searchResultDiffRoute(result, search.query);
    if (targetRoute) {
      await router.push(targetRoute);
    }
  }
};

onMounted(async () => {
  cursor.setNavigator((route) => {
    void router.push(route);
  });
  window.addEventListener('keydown', handleGlobalSearchShortcut, globalKeydownOptions);
  window.addEventListener('keydown', suppressBrowserKeyboardDefault, keyboardDefaultSuppressionOptions);
  window.addEventListener('keypress', suppressBrowserKeyboardDefault, keyboardDefaultSuppressionOptions);
  window.addEventListener('keyup', suppressBrowserKeyboardDefault, keyboardDefaultSuppressionOptions);
  try {
    await repo.loadVersion();
    const launchRepository = await window.diffuse.getLaunchRepository();
    if (launchRepository) {
      await repo.openRepository(launchRepository);
      if (!repo.error) await router.replace(overviewRoute());
    }
  } catch (error) {
    repo.error = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  cursor.setNavigator(undefined);
  window.removeEventListener('keydown', handleGlobalSearchShortcut, globalKeydownOptions);
  window.removeEventListener('keydown', suppressBrowserKeyboardDefault, keyboardDefaultSuppressionOptions);
  window.removeEventListener('keypress', suppressBrowserKeyboardDefault, keyboardDefaultSuppressionOptions);
  window.removeEventListener('keyup', suppressBrowserKeyboardDefault, keyboardDefaultSuppressionOptions);
  window.removeEventListener('pointermove', resizeFileTree);
  window.removeEventListener('pointerup', stopFileTreeResize);
});

const handleGlobalSearchShortcut = (event: KeyboardEvent) => {
  if (event.defaultPrevented) return;
  if (!repo.repository) return;
  const commandOrControl = event.metaKey || event.ctrlKey;
  const isTextEntry = isTextEntryTarget(event.target);

  if (!isTextEntry && event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    return;
  }

  if (!isTextEntry && cursor.handleKeyDown(event)) return;

  if (commandOrControl && event.key.toLowerCase() === 'p') {
    event.preventDefault();
    search.openOverlay('all');
    return;
  }
  if (commandOrControl && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    search.openOverlay('content');
  }
};

const suppressBrowserKeyboardDefault = (event: KeyboardEvent) => {
  if (!event.cancelable || event.defaultPrevented) return;
  if (isTextEntryTarget(event.target) || isModifierOnlyKey(event.key) || event.isComposing) return;

  event.preventDefault();
};

const isTextEntryTarget = (target: EventTarget | null) => {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
};

const isModifierOnlyKey = (key: string) => {
  return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'AltGraph';
};

watch(
  () => repo.repository?.root,
  (root) => {
    if (root) {
      void review.ensureSession();
      void router.replace(overviewRoute());
    } else {
      review.clear();
      diff.clear();
    }
  },
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
  grid-template-columns: var(--file-tree-width) 6px minmax(0, 1fr);
  min-height: 0;
  position: relative;

  &.resizing {
    cursor: col-resize;
    user-select: none;
  }

  &.has-pinned-search {
    grid-template-columns: var(--file-tree-width) 6px minmax(0, 1fr) minmax(280px, 340px);
  }
}

.workspace-search-drawer {
  min-width: 0;
  min-height: 0;
}

.start-screen {
  grid-row: 2 / -1;
  min-height: 0;
  overflow: hidden;
}

.resize-handle {
  position: relative;
  min-height: 0;
  cursor: col-resize;
  background: var(--color-bg-shell);

  &::before {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 2px;
    width: 1px;
    content: '';
    background: var(--color-border-subtle);
  }

  &:hover,
  .resizing & {
    background: var(--color-bg-hover);

    &::before {
      background: var(--color-accent);
    }
  }
}

@media (max-width: 1280px) {
  .workspace {
    grid-template-columns: var(--file-tree-width) 6px minmax(0, 1fr);

    &.has-pinned-search {
      grid-template-columns: var(--file-tree-width) 6px minmax(0, 1fr) minmax(260px, 300px);
    }
  }
}

@media (max-width: 900px) {
  .workspace {
    grid-template-columns: minmax(220px, min(var(--file-tree-width), 38vw)) 6px minmax(0, 1fr);

    &.has-pinned-search {
      grid-template-columns: minmax(180px, min(var(--file-tree-width), 30vw)) 6px minmax(0, 1fr) minmax(240px, 32vw);
    }
  }
}
</style>
