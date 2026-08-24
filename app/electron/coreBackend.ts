import type { CoreMethods } from '../src/lib/coreContract';
import type { VersionInfo } from '../src/lib/protocol';
import type {
  WorkbenchEvent,
  WorkbenchSnapshot,
  WorkspaceCoreMethod,
  WorkspaceReference,
  WorkspaceRequestContext,
  WorkspaceResponse,
  WorkspaceSnapshot,
  WorkspaceSummary,
} from '../src/lib/workbenchContract';

export type CoreBackendHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'stopping' | 'stopped';

export type CoreBackendHealth = {
  status: CoreBackendHealthStatus;
  message?: string;
  [key: string]: unknown;
};

export type CoreBackendEventListener = (events: readonly WorkbenchEvent[]) => void;

export interface CoreBackend {
  getVersion(): Promise<VersionInfo>;
  getWorkbenchSnapshot(): Promise<WorkbenchSnapshot>;
  openWorkspace(path: string): Promise<WorkspaceSnapshot>;
  activateWorkspace(reference: WorkspaceReference | null): Promise<WorkspaceSnapshot | null>;
  getWorkspaceSnapshot(reference: WorkspaceReference): Promise<WorkspaceSnapshot>;
  closeWorkspace(reference: WorkspaceReference): Promise<WorkspaceSummary>;
  request<M extends WorkspaceCoreMethod>(
    context: WorkspaceRequestContext,
    method: M,
    params: CoreMethods[M]['params'],
  ): Promise<WorkspaceResponse<CoreMethods[M]['result']>>;
  onEvents(listener: CoreBackendEventListener): () => void;
  health(): Promise<CoreBackendHealth>;
  shutdown(): Promise<void>;
}

export class CoreBackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CoreBackendError';
  }
}
