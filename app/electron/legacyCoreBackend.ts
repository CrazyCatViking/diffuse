import type { CoreMethods } from '../src/lib/coreContract';
import { AcpBackend } from './acpBackend';
import type {
  AnswerInputRequest,
  AttentionCasRequest,
  CreateAttentionRequest,
  CreateInputRequest,
  InputCasRequest,
  SaveWorkspaceUiStateRequest,
  WorkspaceCoreMethod,
  WorkspaceReference,
  WorkspaceRequestContext,
  CloseWorkspaceRequest,
  WorkspaceResponse,
} from '../src/lib/workbenchContract';
import { CoreBackendError, type CoreBackend, type CoreBackendEventListener, type CoreBackendHealth } from './coreBackend';
import { LegacyWorkspaceRegistry } from './legacyWorkspaceRegistry';

export class LegacyCoreBackend extends AcpBackend implements CoreBackend {
  private state: 'running' | 'stopping' | 'stopped' = 'running';
  private shutdownOperation: Promise<void> | null = null;

  constructor(private readonly registry: LegacyWorkspaceRegistry) {
    super();
  }

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

  async closeWorkspace(request: CloseWorkspaceRequest) {
    this.requireRunning();
    return this.registry.closeWorkspace(request);
  }

  dismissRestoreFailure(_workspaceId: string): Promise<never> {
    return this.unsupportedPhase5Mutation();
  }

  async reorderWorkspaces(workspaceIds: string[]) {
    this.requireRunning();
    return this.registry.reorderWorkspaces(workspaceIds);
  }

  async saveWorkspaceUiState(request: SaveWorkspaceUiStateRequest) {
    this.requireRunning();
    return this.registry.saveWorkspaceUiState(request);
  }

  createAttention(_request: CreateAttentionRequest): Promise<never> {
    return this.unsupportedPhase5Mutation();
  }

  acknowledgeAttention(_request: AttentionCasRequest): Promise<never> {
    return this.unsupportedPhase5Mutation();
  }

  claimAttentionNotification(_request: AttentionCasRequest): Promise<never> {
    return this.unsupportedPhase5Mutation();
  }

  createInputRequest(_request: CreateInputRequest): Promise<never> {
    return this.unsupportedPhase5Mutation();
  }

  answerInputRequest(_request: AnswerInputRequest): Promise<never> {
    return this.unsupportedPhase5Mutation();
  }

  acceptInputRequest(_request: InputCasRequest): Promise<never> {
    return this.unsupportedPhase5Mutation();
  }

  rejectInputRequest(_request: InputCasRequest): Promise<never> {
    return this.unsupportedPhase5Mutation();
  }

  cancelInputRequest(_request: InputCasRequest): Promise<never> {
    return this.unsupportedPhase5Mutation();
  }

  expireInputRequest(_request: InputCasRequest): Promise<never> {
    return this.unsupportedPhase5Mutation();
  }

  supersedeInputRequest(_request: InputCasRequest): Promise<never> {
    return this.unsupportedPhase5Mutation();
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
    return {
      status: 'degraded',
      message: 'Legacy RPC mode does not support ACP agents, durable attention, input, or restore-failure operations',
      errorCode: 'UNSUPPORTED_IN_RPC_MODE',
    };
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

  private unsupportedPhase5Mutation(): Promise<never> {
    this.requireRunning();
    return Promise.reject(
      new CoreBackendError('UNSUPPORTED_IN_RPC_MODE', 'Attention and input mutations are not supported in legacy RPC mode'),
    );
  }
}
