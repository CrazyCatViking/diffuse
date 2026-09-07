import type { CoreMethods } from '../src/lib/coreContract';
import { isDeepStrictEqual } from 'node:util';
import type { VersionInfo } from '../src/lib/protocol';
import {
  isAttentionMutationResult,
  isInputMutationResult,
  isWorkbenchEvent,
  isWorkbenchSnapshot,
  isWorkspaceSnapshot,
  isWorkspaceSummary,
  isWorkspaceOrderResult,
  isSaveWorkspaceUiStateRequest,
  isDismissRestoreFailureResult,
  isWorkspaceUiStateMutationResult,
  type AnswerInputRequest,
  type AttentionCasRequest,
  type AttentionMutationResult,
  type CreateAttentionRequest,
  type CreateInputRequest,
  type InputCasRequest,
  type InputMutationResult,
  type SaveWorkspaceUiStateRequest,
  type WorkbenchEvent,
  type WorkbenchSnapshot,
  type WorkspaceCoreMethod,
  type WorkspaceReference,
  type WorkspaceRequestContext,
  type WorkspaceResponse,
  type WorkspaceSnapshot,
  type WorkspaceSummary,
  type WorkspaceOrderResult,
  type WorkspaceUiStateMutationResult,
  type CloseWorkspaceRequest,
  type DismissRestoreFailureResult,
} from '../src/lib/workbenchContract';
import { CoreBackendError, type CoreBackend, type CoreBackendEventListener, type CoreBackendHealth } from './coreBackend';
import type { NativeCoreAddon, NativeCoreAddonCreateOptions, NativeCoreAddonFactory } from './nativeCoreAddon';

export class NativeCoreBackend implements CoreBackend {
  private readonly addon: NativeCoreAddon;
  private readonly eventListeners = new Set<CoreBackendEventListener>();
  private state: 'running' | 'stopping' | 'stopped' = 'running';
  private lastSequence = 0;
  private eventProtocolError: CoreBackendError | null = null;
  private shutdownOperation: Promise<void> | null = null;

  constructor(factory: NativeCoreAddonFactory, options: Omit<NativeCoreAddonCreateOptions, 'onEventBatch'> = {}) {
    try {
      this.addon = factory({ ...options, onEventBatch: (events) => this.receiveEventBatch(events) });
    } catch (error) {
      throw normalizeNativeError('initialize', error, 'NATIVE_ADDON_INIT_FAILED');
    }
  }

  async getVersion(): Promise<VersionInfo> {
    const value = await this.call('getVersion', () => this.addon.getVersion());
    if (!isRecord(value) || typeof value.name !== 'string' || typeof value.version !== 'string') {
      throw protocolError('getVersion', 'version information');
    }
    return value as VersionInfo;
  }

  async getWorkbenchSnapshot(): Promise<WorkbenchSnapshot> {
    const value = await this.call('getWorkbenchSnapshot', () => this.addon.getWorkbenchSnapshot());
    if (!isWorkbenchSnapshot(value)) throw protocolError('getWorkbenchSnapshot', 'workbench snapshot');
    return value;
  }

  async openWorkspace(path: string): Promise<WorkspaceSnapshot> {
    const value = await this.call('openWorkspace', () => this.addon.openWorkspace(path));
    if (!isWorkspaceSnapshot(value)) throw protocolError('openWorkspace', 'workspace snapshot');
    return value;
  }

  async activateWorkspace(reference: WorkspaceReference | null): Promise<WorkspaceSnapshot | null> {
    const value = await this.call('activateWorkspace', () => this.addon.activateWorkspace(reference));
    if (reference === null) {
      if (value !== null) throw protocolError('activateWorkspace', 'null deactivation result');
      return null;
    }
    if (!isWorkspaceSnapshot(value) || !matchesReference(value.summary, reference)) {
      throw protocolError('activateWorkspace', 'matching workspace snapshot');
    }
    return value;
  }

  async getWorkspaceSnapshot(reference: WorkspaceReference): Promise<WorkspaceSnapshot> {
    const value = await this.call('getWorkspaceSnapshot', () => this.addon.getWorkspaceSnapshot(reference));
    if (!isWorkspaceSnapshot(value) || !matchesReference(value.summary, reference)) {
      throw protocolError('getWorkspaceSnapshot', 'matching workspace snapshot');
    }
    return value;
  }

  async closeWorkspace(request: CloseWorkspaceRequest): Promise<WorkspaceSummary> {
    const nativeRequest: CloseWorkspaceRequest = {
      workspaceId: request.workspaceId,
      workspaceGeneration: request.workspaceGeneration,
      force: request.force,
    };
    const value = await this.call('closeWorkspace', () => this.addon.closeWorkspace(nativeRequest));
    if (!isWorkspaceSummary(value) || !matchesReference(value, request) || value.state !== 'closed') {
      throw protocolError('closeWorkspace', 'matching workspace summary');
    }
    return value;
  }

  async dismissRestoreFailure(workspaceId: string): Promise<DismissRestoreFailureResult> {
    const value = await this.call('dismissRestoreFailure', () => this.addon.dismissRestoreFailure(workspaceId));
    if (!isDismissRestoreFailureResult(value) || value.workspaceId !== workspaceId) {
      throw protocolError('dismissRestoreFailure', 'restore failure dismissal result');
    }
    return value;
  }

  async reorderWorkspaces(workspaceIds: string[]): Promise<WorkspaceOrderResult> {
    const value = await this.call('reorderWorkspaces', () => this.addon.reorderWorkspaces(workspaceIds));
    if (!isWorkspaceOrderResult(value) || !sameStrings(value.workspaceIds, workspaceIds)) {
      throw protocolError('reorderWorkspaces', 'matching workspace order');
    }
    return value;
  }

  async saveWorkspaceUiState(request: SaveWorkspaceUiStateRequest): Promise<WorkspaceUiStateMutationResult> {
    if (!isSaveWorkspaceUiStateRequest(request)) throw invalidRequest('saveWorkspaceUiState');
    const value = await this.call('saveWorkspaceUiState', () => this.addon.saveWorkspaceUiState(request));
    if (!isWorkspaceUiStateMutationResult(value) || !validUiStateMutation(value, request)) {
      throw protocolError('saveWorkspaceUiState', 'workspace UI state mutation result');
    }
    return value;
  }

  async createAttention(request: CreateAttentionRequest): Promise<AttentionMutationResult> {
    const value = await this.call('createAttention', () => this.addon.createAttention(request));
    if (
      !isAttentionMutationResult(value) ||
      value.item.workspaceId !== request.workspaceId ||
      value.item.sourceId !== request.sourceId ||
      value.item.kind !== request.kind ||
      !validCreateRevision(value.outcome, value.item.revision, request.revision) ||
      (value.outcome === 'applied' && value.item.status !== (request.status ?? 'unread'))
    ) {
      throw protocolError('createAttention', 'attention mutation result');
    }
    return value;
  }

  acknowledgeAttention(request: AttentionCasRequest): Promise<AttentionMutationResult> {
    return this.mutateAttention('acknowledgeAttention', request, () => this.addon.acknowledgeAttention(request), 'acknowledged');
  }

  claimAttentionNotification(request: AttentionCasRequest): Promise<AttentionMutationResult> {
    return this.mutateAttention('claimAttentionNotification', request, () => this.addon.claimAttentionNotification(request));
  }

  async createInputRequest(request: CreateInputRequest): Promise<InputMutationResult> {
    const value = await this.call('createInputRequest', () => this.addon.createInputRequest(request));
    if (
      !isInputMutationResult(value) ||
      value.input.workspaceId !== request.workspaceId ||
      (request.id !== undefined && value.input.id !== request.id) ||
      !validCreateRevision(value.outcome, value.input.revision, request.revision) ||
      (value.outcome === 'applied' && value.input.status !== 'pending') ||
      !validInputAttention(value)
    ) {
      throw protocolError('createInputRequest', 'input mutation result');
    }
    return value;
  }

  answerInputRequest(request: AnswerInputRequest): Promise<InputMutationResult> {
    return this.mutateInput('answerInputRequest', request, () => this.addon.answerInputRequest(request), 'response-submitted');
  }

  acceptInputRequest(request: InputCasRequest): Promise<InputMutationResult> {
    return this.mutateInput('acceptInputRequest', request, () => this.addon.acceptInputRequest(request), 'accepted');
  }

  rejectInputRequest(request: InputCasRequest): Promise<InputMutationResult> {
    return this.mutateInput('rejectInputRequest', request, () => this.addon.rejectInputRequest(request), 'rejected');
  }

  cancelInputRequest(request: InputCasRequest): Promise<InputMutationResult> {
    return this.mutateInput('cancelInputRequest', request, () => this.addon.cancelInputRequest(request), 'cancelled');
  }

  expireInputRequest(request: InputCasRequest): Promise<InputMutationResult> {
    return this.mutateInput('expireInputRequest', request, () => this.addon.expireInputRequest(request), 'expired');
  }

  supersedeInputRequest(request: InputCasRequest): Promise<InputMutationResult> {
    return this.mutateInput('supersedeInputRequest', request, () => this.addon.supersedeInputRequest(request), 'superseded');
  }

  async request<M extends WorkspaceCoreMethod>(
    context: WorkspaceRequestContext,
    method: M,
    params: CoreMethods[M]['params'],
  ): Promise<WorkspaceResponse<CoreMethods[M]['result']>> {
    const result = await this.call(`request:${method}`, () => this.addon.request(context, method, params));
    return { context, result: result as CoreMethods[M]['result'] };
  }

  onEvents(listener: CoreBackendEventListener): () => void {
    this.requireRunning();
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async health(): Promise<CoreBackendHealth> {
    if (this.state === 'stopped') return { status: 'stopped' };
    let value: unknown;
    try {
      value = await this.addon.health();
    } catch (error) {
      if (error instanceof CoreBackendError) throw error;
      throw normalizeNativeError('health', error);
    }
    if (!isCoreBackendHealth(value)) throw protocolError('health', 'backend health');
    if (!this.eventProtocolError || value.status !== 'healthy') return value;
    return {
      ...value,
      status: 'degraded',
      message: this.eventProtocolError.message,
      errorCode: this.eventProtocolError.code,
    };
  }

  shutdown(): Promise<void> {
    if (this.shutdownOperation) return this.shutdownOperation;
    this.state = 'stopping';
    this.eventListeners.clear();
    this.shutdownOperation = this.invokeShutdown();
    return this.shutdownOperation;
  }

  private async invokeShutdown(): Promise<void> {
    try {
      await this.addon.shutdown();
      this.state = 'stopped';
    } catch (error) {
      throw normalizeNativeError('shutdown', error);
    }
  }

  private async call<T>(operation: string, invoke: () => Promise<T>): Promise<T> {
    this.requireRunning();
    try {
      return await invoke();
    } catch (error) {
      if (error instanceof CoreBackendError) throw error;
      throw normalizeNativeError(operation, error);
    }
  }

  private async mutateAttention(
    operation: string,
    request: AttentionCasRequest,
    invoke: () => Promise<unknown>,
    appliedStatus?: string,
  ): Promise<AttentionMutationResult> {
    const value = await this.call(operation, invoke);
    if (
      !isAttentionMutationResult(value) ||
      value.item.workspaceId !== request.workspaceId ||
      value.item.id !== request.attentionId ||
      !validCasRevision(value.outcome, value.item.revision, request.expectedRevision) ||
      (appliedStatus !== undefined && (value.outcome === 'applied' || value.outcome === 'unchanged') && value.item.status !== appliedStatus)
    ) {
      throw protocolError(operation, 'attention mutation result');
    }
    return value;
  }

  private async mutateInput(
    operation: string,
    request: InputCasRequest | AnswerInputRequest,
    invoke: () => Promise<unknown>,
    appliedStatus: string,
  ): Promise<InputMutationResult> {
    const value = await this.call(operation, invoke);
    if (
      !isInputMutationResult(value) ||
      value.input.workspaceId !== request.workspaceId ||
      value.input.id !== request.inputRequestId ||
      !validCasRevision(value.outcome, value.input.revision, request.expectedRevision) ||
      ((value.outcome === 'applied' || value.outcome === 'unchanged') && value.input.status !== appliedStatus) ||
      !validInputAttention(value)
    ) {
      throw protocolError(operation, 'input mutation result');
    }
    return value;
  }

  private receiveEventBatch(value: unknown): void {
    if (this.state !== 'running') return;
    let events: WorkbenchEvent[];
    try {
      if (!Array.isArray(value)) throw protocolError('events', 'event batch');
      events = [];
      let sequence = this.lastSequence;
      for (const candidate of value) {
        if (!isWorkbenchEvent(candidate)) throw protocolError('events', 'workbench event');
        if (candidate.sequence <= sequence) throw protocolError('events', 'strictly ordered event batch');
        sequence = candidate.sequence;
        events.push(candidate);
      }
      if (events.length === 0) return;
      this.lastSequence = sequence;
    } catch (error) {
      this.eventProtocolError = error instanceof CoreBackendError ? error : normalizeNativeError('events', error, 'NATIVE_PROTOCOL_ERROR');
      return;
    }
    for (const listener of this.eventListeners) {
      try {
        listener(events);
      } catch (error) {
        console.error('Core backend event listener failed:', error);
      }
    }
  }

  private requireRunning(): void {
    if (this.state !== 'running') {
      throw new CoreBackendError('BACKEND_SHUT_DOWN', 'The native core backend is shutting down or has stopped');
    }
  }
}

function matchesReference(value: WorkspaceReference, reference: WorkspaceReference): boolean {
  return value.workspaceId === reference.workspaceId && value.workspaceGeneration === reference.workspaceGeneration;
}

function validCreateRevision(outcome: string, actual: number, requested: number): boolean {
  return outcome === 'stale' ? actual > requested : actual === requested;
}

function validCasRevision(outcome: string, actual: number, expected: number): boolean {
  if (outcome === 'stale') return actual !== expected;
  return actual === expected;
}

function validInputAttention(value: InputMutationResult): boolean {
  return (
    value.attention === undefined ||
    (value.attention.workspaceId === value.input.workspaceId &&
      value.attention.id === value.input.attentionId &&
      value.attention.kind === 'input' &&
      value.attention.sourceId === value.input.id &&
      value.attention.revision === value.input.revision)
  );
}

function validUiStateMutation(value: WorkspaceUiStateMutationResult, request: SaveWorkspaceUiStateRequest): boolean {
  if (value.outcome === 'applied') {
    return value.record.revision === request.expectedRevision + 1 && isDeepStrictEqual(value.record.state, request.state);
  }
  if (value.outcome === 'stale') return value.record.revision !== request.expectedRevision;
  if (value.outcome === 'unchanged') {
    return value.record.revision === request.expectedRevision && isDeepStrictEqual(value.record.state, request.state);
  }
  return true;
}

function sameStrings(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function protocolError(operation: string, expected: string): CoreBackendError {
  return new CoreBackendError('NATIVE_PROTOCOL_ERROR', `Native core returned an invalid ${expected} for ${operation}`);
}

function invalidRequest(operation: string): CoreBackendError {
  return new CoreBackendError('INVALID_ARGUMENT', `Invalid request for native core ${operation}`);
}

function normalizeNativeError(operation: string, error: unknown, fallbackCode = 'NATIVE_CALL_FAILED'): CoreBackendError {
  if (error instanceof CoreBackendError) return error;
  const nativeCode = isRecord(error) && typeof error.code === 'string' && error.code ? error.code : undefined;
  const detail =
    error instanceof Error ? error.message : isRecord(error) && typeof error.message === 'string' ? error.message : String(error);
  const normalized = new CoreBackendError(nativeCode ?? fallbackCode, `Native core ${operation} failed: ${detail}`, { cause: error });
  normalized.name = 'NativeCoreBackendError';
  return normalized;
}

function isCoreBackendHealth(value: unknown): value is CoreBackendHealth {
  if (!isRecord(value)) return false;
  if (!['healthy', 'degraded', 'unhealthy', 'stopping', 'stopped'].includes(String(value.status))) return false;
  return value.message === undefined || typeof value.message === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
