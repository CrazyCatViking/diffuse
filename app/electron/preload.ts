import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { isDeepStrictEqual } from 'node:util';
import type { DesktopBridge, ReviewAgentChatRequest, ReviewAgentStartRequest } from '../src/lib/desktopBridge';
import {
  isAttentionMutationResult,
  isInputMutationResult,
  isWorkbenchEvent,
  isWorkbenchSnapshot,
  isWorkspaceSnapshot,
  isWorkspaceNavigationTarget,
  isWorkspaceOrderResult,
  isWorkspaceSummary,
  isWorkspaceUiStateMutationResult,
  isDismissRestoreFailureResult,
  type WorkspaceReference,
  type WorkspaceRequest,
} from '../src/lib/workbenchContract';

const workspaceRequest: WorkspaceRequest = (context, method, ...args) => {
  return ipcRenderer.invoke('workspace:request', { context, method, params: args[0] });
};

const onWorkbenchEvent: DesktopBridge['onWorkbenchEvent'] = (listener) => {
  const handler = (_event: IpcRendererEvent, workbenchEvent: unknown) => {
    if (isWorkbenchEvent(workbenchEvent)) listener(workbenchEvent);
  };
  ipcRenderer.on('workbench:event', handler);
  return () => ipcRenderer.off('workbench:event', handler);
};

const onAttentionNavigation: DesktopBridge['onAttentionNavigation'] = (listener) => {
  const handler = (_event: IpcRendererEvent, request: unknown) => {
    if (
      isRecord(request) &&
      isNonEmptyString(request.workspaceId) &&
      isWorkspaceNavigationTarget(request.target) &&
      isNonEmptyString(request.attentionId) &&
      isPositiveSafeInteger(request.revision)
    ) {
      listener({
        workspaceId: request.workspaceId,
        target: request.target,
        attentionId: request.attentionId,
        revision: request.revision,
      });
    }
  };
  ipcRenderer.on('attention:navigate', handler);
  return () => ipcRenderer.off('attention:navigate', handler);
};

const pickRepository = () => {
  return ipcRenderer.invoke('repo:pickDirectory');
};

const getVersion = () => {
  return ipcRenderer.invoke('app:getVersion');
};

const getWorkbenchSnapshot: DesktopBridge['getWorkbenchSnapshot'] = async () => {
  return validate(await ipcRenderer.invoke('workbench:getSnapshot'), isWorkbenchSnapshot, 'workbench snapshot');
};

const readyForWorkbenchNavigation: DesktopBridge['readyForWorkbenchNavigation'] = async () => {
  await ipcRenderer.invoke('workbench:rendererReady');
};

const getWorkspaceSnapshot: DesktopBridge['getWorkspaceSnapshot'] = async (reference) => {
  const snapshot = validate(await ipcRenderer.invoke('workspace:getSnapshot', reference), isWorkspaceSnapshot, 'workspace snapshot');
  if (!matchesReference(snapshot.summary, reference)) throw new Error('Workspace snapshot response identity mismatch');
  return snapshot;
};

const openWorkspace: DesktopBridge['openWorkspace'] = async (path) => {
  return validate(await ipcRenderer.invoke('workspace:open', { path }), isWorkspaceSnapshot, 'workspace snapshot');
};

const activateWorkspace: DesktopBridge['activateWorkspace'] = async (reference) => {
  const result = await ipcRenderer.invoke('workspace:activate', reference);
  if (result === null) return null;
  const snapshot = validate(result, isWorkspaceSnapshot, 'workspace snapshot');
  if (reference && !matchesReference(snapshot.summary, reference)) throw new Error('Workspace activation response identity mismatch');
  return snapshot;
};

const closeWorkspace: DesktopBridge['closeWorkspace'] = async (reference, force = false) => {
  const summary = validate(await ipcRenderer.invoke('workspace:close', { ...reference, force }), isWorkspaceSummary, 'workspace summary');
  if (!matchesReference(summary, reference)) throw new Error('Workspace close response identity mismatch');
  return summary;
};

const dismissRestoreFailure: DesktopBridge['dismissRestoreFailure'] = async (workspaceId) => {
  const result = validate(
    await ipcRenderer.invoke('workspace:dismissRestoreFailure', { workspaceId }),
    isDismissRestoreFailureResult,
    'restore failure dismissal result',
  );
  if (result.workspaceId !== workspaceId) throw new Error('Restore failure dismissal response identity mismatch');
  return result;
};

const reorderWorkspaces: DesktopBridge['reorderWorkspaces'] = async (workspaceIds) => {
  const result = await ipcRenderer.invoke('workspace:reorder', { workspaceIds });
  if (!isWorkspaceOrderResult(result) || !sameStrings(result.workspaceIds, workspaceIds)) {
    throw new Error('Invalid workspace order response');
  }
  return result;
};

const saveWorkspaceUiState: DesktopBridge['saveWorkspaceUiState'] = async (reference, expectedRevision, state) => {
  const result = validate(
    await ipcRenderer.invoke('workspace:saveUiState', { ...reference, expectedRevision, state }),
    isWorkspaceUiStateMutationResult,
    'workspace UI state mutation result',
  );
  if (result.outcome === 'applied' && (result.record.revision !== expectedRevision + 1 || !isDeepStrictEqual(result.record.state, state))) {
    throw new Error('Workspace UI state response revision mismatch');
  }
  if (result.outcome === 'stale' && result.record.revision === expectedRevision) {
    throw new Error('Workspace UI state stale response revision mismatch');
  }
  if (result.outcome === 'unchanged' && (result.record.revision !== expectedRevision || !isDeepStrictEqual(result.record.state, state))) {
    throw new Error('Workspace UI state unchanged response revision mismatch');
  }
  return result;
};

const acknowledgeAttention: DesktopBridge['acknowledgeAttention'] = async (request) => {
  const result = validate(
    await ipcRenderer.invoke('attention:acknowledge', request),
    isAttentionMutationResult,
    'attention acknowledgement response',
  );
  if (
    result.item.id !== request.attentionId ||
    result.item.workspaceId !== request.context.workspaceId ||
    !validCasRevision(result.outcome, result.item.revision, request.revision) ||
    ((result.outcome === 'applied' || result.outcome === 'unchanged') && result.item.status !== 'acknowledged')
  ) {
    throw new Error('Attention acknowledgement response identity mismatch');
  }
  return result;
};

const answerInputRequest: DesktopBridge['answerInputRequest'] = async (request) => {
  const result = validate(await ipcRenderer.invoke('input:answer', request), isInputMutationResult, 'input mutation result');
  validateInputResponseIdentity(result, request.context.workspaceId, request.inputRequestId, request.revision, 'response-submitted');
  return result;
};

const cancelInputRequest: DesktopBridge['cancelInputRequest'] = async (request) => {
  const result = validate(await ipcRenderer.invoke('input:cancel', request), isInputMutationResult, 'input mutation result');
  validateInputResponseIdentity(result, request.context.workspaceId, request.inputRequestId, request.revision, 'cancelled');
  return result;
};

const openLspConfig = (configPath?: string) => {
  return ipcRenderer.invoke('lsp:openConfig', { configPath });
};

const startReviewAgent = (request: ReviewAgentStartRequest) => {
  return ipcRenderer.invoke('review-agent:start', request);
};

const stopReviewAgent: DesktopBridge['stopReviewAgent'] = (context) => {
  return ipcRenderer.invoke('review-agent:stop', context);
};

const chatWithReviewAgent = (request: ReviewAgentChatRequest) => {
  return ipcRenderer.invoke('review-agent:chat', request);
};

const bridge = {
  pickRepository,
  openLspConfig,
  getVersion,
  getWorkbenchSnapshot,
  readyForWorkbenchNavigation,
  getWorkspaceSnapshot,
  openWorkspace,
  activateWorkspace,
  closeWorkspace,
  dismissRestoreFailure,
  reorderWorkspaces,
  saveWorkspaceUiState,
  acknowledgeAttention,
  answerInputRequest,
  cancelInputRequest,
  workspaceRequest,
  onWorkbenchEvent,
  onAttentionNavigation,
  startReviewAgent,
  stopReviewAgent,
  chatWithReviewAgent,
} satisfies DesktopBridge;

function validate<T>(value: unknown, guard: (candidate: unknown) => candidate is T, label: string): T {
  if (!guard(value)) throw new Error(`Invalid ${label} response`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesReference(first: WorkspaceReference, second: WorkspaceReference): boolean {
  return first.workspaceId === second.workspaceId && first.workspaceGeneration === second.workspaceGeneration;
}

function validateInputResponseIdentity(
  result: Awaited<ReturnType<DesktopBridge['answerInputRequest']>>,
  workspaceId: string,
  inputRequestId: string,
  revision: number,
  expectedStatus: 'response-submitted' | 'cancelled',
): void {
  if (
    result.input.workspaceId !== workspaceId ||
    result.input.id !== inputRequestId ||
    !validCasRevision(result.outcome, result.input.revision, revision) ||
    ((result.outcome === 'applied' || result.outcome === 'unchanged') && result.input.status !== expectedStatus) ||
    (result.attention !== undefined &&
      (result.attention.workspaceId !== workspaceId ||
        result.attention.id !== result.input.attentionId ||
        result.attention.revision !== result.input.revision))
  ) {
    throw new Error('Input request response identity mismatch');
  }
}

function validCasRevision(outcome: string, actual: number, expected: number): boolean {
  if (outcome === 'stale') return actual !== expected;
  return actual === expected;
}

function sameStrings(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

contextBridge.exposeInMainWorld('diffuse', bridge);
