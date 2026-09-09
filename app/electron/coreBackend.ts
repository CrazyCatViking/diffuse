import type { AcpBridge } from '../src/lib/acpContract';
import type { CoreMethods } from '../src/lib/coreContract';
import type { VersionInfo } from '../src/lib/protocol';
import type {
  AnswerInputRequest,
  AttentionCasRequest,
  AttentionMutationResult,
  CreateAttentionRequest,
  CreateInputRequest,
  InputCasRequest,
  InputMutationResult,
  SaveWorkspaceUiStateRequest,
  WorkbenchEvent,
  WorkbenchSnapshot,
  WorkspaceCoreMethod,
  WorkspaceReference,
  WorkspaceRequestContext,
  WorkspaceResponse,
  WorkspaceSnapshot,
  WorkspaceSummary,
  WorkspaceOrderResult,
  WorkspaceUiStateMutationResult,
  CloseWorkspaceRequest,
  DismissRestoreFailureResult,
} from '../src/lib/workbenchContract';

export type CoreBackendHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'stopping' | 'stopped';

export type CoreBackendHealth = {
  status: CoreBackendHealthStatus;
  message?: string;
  [key: string]: unknown;
};

export type CoreBackendEventListener = (events: readonly WorkbenchEvent[]) => void;

export interface CoreBackend extends AcpBridge {
  getVersion(): Promise<VersionInfo>;
  getWorkbenchSnapshot(): Promise<WorkbenchSnapshot>;
  openWorkspace(path: string): Promise<WorkspaceSnapshot>;
  activateWorkspace(reference: WorkspaceReference | null): Promise<WorkspaceSnapshot | null>;
  getWorkspaceSnapshot(reference: WorkspaceReference): Promise<WorkspaceSnapshot>;
  closeWorkspace(request: CloseWorkspaceRequest): Promise<WorkspaceSummary>;
  dismissRestoreFailure(workspaceId: string): Promise<DismissRestoreFailureResult>;
  reorderWorkspaces(workspaceIds: string[]): Promise<WorkspaceOrderResult>;
  saveWorkspaceUiState(request: SaveWorkspaceUiStateRequest): Promise<WorkspaceUiStateMutationResult>;
  createAttention(request: CreateAttentionRequest): Promise<AttentionMutationResult>;
  acknowledgeAttention(request: AttentionCasRequest): Promise<AttentionMutationResult>;
  claimAttentionNotification(request: AttentionCasRequest): Promise<AttentionMutationResult>;
  createInputRequest(request: CreateInputRequest): Promise<InputMutationResult>;
  answerInputRequest(request: AnswerInputRequest): Promise<InputMutationResult>;
  acceptInputRequest(request: InputCasRequest): Promise<InputMutationResult>;
  rejectInputRequest(request: InputCasRequest): Promise<InputMutationResult>;
  cancelInputRequest(request: InputCasRequest): Promise<InputMutationResult>;
  expireInputRequest(request: InputCasRequest): Promise<InputMutationResult>;
  supersedeInputRequest(request: InputCasRequest): Promise<InputMutationResult>;
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
