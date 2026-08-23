import type { CoreEvent, CoreRequest } from './coreContract';
import type { ChangedFile, ReviewChatMessage, ReviewThread } from './protocol';

export type ReviewAgentStartRequest = {
  repositoryRoot: string;
  sessionId: string;
  files: ChangedFile[];
};

export type ReviewAgentChatRequest = {
  repositoryRoot: string;
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
  getLaunchRepository(): Promise<string | null>;
  openLspConfig(configPath?: string): Promise<string>;
  coreRequest: CoreRequest;
  onCoreEvent(listener: (event: CoreEvent) => void): () => void;
  startReviewAgent(request: ReviewAgentStartRequest): Promise<ReviewAgentStatus>;
  stopReviewAgent(): Promise<ReviewAgentStatus>;
  chatWithReviewAgent(request: ReviewAgentChatRequest): Promise<ReviewChatMessage>;
}
