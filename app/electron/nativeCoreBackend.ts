import type { CoreMethods } from '../src/lib/coreContract';
import type { VersionInfo } from '../src/lib/protocol';
import {
  isWorkbenchEvent,
  isWorkbenchSnapshot,
  isWorkspaceSnapshot,
  isWorkspaceSummary,
  type WorkbenchEvent,
  type WorkbenchSnapshot,
  type WorkspaceCoreMethod,
  type WorkspaceReference,
  type WorkspaceRequestContext,
  type WorkspaceResponse,
  type WorkspaceSnapshot,
  type WorkspaceSummary,
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

  async closeWorkspace(reference: WorkspaceReference): Promise<WorkspaceSummary> {
    const value = await this.call('closeWorkspace', () => this.addon.closeWorkspace(reference));
    if (!isWorkspaceSummary(value) || !matchesReference(value, reference) || value.state !== 'closed') {
      throw protocolError('closeWorkspace', 'matching workspace summary');
    }
    return value;
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

function protocolError(operation: string, expected: string): CoreBackendError {
  return new CoreBackendError('NATIVE_PROTOCOL_ERROR', `Native core returned an invalid ${expected} for ${operation}`);
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
