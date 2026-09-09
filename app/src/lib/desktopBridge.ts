import type { VersionInfo } from './protocol';
import type { AcpBridge } from './acpContract';
import type { ReviewWavesBridge } from './acpReviewWaves';
import type {
  AttentionMutationResult,
  InputMutationResult,
  InputResponse,
  WorkbenchEvent,
  WorkbenchSnapshot,
  WorkspaceReference,
  WorkspaceRequest,
  WorkspaceRequestContext,
  WorkspaceSnapshot,
  WorkspaceSummary,
  WorkspaceUiStateMutationResult,
  WorkspaceNavigationTarget,
  DismissRestoreFailureResult,
} from './workbenchContract';

export type AttentionNavigationRequest = {
  workspaceId: string;
  target: WorkspaceNavigationTarget;
  attentionId: string;
  revision: number;
};

export interface DesktopBridge extends AcpBridge, ReviewWavesBridge {
  pickRepository(): Promise<string | null>;
  openLspConfig(configPath?: string): Promise<string>;
  getVersion(): Promise<VersionInfo>;
  getWorkbenchSnapshot(): Promise<WorkbenchSnapshot>;
  readyForWorkbenchNavigation(): Promise<void>;
  getWorkspaceSnapshot(reference: WorkspaceReference): Promise<WorkspaceSnapshot>;
  openWorkspace(path: string): Promise<WorkspaceSnapshot>;
  activateWorkspace(reference: WorkspaceReference | null): Promise<WorkspaceSnapshot | null>;
  closeWorkspace(reference: WorkspaceReference, force?: boolean): Promise<WorkspaceSummary>;
  dismissRestoreFailure(workspaceId: string): Promise<DismissRestoreFailureResult>;
  reorderWorkspaces(workspaceIds: string[]): Promise<{ workspaceIds: string[] }>;
  saveWorkspaceUiState(
    reference: WorkspaceReference,
    expectedRevision: number,
    state: Record<string, unknown>,
  ): Promise<WorkspaceUiStateMutationResult>;
  acknowledgeAttention(request: {
    context: WorkspaceRequestContext;
    attentionId: string;
    revision: number;
  }): Promise<AttentionMutationResult>;
  answerInputRequest(request: {
    context: WorkspaceRequestContext;
    inputRequestId: string;
    revision: number;
    response: InputResponse;
  }): Promise<InputMutationResult>;
  cancelInputRequest(request: { context: WorkspaceRequestContext; inputRequestId: string; revision: number }): Promise<InputMutationResult>;
  workspaceRequest: WorkspaceRequest;
  onWorkbenchEvent(listener: (event: WorkbenchEvent) => void): () => void;
  onAttentionNavigation(listener: (request: AttentionNavigationRequest) => void): () => void;
}
