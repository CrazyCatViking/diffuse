import type { VersionInfo, ChangedFile, ReviewChatMessage, ReviewThread } from './protocol';
import type {
  WorkbenchEvent,
  WorkbenchSnapshot,
  WorkspaceReference,
  WorkspaceRequest,
  WorkspaceRequestContext,
  WorkspaceSnapshot,
  WorkspaceSummary,
} from './workbenchContract';

export type ReviewAgentStartRequest = {
  context: WorkspaceRequestContext;
  sessionId: string;
  files: ChangedFile[];
};

export type ReviewAgentChatRequest = {
  context: WorkspaceRequestContext;
  sessionId: string;
  thread: ReviewThread;
  question: string;
  userMessageId?: string;
  responseMessageId?: string;
  chatMessages?: ReviewChatMessage[];
};

export type ReviewAgentStatus = {
  running: boolean;
  runIds?: string[];
  provider?: string;
  status?: string;
  message?: string;
};

export interface DesktopBridge {
  pickRepository(): Promise<string | null>;
  openLspConfig(configPath?: string): Promise<string>;
  getVersion(): Promise<VersionInfo>;
  getWorkbenchSnapshot(): Promise<WorkbenchSnapshot>;
  openWorkspace(path: string): Promise<WorkspaceSnapshot>;
  activateWorkspace(reference: WorkspaceReference): Promise<WorkspaceSnapshot>;
  closeWorkspace(reference: WorkspaceReference): Promise<WorkspaceSummary>;
  workspaceRequest: WorkspaceRequest;
  onWorkbenchEvent(listener: (event: WorkbenchEvent) => void): () => void;
  startReviewAgent(request: ReviewAgentStartRequest): Promise<ReviewAgentStatus>;
  stopReviewAgent(context: WorkspaceRequestContext): Promise<ReviewAgentStatus>;
  chatWithReviewAgent(request: ReviewAgentChatRequest): Promise<ReviewChatMessage>;
}
