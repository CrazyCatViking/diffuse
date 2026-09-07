import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ChangedFile, DiffTarget, DiffViewMode, DiffContextMode, ReviewAnchor } from '../lib/protocol';
import type { SearchFilterKind, SearchMode, SearchResult } from '../lib/search/searchTypes';
import { setActiveWorkspace } from '../lib/useClient';
import {
  aggregateAttention as aggregateWorkspaceAttention,
  isAttentionItem,
  isInputRequest,
  isWorkspaceSummary,
  isWorkspaceUiStateRecord,
  type AttentionItem,
  type InputRequest,
  type InputMutationResult,
  type InputResponse,
  type RestoreDiagnostic,
  type WorkbenchEvent,
  type WorkbenchSnapshot,
  type WorkspaceReference,
  type WorkspaceSnapshot,
  type WorkspaceSummary,
  type WorkspaceUiStateRecord,
} from '../lib/workbenchContract';
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
  inputDrafts?: Record<string, string>;
  cursor?: unknown;
  logicalFocus?: string;
  activityRevision?: number;
};

type ActivationHandler = (snapshot: WorkspaceSnapshot) => void | Promise<void>;
type PendingUiSave = {
  reference: WorkspaceReference;
  state: WorkspaceUiState;
};
type DirtyUiFallback = {
  workspaceGeneration: string;
  state: WorkspaceUiState;
};

export const useWorkbenchStore = defineStore('workbench', () => {
  const fallback = loadPersistedUi();
  const workspaces = ref<WorkspaceSummary[]>([]);
  const activeWorkspaceId = ref<string | null>(null);
  const restoreStatus = ref<'idle' | 'restoring' | 'ready' | 'failed'>('idle');
  const error = ref<string>();
  const sequence = ref(0);
  const attentionItems = ref<Record<string, AttentionItem>>({});
  const inputRequests = ref<Record<string, InputRequest>>({});
  const workspaceUiRecords = ref<Record<string, WorkspaceUiStateRecord>>({});
  const uiByWorkspaceId = ref<Record<string, WorkspaceUiState>>({});
  const persistedRailOrder = ref<string[]>(fallback.railOrder);
  const dirtyUiByWorkspaceId = ref<Record<string, DirtyUiFallback>>(fallback.dirtyUiByWorkspaceId);
  const transientInputDrafts = ref<Record<string, string>>({});
  const restoreDiagnostics = ref<RestoreDiagnostic[]>([]);
  const announcement = ref('');
  const announcementRevision = ref(0);
  const activeWorkspace = computed(() => workspaces.value.find((workspace) => workspace.workspaceId === activeWorkspaceId.value) ?? null);
  const aggregateAttention = computed(() => aggregateWorkspaceAttention(workspaces.value));
  let activationHandler: ActivationHandler | undefined;
  let unsubscribe: (() => void) | undefined;
  let restoringEvents: WorkbenchEvent[] = [];
  let commandGeneration = 0;
  let activationKey = '';
  let activationPromise: Promise<void> = Promise.resolve();
  let eventQueue: Promise<void> = Promise.resolve();
  const pendingUiSaves = new Map<string, PendingUiSave>();
  const uiSavePromises = new Map<string, Promise<void>>();

  const initialize = async (handler: ActivationHandler) => {
    activationHandler = handler;
    if (!unsubscribe) unsubscribe = window.diffuse.onWorkbenchEvent(handleEvent);
    restoreStatus.value = 'restoring';
    error.value = undefined;
    try {
      const snapshot = await window.diffuse.getWorkbenchSnapshot();
      applySnapshot(snapshot);
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
      error.value = errorMessage(err);
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
    if (!summary || activeWorkspaceId.value === workspaceId) return;
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

  const closeWorkspace = async (workspaceId: string, force = false) => {
    const index = workspaces.value.findIndex((workspace) => workspace.workspaceId === workspaceId);
    const summary = workspaces.value[index];
    if (!summary) return;
    const wasActive = activeWorkspaceId.value === workspaceId;
    await window.diffuse.closeWorkspace(workspaceReference(summary), force);
    removeSummary(workspaceId);
    if (!wasActive) return;
    const next = workspaces.value[Math.min(index, workspaces.value.length - 1)];
    if (next) await activateWorkspace(next.workspaceId);
    else await showOverview();
  };

  const retryRestoreFailure = async (workspaceId: string) => {
    const diagnostic = restoreDiagnostics.value.find((item) => item.workspaceId === workspaceId);
    if (!diagnostic) return;
    const snapshot = await openWorkspace(diagnostic.root);
    restoreDiagnostics.value = restoreDiagnostics.value.filter((item) => item.workspaceId !== workspaceId);
    return snapshot;
  };

  const dismissRestoreFailure = async (workspaceId: string) => {
    const result = await window.diffuse.dismissRestoreFailure(workspaceId);
    restoreDiagnostics.value = restoreDiagnostics.value.filter((item) => item.workspaceId !== workspaceId);
    return result;
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

  const reorderWorkspaces = (workspaceIds: string[]) => {
    const currentIds = workspaces.value.map((workspace) => workspace.workspaceId);
    if (workspaceIds.length !== currentIds.length || workspaceIds.some((workspaceId) => !currentIds.includes(workspaceId))) return;
    persistedRailOrder.value = [...workspaceIds];
    workspaces.value = orderSummaries(workspaces.value, workspaceIds);
    persistUi();
    void window.diffuse.reorderWorkspaces([...workspaceIds]).catch((err) => {
      error.value = errorMessage(err);
    });
  };

  const uiState = (workspaceId: string): WorkspaceUiState => uiByWorkspaceId.value[workspaceId] ?? {};

  const saveUiState = (workspaceId: string, state: WorkspaceUiState) => {
    const normalized = normalizeUiState(state, inputRequests.value);
    uiByWorkspaceId.value = { ...uiByWorkspaceId.value, [workspaceId]: normalized };
    const workspace = workspaces.value.find((item) => item.workspaceId === workspaceId);
    if (!workspace) return;
    dirtyUiByWorkspaceId.value = {
      ...dirtyUiByWorkspaceId.value,
      [workspaceId]: { workspaceGeneration: workspace.workspaceGeneration, state: normalized },
    };
    persistUi();
    pendingUiSaves.set(workspaceId, { reference: workspaceReference(workspace), state: normalized });
    scheduleUiSave(workspaceId);
  };

  const inputRequest = (inputRequestId: string) => inputRequests.value[inputRequestId];

  const inputDraftKey = (request: Pick<InputRequest, 'id' | 'revision'>) => `${request.id}:${request.revision}`;

  const inputDraft = (request: InputRequest) => {
    const key = inputDraftKey(request);
    return transientInputDrafts.value[key] ?? uiState(request.workspaceId).inputDrafts?.[key] ?? '';
  };

  const saveInputDraft = (request: InputRequest, value: string) => {
    if (request.kind === 'authentication' || request.response?.secret) return;
    const key = inputDraftKey(request);
    transientInputDrafts.value = { ...transientInputDrafts.value, [key]: value };
    const state = uiState(request.workspaceId);
    saveUiState(request.workspaceId, { ...state, inputDrafts: { ...state.inputDrafts, [key]: value } });
  };

  const clearInputDraft = (request: InputRequest) => {
    const key = inputDraftKey(request);
    transientInputDrafts.value = Object.fromEntries(Object.entries(transientInputDrafts.value).filter(([entry]) => entry !== key));
    const state = uiState(request.workspaceId);
    if (!state.inputDrafts?.[key]) return;
    const inputDrafts = { ...state.inputDrafts };
    delete inputDrafts[key];
    saveUiState(request.workspaceId, { ...state, inputDrafts: Object.keys(inputDrafts).length > 0 ? inputDrafts : undefined });
  };

  const hasPendingInput = (workspaceId: string) =>
    Object.values(inputRequests.value).some((request) => request.workspaceId === workspaceId && request.status === 'pending');

  const hasInputDraft = (workspaceId: string) =>
    Object.values(inputRequests.value).some(
      (request) => request.workspaceId === workspaceId && request.status === 'pending' && inputDraft(request).trim().length > 0,
    );

  const acknowledgeAttention = async (attentionId: string, revision: number) => {
    const current = attentionItems.value[attentionId];
    if (!current || current.revision !== revision) return current;
    try {
      const result = await window.diffuse.acknowledgeAttention({
        context: requestContext(current.workspaceId),
        attentionId,
        revision,
      });
      applyAttentionItem(result.item);
      applyAttentionSummary(current.workspaceId, result.summary);
      return result.item;
    } catch (err) {
      applyAuthoritativeError(err);
      throw err;
    }
  };

  const answerInputRequest = async (inputRequestId: string, revision: number, response: InputResponse) => {
    const current = inputRequests.value[inputRequestId];
    if (!current || current.revision !== revision) return current;
    try {
      const result = await window.diffuse.answerInputRequest({
        context: requestContext(current.workspaceId),
        inputRequestId,
        revision,
        response,
      });
      applyInputMutation(result);
      return result.input;
    } catch (err) {
      applyAuthoritativeError(err);
      throw err;
    }
  };

  const cancelInputRequest = async (inputRequestId: string, revision: number) => {
    const current = inputRequests.value[inputRequestId];
    if (!current || current.revision !== revision || !current.cancellationSupported) return current;
    try {
      const result = await window.diffuse.cancelInputRequest({
        context: requestContext(current.workspaceId),
        inputRequestId,
        revision,
      });
      applyInputMutation(result);
      return result.input;
    } catch (err) {
      applyAuthoritativeError(err);
      throw err;
    }
  };

  const handleEvent = (event: WorkbenchEvent) => {
    if (restoreStatus.value === 'restoring') {
      restoringEvents.push(event);
      return;
    }
    eventQueue = eventQueue
      .then(() => applyEvent(event))
      .catch((err) => {
        error.value = errorMessage(err);
      });
  };

  const applyEvent = async (event: WorkbenchEvent) => {
    if (event.sequence <= sequence.value) return;
    if (event.sequence > sequence.value + 1) {
      const snapshot = await window.diffuse.getWorkbenchSnapshot();
      if (snapshot.sequence < sequence.value) return;
      applySnapshot(snapshot);
      if (snapshot.activeWorkspace) await dispatchActivation(snapshot.activeWorkspace);
      return;
    }
    sequence.value = event.sequence;
    if (event.kind === 'workspace/orderChanged') {
      persistedRailOrder.value = [...event.payload.workspaceIds];
      workspaces.value = orderSummaries(workspaces.value, persistedRailOrder.value);
      persistUi();
      return;
    }
    if (event.kind === 'workspace/added' || event.kind === 'workspace/summaryChanged') {
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
    const workspace = workspaces.value.find((item) => item.workspaceId === event.workspaceId);
    if (!workspace || workspace.workspaceGeneration !== event.workspaceGeneration) return;
    if (event.kind === 'workspace/attentionChanged') {
      applyAttentionItem(event.payload.item);
      upsertSummary(event.payload.summary);
      if (event.payload.item.kind === 'error' && event.payload.item.status === 'unread') {
        announce(`Error needs attention in ${event.payload.summary.displayName}.`);
      } else if (event.payload.item.kind === 'completion' && event.payload.item.status === 'unread') {
        announce(`Review completed in ${event.payload.summary.displayName}.`);
      }
      return;
    }
    if (event.kind === 'input/requested' || event.kind === 'input/responseSubmitted' || event.kind === 'input/resolved') {
      applyInputRequest(event.payload);
      if (event.kind === 'input/requested') announce(`Input required in ${workspace.displayName}: ${event.payload.prompt}`);
      else if (event.kind === 'input/responseSubmitted') announce(`Response submitted in ${workspace.displayName}.`);
      else announce(`Input request ${event.payload.status.replace('-', ' ')} in ${workspace.displayName}.`);
      return;
    }
    if (event.kind === 'workspace/uiStateChanged') {
      applyWorkspaceUiRecord(event.workspaceId, event.payload.record);
      return;
    }
    const state = uiState(event.workspaceId);
    saveUiState(event.workspaceId, { ...state, activityRevision: (state.activityRevision ?? 0) + 1 });
  };

  const applySnapshot = (snapshot: WorkbenchSnapshot) => {
    workspaces.value = [...snapshot.workspaces];
    persistedRailOrder.value = workspaces.value.map((workspace) => workspace.workspaceId);
    activeWorkspaceId.value = snapshot.activeWorkspaceId;
    sequence.value = snapshot.sequence;
    attentionItems.value = Object.fromEntries(snapshot.attentionItems.map((item) => [item.id, item]));
    inputRequests.value = Object.fromEntries(snapshot.inputRequests.map((request) => [request.id, request]));
    workspaceUiRecords.value = { ...snapshot.workspaceUiState };
    restoreDiagnostics.value = [...(snapshot.restoreDiagnostics ?? [])];
    dirtyUiByWorkspaceId.value = Object.fromEntries(
      Object.entries(dirtyUiByWorkspaceId.value).filter(([workspaceId, dirty]) => {
        const workspace = snapshot.workspaces.find((item) => item.workspaceId === workspaceId);
        return !workspace || workspace.workspaceGeneration === dirty.workspaceGeneration;
      }),
    );
    const openWorkspaceIds = new Set(snapshot.workspaces.map((workspace) => workspace.workspaceId));
    uiByWorkspaceId.value = Object.fromEntries(
      snapshot.workspaces.map((workspace) => {
        const persisted = snapshot.workspaceUiState[workspace.workspaceId];
        const dirty = dirtyUiByWorkspaceId.value[workspace.workspaceId];
        const state =
          dirty?.workspaceGeneration === workspace.workspaceGeneration
            ? dirty.state
            : persisted
              ? (persisted.state as WorkspaceUiState)
              : {};
        return [workspace.workspaceId, normalizeUiState(state, inputRequests.value)];
      }),
    );
    persistedRailOrder.value = persistedRailOrder.value.filter((workspaceId) => openWorkspaceIds.has(workspaceId));
    setActiveWorkspace(snapshot.activeWorkspace?.summary);
    persistUi();
    for (const workspace of snapshot.workspaces) {
      const dirty = dirtyUiByWorkspaceId.value[workspace.workspaceId];
      if (dirty?.workspaceGeneration !== workspace.workspaceGeneration) continue;
      pendingUiSaves.set(workspace.workspaceId, { reference: workspaceReference(workspace), state: dirty.state });
      scheduleUiSave(workspace.workspaceId);
    }
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
    const index = workspaces.value.findIndex((workspace) => workspace.workspaceId === summary.workspaceId);
    if (index === -1) {
      workspaces.value = [...workspaces.value, summary];
      persistedRailOrder.value = workspaces.value.map((workspace) => workspace.workspaceId);
    } else {
      const next = [...workspaces.value];
      next[index] = summary;
      workspaces.value = next;
    }
    persistUi();
  };

  const removeSummary = (workspaceId: string) => {
    const removedInputIds = new Set(
      Object.values(inputRequests.value)
        .filter((request) => request.workspaceId === workspaceId)
        .map((request) => request.id),
    );
    workspaces.value = workspaces.value.filter((workspace) => workspace.workspaceId !== workspaceId);
    attentionItems.value = Object.fromEntries(Object.entries(attentionItems.value).filter(([, item]) => item.workspaceId !== workspaceId));
    inputRequests.value = Object.fromEntries(
      Object.entries(inputRequests.value).filter(([, request]) => request.workspaceId !== workspaceId),
    );
    delete workspaceUiRecords.value[workspaceId];
    delete uiByWorkspaceId.value[workspaceId];
    delete dirtyUiByWorkspaceId.value[workspaceId];
    transientInputDrafts.value = Object.fromEntries(
      Object.entries(transientInputDrafts.value).filter(([key]) => !removedInputIds.has(key.slice(0, key.lastIndexOf(':')))),
    );
    if (activeWorkspaceId.value === workspaceId) activeWorkspaceId.value = null;
    persistedRailOrder.value = workspaces.value.map((workspace) => workspace.workspaceId);
    persistUi();
  };

  const applyAttentionItem = (item: AttentionItem) => {
    const current = attentionItems.value[item.id];
    if (
      current &&
      (current.revision > item.revision ||
        (current.revision === item.revision && attentionStatusRank(current.status) > attentionStatusRank(item.status)))
    ) {
      return false;
    }
    attentionItems.value = { ...attentionItems.value, [item.id]: item };
    return true;
  };

  const applyInputRequest = (request: InputRequest) => {
    const current = inputRequests.value[request.id];
    if (
      current &&
      (current.revision > request.revision ||
        (current.revision === request.revision && inputStatusRank(current.status) > inputStatusRank(request.status)))
    ) {
      return false;
    }
    inputRequests.value = { ...inputRequests.value, [request.id]: request };
    if (!current || current.revision !== request.revision || request.status !== 'pending') clearInputDrafts(request);
    return true;
  };

  const applyInputMutation = (result: InputMutationResult) => {
    applyInputRequest(result.input);
    if (result.attention) applyAttentionItem(result.attention);
    applyAttentionSummary(result.input.workspaceId, result.summary);
  };

  const applyAttentionSummary = (workspaceId: string, attention: WorkspaceSummary['attention']) => {
    const workspace = workspaces.value.find((item) => item.workspaceId === workspaceId);
    if (workspace) upsertSummary({ ...workspace, attention });
  };

  const clearInputDrafts = (request: InputRequest) => {
    const prefix = `${request.id}:`;
    transientInputDrafts.value = Object.fromEntries(
      Object.entries(transientInputDrafts.value).filter(
        ([key]) => !key.startsWith(prefix) || (request.status === 'pending' && key === inputDraftKey(request)),
      ),
    );
    const state = uiState(request.workspaceId);
    const inputDrafts = Object.fromEntries(
      Object.entries(state.inputDrafts ?? {}).filter(
        ([key]) => !key.startsWith(prefix) || (request.status === 'pending' && key === inputDraftKey(request)),
      ),
    );
    if (Object.keys(inputDrafts).length === Object.keys(state.inputDrafts ?? {}).length) return;
    saveUiState(request.workspaceId, {
      ...state,
      inputDrafts: Object.keys(inputDrafts).length > 0 ? inputDrafts : undefined,
    });
  };

  const applyWorkspaceUiRecord = (workspaceId: string, record: WorkspaceUiStateRecord) => {
    const current = workspaceUiRecords.value[workspaceId];
    if (current && current.revision > record.revision) return;
    workspaceUiRecords.value = { ...workspaceUiRecords.value, [workspaceId]: record };
    if (dirtyUiByWorkspaceId.value[workspaceId]) {
      persistUi();
      return;
    }
    uiByWorkspaceId.value = {
      ...uiByWorkspaceId.value,
      [workspaceId]: normalizeUiState(record.state as WorkspaceUiState, inputRequests.value),
    };
    persistUi();
  };

  const applyAuthoritativeError = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const current = (value as { current?: unknown }).current;
    if (isInputRequest(current)) applyInputRequest(current);
    else if (isAttentionItem(current)) applyAttentionItem(current);
    else if (isWorkspaceSummary(current)) upsertSummary(current);
    else if (isWorkspaceUiStateRecord(current)) {
      const workspaceId = (value as { workspaceId?: unknown }).workspaceId;
      if (typeof workspaceId === 'string') applyWorkspaceUiRecord(workspaceId, current);
    }
  };

  const requestContext = (workspaceId: string) => {
    const workspace = workspaces.value.find((item) => item.workspaceId === workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} is not open`);
    return { ...workspaceReference(workspace), requestId: crypto.randomUUID() };
  };

  const scheduleUiSave = (workspaceId: string) => {
    if (uiSavePromises.has(workspaceId)) return;
    const promise = drainUiSaves(workspaceId).finally(() => {
      uiSavePromises.delete(workspaceId);
      if (pendingUiSaves.has(workspaceId)) scheduleUiSave(workspaceId);
    });
    uiSavePromises.set(workspaceId, promise);
  };

  const drainUiSaves = async (workspaceId: string) => {
    while (pendingUiSaves.has(workspaceId)) {
      const pending = pendingUiSaves.get(workspaceId)!;
      pendingUiSaves.delete(workspaceId);
      if (!isCurrentWorkspace(pending.reference)) continue;
      const expectedRevision = workspaceUiRecords.value[workspaceId]?.revision ?? 0;
      try {
        const result = await window.diffuse.saveWorkspaceUiState({ ...pending.reference }, expectedRevision, plainState(pending.state));
        if (!isCurrentWorkspace(pending.reference)) continue;
        applyWorkspaceUiRecord(workspaceId, result.record);
        const next = pendingUiSaves.get(workspaceId);
        if (result.outcome === 'stale') {
          const dirty = dirtyUiByWorkspaceId.value[workspaceId];
          if (!next && dirty?.workspaceGeneration === pending.reference.workspaceGeneration) {
            pendingUiSaves.set(workspaceId, { reference: pending.reference, state: dirty.state });
          }
          continue;
        }
        if (result.outcome === 'applied' && !next) {
          uiByWorkspaceId.value = {
            ...uiByWorkspaceId.value,
            [workspaceId]: normalizeUiState(result.record.state as WorkspaceUiState, inputRequests.value),
          };
          clearDirtyUi(pending.reference);
        } else if (result.outcome === 'invalid' || result.outcome === 'unchanged') {
          error.value = `Workspace UI state save returned ${result.outcome}`;
        }
      } catch (err) {
        if (!isCurrentWorkspace(pending.reference)) continue;
        applyAuthoritativeError(err);
        error.value = errorMessage(err);
      }
    }
  };

  const isCurrentWorkspace = (reference: WorkspaceReference) => {
    const current = workspaces.value.find((workspace) => workspace.workspaceId === reference.workspaceId);
    return current !== undefined && matchesReference(current, reference);
  };

  const clearDirtyUi = (reference: WorkspaceReference) => {
    const dirty = dirtyUiByWorkspaceId.value[reference.workspaceId];
    if (!dirty || dirty.workspaceGeneration !== reference.workspaceGeneration) return;
    const next = { ...dirtyUiByWorkspaceId.value };
    delete next[reference.workspaceId];
    dirtyUiByWorkspaceId.value = next;
    persistUi();
  };

  const announce = (message: string) => {
    announcement.value = message;
    announcementRevision.value += 1;
  };

  const persistUi = () => {
    window.localStorage.setItem(
      workbenchUiStorageKey,
      JSON.stringify({
        railOrder: persistedRailOrder.value,
        dirtyUiByWorkspaceId: Object.fromEntries(
          Object.entries(dirtyUiByWorkspaceId.value).map(([workspaceId, dirty]) => [
            workspaceId,
            { ...dirty, state: normalizeUiState(dirty.state, inputRequests.value) },
          ]),
        ),
      }),
    );
  };

  return {
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    aggregateAttention,
    attentionItems,
    inputRequests,
    workspaceUiRecords,
    restoreDiagnostics,
    announcement,
    announcementRevision,
    restoreStatus,
    error,
    sequence,
    initialize,
    openWorkspace,
    activateWorkspace,
    showOverview,
    closeWorkspace,
    retryRestoreFailure,
    dismissRestoreFailure,
    activateRelative,
    activateSlot,
    reorderWorkspaces,
    uiState,
    saveUiState,
    inputRequest,
    inputDraft,
    saveInputDraft,
    clearInputDraft,
    hasPendingInput,
    hasInputDraft,
    acknowledgeAttention,
    answerInputRequest,
    cancelInputRequest,
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

function normalizeUiState(state: WorkspaceUiState, requests: Record<string, InputRequest>): WorkspaceUiState {
  const inputDrafts = Object.fromEntries(
    Object.entries(state.inputDrafts ?? {}).filter(([key]) => {
      const requestId = key.slice(0, key.lastIndexOf(':'));
      const request = requests[requestId];
      return !request || (request.kind !== 'authentication' && !request.response?.secret);
    }),
  );
  return {
    ...state,
    search: state.search ? { ...state.search, pinnedResults: state.search.pinnedResults.slice(0, maxPinnedResults) } : undefined,
    inputDrafts: Object.keys(inputDrafts).length > 0 ? inputDrafts : undefined,
  };
}

function plainState(state: WorkspaceUiState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}

function workspaceReference(workspace: WorkspaceSummary) {
  return {
    workspaceId: workspace.workspaceId,
    workspaceGeneration: workspace.workspaceGeneration,
  };
}

function matchesReference(first: WorkspaceReference, second: WorkspaceReference): boolean {
  return first.workspaceId === second.workspaceId && first.workspaceGeneration === second.workspaceGeneration;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function attentionStatusRank(status: AttentionItem['status']): number {
  if (status === 'unread') return 0;
  if (status === 'acknowledged') return 1;
  return 2;
}

function inputStatusRank(status: InputRequest['status']): number {
  if (status === 'pending') return 0;
  if (status === 'response-submitted') return 1;
  return 2;
}

function loadPersistedUi(): { railOrder: string[]; dirtyUiByWorkspaceId: Record<string, DirtyUiFallback> } {
  try {
    const raw = window.localStorage.getItem(workbenchUiStorageKey);
    if (!raw) return { railOrder: [], dirtyUiByWorkspaceId: {} };
    const parsed = JSON.parse(raw) as { railOrder?: unknown; dirtyUiByWorkspaceId?: unknown };
    const dirtyUiByWorkspaceId =
      parsed.dirtyUiByWorkspaceId && typeof parsed.dirtyUiByWorkspaceId === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.dirtyUiByWorkspaceId).filter(
              (entry): entry is [string, DirtyUiFallback] =>
                typeof entry[1] === 'object' &&
                entry[1] !== null &&
                typeof (entry[1] as DirtyUiFallback).workspaceGeneration === 'string' &&
                typeof (entry[1] as DirtyUiFallback).state === 'object' &&
                (entry[1] as DirtyUiFallback).state !== null,
            ),
          )
        : {};
    return {
      railOrder: Array.isArray(parsed.railOrder) ? parsed.railOrder.filter((item): item is string => typeof item === 'string') : [],
      dirtyUiByWorkspaceId,
    };
  } catch {
    return { railOrder: [], dirtyUiByWorkspaceId: {} };
  }
}
