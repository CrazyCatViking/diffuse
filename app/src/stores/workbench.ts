import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ChangedFile, DiffTarget, DiffViewMode, DiffContextMode, ReviewAnchor } from '../lib/protocol';
import type { SearchFilterKind, SearchMode, SearchResult } from '../lib/search/searchTypes';
import { setActiveWorkspace } from '../lib/useClient';
import type { WorkbenchEvent, WorkspaceSnapshot, WorkspaceSummary } from '../lib/workbenchContract';
import type { WorkspaceRouteState } from '../lib/workspaceRoutes';

const workbenchUiStorageKey = 'diffuse.workbench.ui.v1';
const maxPinnedResults = 500;

export type WorkspaceUiState = {
  route?: WorkspaceRouteState;
  diffTarget?: DiffTarget;
  diff?: { viewMode: DiffViewMode; contextMode: DiffContextMode; syncScroll: boolean };
  search?: {
    query: string;
    treeQuery: string;
    mode: SearchMode;
    activeFilters: SearchFilterKind[];
    treeActiveFilters: SearchFilterKind[];
    selectedIndex: number;
    drawerOpen: boolean;
    pinnedQuery: string;
    pinnedResults: SearchResult[];
    pinnedRemovedResultIds: string[];
    pinnedSelectedIndex: number;
  };
  draft?: {
    file?: ChangedFile;
    anchor?: ReviewAnchor;
    mode: 'comment' | 'chat';
    body: string;
    replies?: Record<string, string>;
  };
  cursor?: unknown;
  logicalFocus?: string;
  activityRevision?: number;
};

type ActivationHandler = (snapshot: WorkspaceSnapshot) => void | Promise<void>;

export const useWorkbenchStore = defineStore('workbench', () => {
  const workspaces = ref<WorkspaceSummary[]>([]);
  const activeWorkspaceId = ref<string | null>(null);
  const restoreStatus = ref<'idle' | 'restoring' | 'ready' | 'failed'>('idle');
  const error = ref<string>();
  const sequence = ref(0);
  const uiByWorkspaceId = ref<Record<string, WorkspaceUiState>>(loadPersistedUi().uiByWorkspaceId);
  const persistedRailOrder = ref<string[]>(loadPersistedUi().railOrder);
  const activeWorkspace = computed(() => workspaces.value.find((workspace) => workspace.workspaceId === activeWorkspaceId.value) ?? null);
  const aggregateAttention = computed(() => 0);
  let activationHandler: ActivationHandler | undefined;
  let unsubscribe: (() => void) | undefined;
  let restoringEvents: WorkbenchEvent[] = [];
  let commandGeneration = 0;
  let activationKey = '';
  let activationPromise: Promise<void> = Promise.resolve();
  let eventQueue: Promise<void> = Promise.resolve();

  const initialize = async (handler: ActivationHandler) => {
    activationHandler = handler;
    if (!unsubscribe) unsubscribe = window.diffuse.onWorkbenchEvent(handleEvent);
    restoreStatus.value = 'restoring';
    error.value = undefined;
    try {
      const snapshot = await window.diffuse.getWorkbenchSnapshot();
      workspaces.value = orderSummaries(snapshot.workspaces, persistedRailOrder.value);
      const openWorkspaceIds = new Set(snapshot.workspaces.map((workspace) => workspace.workspaceId));
      uiByWorkspaceId.value = Object.fromEntries(
        Object.entries(uiByWorkspaceId.value).filter(([workspaceId]) => openWorkspaceIds.has(workspaceId)),
      );
      persistUi();
      activeWorkspaceId.value = snapshot.activeWorkspaceId;
      sequence.value = snapshot.sequence;
      setActiveWorkspace(snapshot.activeWorkspace?.summary);
      while (restoringEvents.length > 0) {
        const queued = restoringEvents;
        restoringEvents = [];
        for (const event of queued.filter((item) => item.sequence > sequence.value).sort((a, b) => a.sequence - b.sequence)) {
          await applyEvent(event);
        }
      }
      restoreStatus.value = 'ready';
      if (snapshot.activeWorkspace && activeWorkspaceId.value === snapshot.activeWorkspace.summary.workspaceId) {
        await dispatchActivation(snapshot.activeWorkspace);
      }
    } catch (err) {
      restoreStatus.value = 'failed';
      error.value = err instanceof Error ? err.message : String(err);
    }
  };

  const openWorkspace = async (path: string) => {
    const generation = ++commandGeneration;
    const snapshot = await window.diffuse.openWorkspace(path);
    upsertSummary(snapshot.summary);
    if (generation === commandGeneration) await dispatchActivation(snapshot);
    return snapshot;
  };

  const activateWorkspace = async (workspaceId: string) => {
    const summary = workspaces.value.find((workspace) => workspace.workspaceId === workspaceId);
    if (!summary) return;
    if (activeWorkspaceId.value === workspaceId) return;
    const generation = ++commandGeneration;
    const snapshot = await window.diffuse.activateWorkspace(workspaceReference(summary));
    if (snapshot && generation === commandGeneration) await dispatchActivation(snapshot);
  };

  const showOverview = async () => {
    const generation = ++commandGeneration;
    await window.diffuse.activateWorkspace(null);
    if (generation === commandGeneration) {
      activeWorkspaceId.value = null;
      setActiveWorkspace(undefined);
      activationKey = '';
    }
  };

  const closeWorkspace = async (workspaceId: string) => {
    const index = workspaces.value.findIndex((workspace) => workspace.workspaceId === workspaceId);
    const summary = workspaces.value[index];
    if (!summary) return;
    const wasActive = activeWorkspaceId.value === workspaceId;
    await window.diffuse.closeWorkspace(workspaceReference(summary));
    removeSummary(workspaceId);
    if (!wasActive) return;
    const next = workspaces.value[Math.min(index, workspaces.value.length - 1)];
    if (next) await activateWorkspace(next.workspaceId);
    else await showOverview();
  };

  const activateRelative = async (delta: -1 | 1) => {
    if (workspaces.value.length === 0) return;
    const current = workspaces.value.findIndex((workspace) => workspace.workspaceId === activeWorkspaceId.value);
    const base = current === -1 ? (delta > 0 ? -1 : 0) : current;
    const index = (base + delta + workspaces.value.length) % workspaces.value.length;
    await activateWorkspace(workspaces.value[index].workspaceId);
  };

  const activateSlot = async (slot: number) => {
    const workspace = workspaces.value[slot - 1];
    if (workspace) await activateWorkspace(workspace.workspaceId);
  };

  const uiState = (workspaceId: string): WorkspaceUiState => uiByWorkspaceId.value[workspaceId] ?? {};

  const saveUiState = (workspaceId: string, state: WorkspaceUiState) => {
    uiByWorkspaceId.value = {
      ...uiByWorkspaceId.value,
      [workspaceId]: normalizeUiState(state),
    };
    persistUi();
  };

  const handleEvent = (event: WorkbenchEvent) => {
    if (restoreStatus.value === 'restoring') {
      restoringEvents.push(event);
      return;
    }
    eventQueue = eventQueue
      .then(() => applyEvent(event))
      .catch((err) => {
        error.value = err instanceof Error ? err.message : String(err);
      });
  };

  const applyEvent = async (event: WorkbenchEvent) => {
    if (event.sequence <= sequence.value) return;
    if (event.sequence > sequence.value + 1) {
      const snapshot = await window.diffuse.getWorkbenchSnapshot();
      if (snapshot.sequence < sequence.value) return;
      workspaces.value = orderSummaries(snapshot.workspaces, persistedRailOrder.value);
      activeWorkspaceId.value = snapshot.activeWorkspaceId;
      sequence.value = snapshot.sequence;
      setActiveWorkspace(snapshot.activeWorkspace?.summary);
      if (snapshot.activeWorkspace) await dispatchActivation(snapshot.activeWorkspace);
      return;
    }
    sequence.value = event.sequence;
    if (event.kind === 'workspace/added') {
      upsertSummary(event.payload);
      return;
    }
    if (event.kind === 'workspace/removed') {
      removeSummary(event.workspaceId);
      return;
    }
    if (event.kind === 'workspace/activated') {
      commandGeneration += 1;
      upsertSummary(event.payload.summary);
      await dispatchActivation(event.payload);
      return;
    }
    const state = uiState(event.workspaceId);
    saveUiState(event.workspaceId, { ...state, activityRevision: (state.activityRevision ?? 0) + 1 });
  };

  const commitActivation = (snapshot: WorkspaceSnapshot) => {
    activeWorkspaceId.value = snapshot.summary.workspaceId;
    setActiveWorkspace(snapshot.summary);
  };

  const dispatchActivation = async (snapshot: WorkspaceSnapshot) => {
    commitActivation(snapshot);
    const key = `${snapshot.summary.workspaceId}:${snapshot.summary.workspaceGeneration}`;
    if (activationKey === key) return activationPromise;
    activationKey = key;
    activationPromise = Promise.resolve(activationHandler?.(snapshot)).then(() => undefined);
    return activationPromise;
  };

  const upsertSummary = (summary: WorkspaceSummary) => {
    const next = workspaces.value.filter((workspace) => workspace.workspaceId !== summary.workspaceId);
    workspaces.value = orderSummaries([...next, summary], persistedRailOrder.value);
    persistedRailOrder.value = workspaces.value.map((workspace) => workspace.workspaceId);
    persistUi();
  };

  const removeSummary = (workspaceId: string) => {
    workspaces.value = workspaces.value.filter((workspace) => workspace.workspaceId !== workspaceId);
    if (activeWorkspaceId.value === workspaceId) activeWorkspaceId.value = null;
    persistedRailOrder.value = workspaces.value.map((workspace) => workspace.workspaceId);
    persistUi();
  };

  const persistUi = () => {
    window.localStorage.setItem(
      workbenchUiStorageKey,
      JSON.stringify({ railOrder: persistedRailOrder.value, uiByWorkspaceId: uiByWorkspaceId.value }),
    );
  };

  return {
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    aggregateAttention,
    restoreStatus,
    error,
    sequence,
    initialize,
    openWorkspace,
    activateWorkspace,
    showOverview,
    closeWorkspace,
    activateRelative,
    activateSlot,
    uiState,
    saveUiState,
  };
});

function orderSummaries(summaries: WorkspaceSummary[], order: string[]): WorkspaceSummary[] {
  const position = new Map(order.map((workspaceId, index) => [workspaceId, index]));
  return [...summaries].sort((first, second) => {
    const firstIndex = position.get(first.workspaceId) ?? Number.MAX_SAFE_INTEGER;
    const secondIndex = position.get(second.workspaceId) ?? Number.MAX_SAFE_INTEGER;
    return firstIndex - secondIndex;
  });
}

function normalizeUiState(state: WorkspaceUiState): WorkspaceUiState {
  return {
    ...state,
    search: state.search ? { ...state.search, pinnedResults: state.search.pinnedResults.slice(0, maxPinnedResults) } : undefined,
  };
}

function workspaceReference(workspace: WorkspaceSummary) {
  return {
    workspaceId: workspace.workspaceId,
    workspaceGeneration: workspace.workspaceGeneration,
  };
}

function loadPersistedUi(): { railOrder: string[]; uiByWorkspaceId: Record<string, WorkspaceUiState> } {
  try {
    const raw = window.localStorage.getItem(workbenchUiStorageKey);
    if (!raw) return { railOrder: [], uiByWorkspaceId: {} };
    const parsed = JSON.parse(raw) as { railOrder?: unknown; uiByWorkspaceId?: unknown };
    return {
      railOrder: Array.isArray(parsed.railOrder) ? parsed.railOrder.filter((item): item is string => typeof item === 'string') : [],
      uiByWorkspaceId:
        parsed.uiByWorkspaceId && typeof parsed.uiByWorkspaceId === 'object'
          ? (parsed.uiByWorkspaceId as Record<string, WorkspaceUiState>)
          : {},
    };
  } catch {
    return { railOrder: [], uiByWorkspaceId: {} };
  }
}
