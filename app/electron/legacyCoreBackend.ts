import type { CoreMethods } from '../src/lib/coreContract';
import type { WorkspaceCoreMethod, WorkspaceReference, WorkspaceRequestContext, WorkspaceResponse } from '../src/lib/workbenchContract';
import { CoreBackendError, type CoreBackend, type CoreBackendEventListener, type CoreBackendHealth } from './coreBackend';
import { LegacyWorkspaceRegistry } from './legacyWorkspaceRegistry';

export class LegacyCoreBackend implements CoreBackend {
  private state: 'running' | 'stopping' | 'stopped' = 'running';
  private shutdownOperation: Promise<void> | null = null;

  constructor(private readonly registry: LegacyWorkspaceRegistry) {}

  getVersion() {
    this.requireRunning();
    return this.registry.getVersion();
  }

  async getWorkbenchSnapshot() {
    this.requireRunning();
    return this.registry.getWorkbenchSnapshot();
  }

  openWorkspace(path: string) {
    this.requireRunning();
    return this.registry.openWorkspace(path);
  }

  async activateWorkspace(reference: WorkspaceReference | null) {
    this.requireRunning();
    if (reference === null) {
      this.registry.deactivateWorkspace();
      return null;
    }
    return this.registry.activateWorkspace(reference);
  }

  async getWorkspaceSnapshot(reference: WorkspaceReference) {
    this.requireRunning();
    return this.registry.getWorkspaceSnapshot(reference);
  }

  async closeWorkspace(reference: WorkspaceReference) {
    this.requireRunning();
    return this.registry.closeWorkspace(reference);
  }

  request<M extends WorkspaceCoreMethod>(
    context: WorkspaceRequestContext,
    method: M,
    params: CoreMethods[M]['params'],
  ): Promise<WorkspaceResponse<CoreMethods[M]['result']>> {
    this.requireRunning();
    return this.registry.request(context, method, params);
  }

  onEvents(listener: CoreBackendEventListener): () => void {
    this.requireRunning();
    return this.registry.onEvent((event) => listener([event]));
  }

  async health(): Promise<CoreBackendHealth> {
    if (this.state === 'stopping') return { status: 'stopping' };
    if (this.state === 'stopped') return { status: 'stopped' };
    return { status: 'healthy' };
  }

  shutdown(): Promise<void> {
    if (this.shutdownOperation) return this.shutdownOperation;
    this.state = 'stopping';
    this.shutdownOperation = Promise.resolve().then(() => {
      try {
        this.registry.dispose();
      } finally {
        this.state = 'stopped';
      }
    });
    return this.shutdownOperation;
  }

  private requireRunning(): void {
    if (this.state !== 'running') {
      throw new CoreBackendError('BACKEND_SHUT_DOWN', 'The core backend is shutting down or has stopped');
    }
  }
}
