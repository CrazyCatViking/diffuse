import type {
  BranchInfo,
  ChangedFile,
  DiffAnalysis,
  DiffAnalysisStatus,
  DiffRenderModel,
  DiffRenderOptions,
  DiffTarget,
  DiffTargetDefaults,
  InstallLspServerResult,
  InstallTreeSitterGrammarResult,
  LspConfigInfo,
  LspDiagnostics,
  LspHover,
  LspInstallInfo,
  LspStatus,
  OpenRepositoryResult,
  RestartLspServerResult,
  ReviewAgentState,
  ReviewChatMessage,
  ReviewConfig,
  ReviewedFilesState,
  ReviewedFilesUpdate,
  ReviewProgress,
  ReviewRun,
  ReviewSession,
  ReviewThread,
  SyncTreeSitterRegistryResult,
  SyntaxLineSpans,
  SyntaxSide,
  TreeSitterGrammar,
  UninstallTreeSitterGrammarResult,
  VersionInfo,
} from './protocol';
import type { SearchFilterKind, SearchMode, SearchResult } from './search/searchTypes';

export const coreMethodNames = [
  'getVersion',
  'openRepository',
  'getDiffTargetDefaults',
  'listBranches',
  'listChangedFiles',
  'getDiffRenderModel',
  'getDiffAnalysis',
  'getDiffAnalysisStatuses',
  'ensureDiffAnalysis',
  'getSyntaxSpans',
  'getLspConfigInfo',
  'getLspInstallInfo',
  'installLspServer',
  'restartLspServer',
  'getLspStatus',
  'getLspHover',
  'getLspDiagnostics',
  'getReviewConfig',
  'saveReviewConfig',
  'getActiveReviewSession',
  'listReviewSessions',
  'createReviewSession',
  'getReviewProgress',
  'saveReviewProgress',
  'getReviewedFiles',
  'saveReviewedFiles',
  'updateReviewedFiles',
  'getReviewAgentStates',
  'saveReviewAgentState',
  'getReviewRuns',
  'recoverStaleReviewRuns',
  'saveReviewRun',
  'createReviewRun',
  'updateReviewRun',
  'finishReviewRun',
  'getReviewThreads',
  'getReviewChatMessages',
  'saveReviewChatMessage',
  'addReviewCommentPayload',
  'addReviewComment',
  'saveReviewThread',
  'listTreeSitterGrammars',
  'syncTreeSitterRegistry',
  'installTreeSitterGrammar',
  'uninstallTreeSitterGrammar',
  'startSearch',
  'cancelSearch',
] as const;

export type CoreMethod = (typeof coreMethodNames)[number];

export type CoreMethods = {
  getVersion: { params: Record<string, never>; result: VersionInfo };
  openRepository: { params: { path: string }; result: OpenRepositoryResult };
  getDiffTargetDefaults: { params: Record<string, never>; result: DiffTargetDefaults };
  listBranches: { params: Record<string, never>; result: BranchInfo[] };
  listChangedFiles: { params: { target: DiffTarget }; result: ChangedFile[] };
  getDiffRenderModel: { params: { fileId: string; options: DiffRenderOptions; target: DiffTarget }; result: DiffRenderModel };
  getDiffAnalysis: {
    params: { fileId: string; signature: string; options: Pick<DiffRenderOptions, 'context'>; target: DiffTarget };
    result: DiffAnalysis | null;
  };
  getDiffAnalysisStatuses: {
    params: { files: { fileId: string; signature: string }[]; options: Pick<DiffRenderOptions, 'context'>; target: DiffTarget };
    result: DiffAnalysisStatus[];
  };
  ensureDiffAnalysis: {
    params: { fileId: string; signature: string; options: Pick<DiffRenderOptions, 'context'>; target: DiffTarget };
    result: DiffAnalysisStatus;
  };
  getSyntaxSpans: {
    params: {
      fileId: string;
      side: SyntaxSide;
      startLine: number;
      endLine: number;
      options: Pick<DiffRenderOptions, 'context'>;
      target: DiffTarget;
    };
    result: SyntaxLineSpans[];
  };
  getLspConfigInfo: { params: Record<string, never>; result: LspConfigInfo };
  getLspInstallInfo: { params: { serverId: string; command: string }; result: LspInstallInfo };
  installLspServer: { params: { serverId: string; command: string }; result: InstallLspServerResult };
  restartLspServer: { params: { serverId: string }; result: RestartLspServerResult };
  getLspStatus: { params: { fileId: string; side: SyntaxSide; target: DiffTarget }; result: LspStatus };
  getLspHover: { params: { fileId: string; side: SyntaxSide; line: number; column: number; target: DiffTarget }; result: LspHover };
  getLspDiagnostics: { params: { fileId: string; side: SyntaxSide; target: DiffTarget }; result: LspDiagnostics };
  getReviewConfig: { params: Record<string, never>; result: ReviewConfig };
  saveReviewConfig: { params: { config: ReviewConfig }; result: ReviewConfig };
  getActiveReviewSession: { params: Record<string, never>; result: ReviewSession | null };
  listReviewSessions: { params: Record<string, never>; result: ReviewSession[] };
  createReviewSession: { params: { session: ReviewSession }; result: ReviewSession };
  getReviewProgress: { params: { sessionId: string }; result: ReviewProgress | null };
  saveReviewProgress: { params: { sessionId: string; progress: ReviewProgress }; result: ReviewProgress };
  getReviewedFiles: { params: { sessionId: string }; result: ReviewedFilesState };
  saveReviewedFiles: { params: { sessionId: string; reviewedFiles: ReviewedFilesState }; result: ReviewedFilesState };
  updateReviewedFiles: { params: { sessionId: string; update: ReviewedFilesUpdate }; result: ReviewedFilesState };
  getReviewAgentStates: { params: { sessionId: string }; result: ReviewAgentState[] };
  saveReviewAgentState: { params: { sessionId: string; agent: ReviewAgentState }; result: ReviewAgentState };
  getReviewRuns: { params: { sessionId: string }; result: ReviewRun[] };
  recoverStaleReviewRuns: { params: { sessionId: string }; result: { recovered: number } };
  saveReviewRun: { params: { sessionId: string; run: ReviewRun }; result: ReviewRun };
  createReviewRun: { params: { sessionId: string; run: ReviewRun }; result: ReviewRun };
  updateReviewRun: { params: { sessionId: string; run: ReviewRun }; result: ReviewRun };
  finishReviewRun: { params: { sessionId: string; run: ReviewRun }; result: ReviewRun };
  getReviewThreads: { params: { sessionId: string }; result: ReviewThread[] };
  getReviewChatMessages: { params: { sessionId: string }; result: ReviewChatMessage[] };
  saveReviewChatMessage: { params: { sessionId: string; message: ReviewChatMessage }; result: ReviewChatMessage };
  addReviewCommentPayload: { params: { sessionId: string; runId: string; comment: unknown }; result: ReviewThread };
  addReviewComment: { params: { sessionId: string; comment: ReviewThread }; result: ReviewThread };
  saveReviewThread: { params: { sessionId: string; thread: ReviewThread }; result: ReviewThread };
  listTreeSitterGrammars: { params: Record<string, never>; result: TreeSitterGrammar[] };
  syncTreeSitterRegistry: { params: { gitUrl?: string }; result: SyncTreeSitterRegistryResult };
  installTreeSitterGrammar: { params: { language: string }; result: InstallTreeSitterGrammarResult };
  uninstallTreeSitterGrammar: { params: { language: string }; result: UninstallTreeSitterGrammarResult };
  startSearch: {
    params: { searchId?: string; sessionId: string; query: string; mode: SearchMode; filters: SearchFilterKind[]; target: DiffTarget };
    result: { searchId: string };
  };
  cancelSearch: { params: { searchId: string }; result: { cancelled: boolean } };
};

export type CoreRequest = <M extends CoreMethod>(method: M, params?: CoreMethods[M]['params']) => Promise<CoreMethods[M]['result']>;

export type RepositoryChangedEvent = {
  method: 'repository/changed';
  params: { root: string; paths: string[] };
};

export type ReviewChangedEvent = {
  method: 'review/changed';
  params: { root: string; paths?: string[]; sessionId?: string; change?: string };
};

export type TreeSitterInstallProgressEvent = {
  method: 'treeSitter/installProgress';
  params: { language: string; step: string };
};

export type LspInstallProgressEvent = {
  method: 'lsp/installProgress';
  params: { serverId: string; step: string };
};

export type SearchStartedEvent = {
  method: 'search/started';
  params: { searchId: string };
};

export type SearchResultsEvent = {
  method: 'search/results';
  params: { searchId: string; results: SearchResult[] };
};

export type SearchProgressEvent = {
  method: 'search/progress';
  params: { searchId: string; scannedFiles: number; totalFiles: number; emittedResults: number };
};

export type SearchDoneEvent = {
  method: 'search/done';
  params: { searchId: string; totalResults: number; scannedFiles: number };
};

export type SearchCancelledEvent = {
  method: 'search/cancelled';
  params: { searchId: string; scannedFiles: number; emittedResults: number };
};

export type SearchErrorEvent = {
  method: 'search/error';
  params: { searchId: string; message: string };
};

export type DiffAnalysisStatusChangedEvent = {
  method: 'diffAnalysis/statusChanged';
  params: DiffAnalysisStatus;
};

export type CoreEvent =
  | RepositoryChangedEvent
  | ReviewChangedEvent
  | TreeSitterInstallProgressEvent
  | LspInstallProgressEvent
  | SearchStartedEvent
  | SearchResultsEvent
  | SearchProgressEvent
  | SearchDoneEvent
  | SearchCancelledEvent
  | SearchErrorEvent
  | DiffAnalysisStatusChangedEvent;
