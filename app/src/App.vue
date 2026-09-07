<template>
  <div class="app-shell">
    <TopBar
      :inert="showWorkspaceSwitcher"
      :repo-path="repo.repository?.root"
      :version="repo.version?.version"
      :loading="repo.loading || workbench.restoreStatus === 'restoring'"
      :error="repo.error ?? workbench.error"
      @open-repository="openWorkspaceSwitcher"
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
          @apply="repo.setDiffTarget"
          @reset="repo.resetDiffTarget()"
        />
      </template>
    </TopBar>

    <div class="workbench-shell" :inert="showWorkspaceSwitcher">
      <WorkspaceRail
        :workspaces="workbench.workspaces"
        :active-workspace-id="workbench.activeWorkspaceId"
        :overview-selected="route.name === workspaceRouteNames.workbench && workbench.activeWorkspaceId === null"
        :pending-input-count="workbench.aggregateAttention.inputRequired"
        @overview="openWorkbenchOverview"
        @open="openNewWorkspace"
        @switch="openWorkspaceSwitcher"
        @select="activateWorkspace"
        @close="closeWorkspace"
      />

      <div id="workbench-content" class="workbench-content" tabindex="-1">
        <SettingsView v-if="showSettings" @close="showSettings = false" />

        <main
          v-else-if="workspaceReadyForRoute"
          class="workspace"
          :class="{ resizing: fileTreeResizing, 'has-pinned-search': search.drawerOpen }"
          :style="{ '--file-tree-width': `${fileTreeWidth}px` }"
        >
          <div class="narrow-workspace-tools">
            <Button variant="secondary" size="sm" :pressed="showNarrowFiles" @click="showNarrowFiles = !showNarrowFiles">Files</Button>

            <Button variant="secondary" size="sm" :pressed="search.drawerOpen" @click="toggleNarrowSearch">Results</Button>
          </div>

          <ChangedFilesPane class="changed-files-shell" :class="{ 'narrow-open': showNarrowFiles }" />

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

          <SearchResultsDrawer v-if="repo.repository && search.drawerOpen" class="workspace-search-drawer" @open="openSearchResult" />
        </main>

        <EmptyState
          v-else-if="isWorkspaceRoute || workbench.activeWorkspaceId !== null"
          class="workspace-loading"
          title="Restoring workspace"
          description="Loading repository and review context..."
        />

        <RouterView v-else />
      </div>
    </div>

    <WorkspaceSwitcher
      v-if="showWorkspaceSwitcher"
      :workspaces="workbench.workspaces"
      :recent-repositories="repo.recentRepositories"
      @close="closeWorkspaceSwitcher"
      @open-new="openNewWorkspace"
      @select="activateWorkspaceFromSwitcher"
      @open-recent="openPathFromSwitcher"
    />

    <SearchPalette v-if="repo.repository" @open="openSearchResult" @preview="previewSearchResult" />

    <p :key="workbench.announcementRevision" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {{ workbench.announcement }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from './components/Button.vue';
import ChangedFilesPane from './components/changed-files/ChangedFilesPane.vue';
import DiffTargetMenu from './components/diff/DiffTargetMenu.vue';
import TopBar from './components/layout/TopBar.vue';
import SearchPalette from './components/search/SearchPalette.vue';
import SearchResultsDrawer from './components/search/SearchResultsDrawer.vue';
import SettingsView from './components/settings/SettingsView.vue';
import EmptyState from './components/ui/EmptyState.vue';
import WorkspaceRail from './components/workbench/WorkspaceRail.vue';
import WorkspaceSwitcher from './components/workbench/WorkspaceSwitcher.vue';
import { workbenchCommandForEvent } from './lib/workbenchKeybindings';
import { closeWorkspaceWithPolicy } from './lib/workspaceClose';
import { restoreReviewSessionRoute } from './lib/reviewSessionRestoration';
import { dispatchWorkspaceNavigation, openWorkspaceSettingsEvent } from './lib/workspaceNavigation';
import type { SearchResult } from './lib/search/searchTypes';
import {
  captureWorkspaceRoute,
  restoreWorkspaceRoute,
  searchResultDiffRoute,
  threadDiffRoute,
  workbenchRoute,
  workspaceIdFromRoute,
  workspaceRouteNames,
} from './lib/workspaceRoutes';
import type { WorkspaceSnapshot } from './lib/workbenchContract';
import { useCursorStore, type CursorRestorationState } from './stores/cursor';
import { useDiffStore } from './stores/diff';
import { useRepoStore } from './stores/repo';
import { useReviewStore } from './stores/review';
import { useSearchStore } from './stores/search';
import { useWorkbenchStore, type WorkspaceUiState } from './stores/workbench';
import { useSettingsStore } from './stores/settings';
import { isSettingsSectionId } from './components/settings/settingsSections';

const repo = useRepoStore();
const diff = useDiffStore();
const cursor = useCursorStore();
const review = useReviewStore();
const search = useSearchStore();
const workbench = useWorkbenchStore();
const settings = useSettingsStore();
const router = useRouter();
const route = useRoute();
const showWorkspaceSwitcher = ref(false);
const showSettings = ref(false);
const showNarrowFiles = ref(false);
const fileTreeWidthStorageKey = 'diffuse.fileTreeWidth';
const minFileTreeWidth = 220;
const maxFileTreeWidth = 640;
let resizeStartX = 0;
let resizeStartWidth = 0;
let loadedWorkspaceId: string | undefined;
let switchGeneration = 0;
let switcherReturnFocus: HTMLElement | null = null;
let unsubscribeAttentionNavigation: (() => void) | undefined;
const globalKeydownOptions = { capture: true };

const isWorkspaceRoute = computed(() =>
  [workspaceRouteNames.overview, workspaceRouteNames.diff, workspaceRouteNames.folderDiff, workspaceRouteNames.input].includes(
    route.name as typeof workspaceRouteNames.overview,
  ),
);
const workspaceReadyForRoute = computed(() => {
  const routeWorkspaceId = workspaceIdFromRoute(route);
  return (
    isWorkspaceRoute.value &&
    Boolean(repo.repository) &&
    Boolean(loadedWorkspaceId) &&
    routeWorkspaceId === loadedWorkspaceId &&
    repo.workspace?.workspaceId === loadedWorkspaceId &&
    workbench.activeWorkspaceId === loadedWorkspaceId
  );
});

function loadFileTreeWidth() {
  const savedWidth = Number(window.localStorage.getItem(fileTreeWidthStorageKey));
  return Number.isFinite(savedWidth) ? clampFileTreeWidth(savedWidth) : 320;
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

const captureActiveWorkspace = () => {
  if (!loadedWorkspaceId) return;
  const previous = workbench.uiState(loadedWorkspaceId);
  workbench.saveUiState(loadedWorkspaceId, {
    ...previous,
    route: workspaceIdFromRoute(route) === loadedWorkspaceId ? captureWorkspaceRoute(route) : previous.route,
    diffTarget: { ...repo.diffTarget },
    diff: diff.captureRestorationState(),
    search: search.captureRestorationState(),
    draft: review.captureDraftState(),
    cursor: cursor.captureRestorationState(),
    logicalFocus: document.activeElement instanceof HTMLElement ? document.activeElement.id || undefined : undefined,
  });
};

const clearActiveWorkspace = (cancelSearch: boolean) => {
  if (cancelSearch) search.deactivate();
  else search.restoreRestorationState();
  diff.clear();
  review.clear();
  cursor.clearWorkspace();
  repo.clearActiveWorkspace();
};

const prepareSwitch = (cancelSearch = true) => {
  captureActiveWorkspace();
  clearActiveWorkspace(cancelSearch);
};

const activateSnapshot = async (snapshot: WorkspaceSnapshot) => {
  const generation = ++switchGeneration;
  if (loadedWorkspaceId && loadedWorkspaceId !== snapshot.summary.workspaceId) prepareSwitch(false);
  loadedWorkspaceId = snapshot.summary.workspaceId;
  const state = workbench.uiState(snapshot.summary.workspaceId);
  diff.restoreRestorationState(state.diff);
  search.restoreRestorationState(state.search);
  review.restoreDraftState(state.draft);
  cursor.restoreRestorationState(snapshot.summary.workspaceId, state.cursor as CursorRestorationState | undefined);
  await repo.loadWorkspace(snapshot, state.diffTarget);
  const isCurrent = () => generation === switchGeneration && workbench.activeWorkspaceId === snapshot.summary.workspaceId;
  if (!isCurrent()) return;
  const restoration = await restoreReviewSessionRoute(state.route, {
    selectSession: review.selectSession,
    ensureSession: async () => {
      await review.ensureSession();
      if (!review.session) throw new Error(review.error ?? 'Unable to restore a review session');
    },
    isCurrent,
    navigate: async (restoredRoute) => {
      if (restoredRoute !== state.route) {
        workbench.saveUiState(snapshot.summary.workspaceId, { ...state, route: restoredRoute });
      }
      await router.replace(restoreWorkspaceRoute(snapshot.summary.workspaceId, restoredRoute));
    },
  });
  if (!restoration.current) return;
  await nextTick();
  if (!isCurrent()) return;
  restoreLogicalFocus(state);
};

const restoreLogicalFocus = (state: WorkspaceUiState) => {
  const target = state.logicalFocus ? document.getElementById(state.logicalFocus) : null;
  if (target instanceof HTMLElement) target.focus();
  else document.getElementById('workbench-content')?.focus();
};

const activateWorkspace = async (workspaceId: string) => {
  if (workbench.activeWorkspaceId === workspaceId) return;
  prepareSwitch();
  loadedWorkspaceId = undefined;
  await workbench.activateWorkspace(workspaceId);
};

const openWorkbenchOverview = async () => {
  if (route.name === workspaceRouteNames.workbench) return;
  prepareSwitch();
  loadedWorkspaceId = undefined;
  await workbench.showOverview();
  await router.replace(workbenchRoute());
};

const openNewWorkspace = async () => {
  const path = await window.diffuse.pickRepository();
  if (!path) return;
  showWorkspaceSwitcher.value = false;
  prepareSwitch();
  loadedWorkspaceId = undefined;
  await workbench.openWorkspace(path);
};

const closeWorkspace = async (workspaceId: string) => {
  const closingIndex = workbench.workspaces.findIndex((workspace) => workspace.workspaceId === workspaceId);
  const closingActive = workbench.activeWorkspaceId === workspaceId;
  const savedDraft = workbench.uiState(workspaceId).draft?.body.trim();
  const hasReviewRisk = Boolean(savedDraft || (closingActive && (review.draftBody.trim() || review.activeRun)));
  const hasInputRisk = workbench.hasPendingInput(workspaceId) || workbench.hasInputDraft(workspaceId);
  const force = hasReviewRisk || hasInputRisk;
  let captured = false;
  try {
    const closed = await closeWorkspaceWithPolicy(
      force,
      async (forceClose) => {
        if (closingActive && !captured) {
          captureActiveWorkspace();
          captured = true;
        }
        await workbench.closeWorkspace(workspaceId, forceClose);
      },
      () => window.confirm('This workspace has pending input, an unsaved draft, or active agent work. Stop work and close it?'),
      () => window.confirm('Work requiring confirmation appeared while this workspace was closing. Stop it and force close?'),
    );
    if (!closed) return;
  } catch (error) {
    repo.error = error instanceof Error ? error.message : String(error);
    return;
  }
  if (closingActive && !workbench.activeWorkspaceId) {
    clearActiveWorkspace(true);
    loadedWorkspaceId = undefined;
  }
  if (!workbench.activeWorkspaceId) await router.replace(workbenchRoute());
  await nextTick();
  const railItems = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
  railItems[Math.min(closingIndex + 1, railItems.length - 1)]?.focus();
};

const activateWorkspaceFromSwitcher = async (workspaceId: string) => {
  showWorkspaceSwitcher.value = false;
  await activateWorkspace(workspaceId);
};

const openWorkspaceSwitcher = () => {
  switcherReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  showWorkspaceSwitcher.value = true;
};

const closeWorkspaceSwitcher = async () => {
  showWorkspaceSwitcher.value = false;
  await nextTick();
  switcherReturnFocus?.focus();
  switcherReturnFocus = null;
};

const openPathFromSwitcher = async (path: string) => {
  showWorkspaceSwitcher.value = false;
  prepareSwitch();
  loadedWorkspaceId = undefined;
  await workbench.openWorkspace(path);
};

const toggleNarrowSearch = () => {
  if (search.drawerOpen) search.closeDrawer();
  else search.openDrawer();
};

const openSearchResult = (result: SearchResult) => {
  void previewSearchResult(result);
};

const previewSearchResult = async (result: SearchResult) => {
  const workspaceId = workbench.activeWorkspaceId;
  if (!workspaceId) return;
  if (result.kind === 'comment') {
    await router.push(threadDiffRoute(workspaceId, result.thread));
    return;
  }
  if (!result.fileId) return;
  if (result.kind === 'content' || result.kind === 'symbol') diff.setContextMode('full');
  const targetRoute = searchResultDiffRoute(workspaceId, result, search.query);
  if (targetRoute) await router.push(targetRoute);
};

const handleGlobalKeydown = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.isComposing) return;
  const workbenchCommand = workbenchCommandForEvent(event, settings.workbenchKeybindings);
  if (workbenchCommand) {
    event.preventDefault();
    if (workbenchCommand === 'nextWorkspace') void activateRelative(1);
    else if (workbenchCommand === 'previousWorkspace') void activateRelative(-1);
    else if (workbenchCommand === 'workbenchOverview') void openWorkbenchOverview();
    else if (workbenchCommand === 'openWorkspace') void openNewWorkspace();
    else if (workbenchCommand === 'switchWorkspace') openWorkspaceSwitcher();
    else void activateSlot(Number(workbenchCommand.slice(-1)));
    return;
  }
  if (showSettings.value || showWorkspaceSwitcher.value || isTextEntryTarget(event.target)) return;
  if (cursor.handleKeyDown(event)) return;
  const commandOrControl = event.metaKey || event.ctrlKey;
  if (commandOrControl && event.key.toLowerCase() === 'p') {
    event.preventDefault();
    search.openOverlay('all');
  } else if (commandOrControl && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    search.openOverlay('content');
  }
};

const activateRelative = async (delta: -1 | 1) => {
  if (workbench.workspaces.length === 0) return;
  const current = workbench.workspaces.findIndex((workspace) => workspace.workspaceId === workbench.activeWorkspaceId);
  const index = (current + delta + workbench.workspaces.length) % workbench.workspaces.length;
  await activateWorkspace(workbench.workspaces[index].workspaceId);
};

const activateSlot = async (slot: number) => {
  const workspace = workbench.workspaces[slot - 1];
  if (workspace) await activateWorkspace(workspace.workspaceId);
};

const isTextEntryTarget = (target: EventTarget | null) => {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
};

const captureBeforeRendererLoss = () => captureActiveWorkspace();

const openWorkspaceSettings = (event: Event) => {
  const section = (event as CustomEvent<{ section?: string }>).detail?.section;
  if (section && isSettingsSectionId(section)) window.localStorage.setItem('diffuse.settings.activeSection', section);
  showSettings.value = true;
};

const openSettingsTarget = (section?: string) => {
  if (section && isSettingsSectionId(section)) window.localStorage.setItem('diffuse.settings.activeSection', section);
  showSettings.value = true;
};

onMounted(async () => {
  cursor.setNavigator(async (targetRoute) => {
    await router.push(targetRoute);
  });
  window.addEventListener('keydown', handleGlobalKeydown, globalKeydownOptions);
  window.addEventListener('pagehide', captureBeforeRendererLoss);
  window.addEventListener(openWorkspaceSettingsEvent, openWorkspaceSettings);
  unsubscribeAttentionNavigation = window.diffuse.onAttentionNavigation(({ workspaceId, target, attentionId, revision }) => {
    void dispatchWorkspaceNavigation(workspaceId, target, {
      activateWorkspace,
      router,
      openSettings: openSettingsTarget,
      selectReviewSession: review.selectSession,
    })
      .then(() => workbench.acknowledgeAttention(attentionId, revision))
      .catch((error) => {
        repo.error = error instanceof Error ? error.message : String(error);
      });
  });
  try {
    await repo.loadVersion();
    await workbench.initialize(activateSnapshot);
    if (workbench.restoreStatus !== 'ready') return;
    if (!workbench.activeWorkspaceId) await router.replace(workbenchRoute());
    await window.diffuse.readyForWorkbenchNavigation();
  } catch (error) {
    repo.error = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  captureActiveWorkspace();
  cursor.setNavigator(undefined);
  unsubscribeAttentionNavigation?.();
  unsubscribeAttentionNavigation = undefined;
  window.removeEventListener('keydown', handleGlobalKeydown, globalKeydownOptions);
  window.removeEventListener('pagehide', captureBeforeRendererLoss);
  window.removeEventListener(openWorkspaceSettingsEvent, openWorkspaceSettings);
  window.removeEventListener('pointermove', resizeFileTree);
  window.removeEventListener('pointerup', stopFileTreeResize);
});

watch(
  () => route.fullPath,
  () => {
    showNarrowFiles.value = false;
    const workspaceId = workspaceIdFromRoute(route);
    if (!workspaceId || workspaceId !== loadedWorkspaceId) return;
    const state = workbench.uiState(workspaceId);
    workbench.saveUiState(workspaceId, { ...state, route: captureWorkspaceRoute(route) });
  },
);

watch(
  () => workspaceIdFromRoute(route),
  async (workspaceId) => {
    if (!workspaceId || workbench.restoreStatus !== 'ready' || workspaceId === workbench.activeWorkspaceId) return;
    const state = workbench.uiState(workspaceId);
    workbench.saveUiState(workspaceId, { ...state, route: captureWorkspaceRoute(route) });
    await activateWorkspace(workspaceId);
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

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  white-space: nowrap;
  border: 0;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
}

.workbench-shell {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

.workbench-content {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  outline: 0;
}

.workspace-loading {
  height: 100%;
}

.workspace {
  position: relative;
  display: grid;
  grid-template-columns: var(--file-tree-width) 6px minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-height: 0;

  &.resizing {
    cursor: col-resize;
    user-select: none;
  }

  &.has-pinned-search {
    grid-template-columns: var(--file-tree-width) 6px minmax(0, 1fr) minmax(280px, 340px);
  }
}

.workspace-search-drawer,
.changed-files-shell {
  min-width: 0;
  min-height: 0;
}

.resize-handle {
  position: relative;
  min-height: 0;
  cursor: col-resize;
  background: var(--color-bg-shell);

  &::before {
    position: absolute;
    inset-block: 0;
    left: 2px;
    width: 1px;
    content: '';
    background: var(--color-border-subtle);
  }

  &:hover,
  .resizing & {
    background: var(--color-bg-hover);
  }
}

.narrow-workspace-tools {
  display: none;
}

@media (max-width: 1280px) {
  .workspace.has-pinned-search {
    grid-template-columns: var(--file-tree-width) 6px minmax(0, 1fr) minmax(260px, 300px);
  }
}

@media (max-width: 900px) {
  .workspace,
  .workspace.has-pinned-search {
    grid-template-columns: minmax(0, 1fr);
  }

  .resize-handle {
    display: none;
  }

  .narrow-workspace-tools {
    position: absolute;
    z-index: 31;
    top: var(--space-4);
    left: var(--space-4);
    display: flex;
    gap: var(--space-3);
  }

  .changed-files-shell,
  .workspace-search-drawer {
    position: absolute;
    z-index: 30;
    top: 0;
    bottom: 0;
    display: none;
    width: min(360px, calc(100% - var(--space-10)));
    box-shadow: var(--shadow-dialog);
  }

  .changed-files-shell.narrow-open {
    left: 0;
    display: block;
  }

  .workspace-search-drawer {
    right: 0;
    display: block;
  }
}
</style>
