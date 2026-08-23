import type {
  BranchInfo,
  ChangedFile,
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
  getVersion: { params: undefined; result: VersionInfo };
  openRepository: { params: { path: string }; result: OpenRepositoryResult };
  getDiffTargetDefaults: { params: undefined; result: DiffTargetDefaults };
  listBranches: { params: undefined; result: BranchInfo[] };
  listChangedFiles: { params: { target: DiffTarget }; result: ChangedFile[] };
  getDiffRenderModel: { params: { fileId: string; options: DiffRenderOptions; target: DiffTarget }; result: DiffRenderModel };
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
  getLspConfigInfo: { params: undefined; result: LspConfigInfo };
  getLspInstallInfo: { params: { serverId: string; command: string }; result: LspInstallInfo };
  installLspServer: { params: { serverId: string; command: string }; result: InstallLspServerResult };
  restartLspServer: { params: { serverId: string }; result: RestartLspServerResult };
  getLspStatus: { params: { fileId: string; side: SyntaxSide; target: DiffTarget }; result: LspStatus };
  getLspHover: { params: { fileId: string; side: SyntaxSide; line: number; column: number; target: DiffTarget }; result: LspHover };
  getLspDiagnostics: { params: { fileId: string; side: SyntaxSide; target: DiffTarget }; result: LspDiagnostics };
  getReviewConfig: { params: undefined; result: ReviewConfig };
  saveReviewConfig: { params: { config: ReviewConfig }; result: ReviewConfig };
  getActiveReviewSession: { params: undefined; result: ReviewSession | null };
  listReviewSessions: { params: undefined; result: ReviewSession[] };
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
  listTreeSitterGrammars: { params: undefined; result: TreeSitterGrammar[] };
  syncTreeSitterRegistry: { params: { gitUrl?: string }; result: SyncTreeSitterRegistryResult };
  installTreeSitterGrammar: { params: { language: string }; result: InstallTreeSitterGrammarResult };
  uninstallTreeSitterGrammar: { params: { language: string }; result: UninstallTreeSitterGrammarResult };
  startSearch: {
    params: { searchId?: string; sessionId: string; query: string; mode: SearchMode; filters: SearchFilterKind[]; target: DiffTarget };
    result: { searchId: string };
  };
  cancelSearch: { params: { searchId: string }; result: { cancelled: boolean } };
};

type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];

export type CoreRequestArgs<P> = [P] extends [undefined] ? [] : RequiredKeys<P> extends never ? [params?: P] : [params: P];

export type CoreRequest = <M extends CoreMethod>(
  method: M,
  ...args: CoreRequestArgs<CoreMethods[M]['params']>
) => Promise<CoreMethods[M]['result']>;

export const coreEventNames = [
  'repository/changed',
  'review/changed',
  'treeSitter/installProgress',
  'lsp/installProgress',
  'search/started',
  'search/results',
  'search/progress',
  'search/done',
  'search/cancelled',
  'search/error',
] as const;

export type CoreEventMap = {
  'repository/changed': { root: string; paths: string[] };
  'review/changed': { root: string; paths?: string[]; sessionId?: string; change?: string };
  'treeSitter/installProgress': { language: string; step: string };
  'lsp/installProgress': { serverId: string; step: string };
  'search/started': { searchId: string };
  'search/results': { searchId: string; results: SearchResult[] };
  'search/progress': { searchId: string; scannedFiles: number; totalFiles: number; emittedResults: number };
  'search/done': { searchId: string; totalResults: number; scannedFiles: number };
  'search/cancelled': { searchId: string; scannedFiles: number; emittedResults: number };
  'search/error': { searchId: string; message: string };
};

export type CoreEventName = (typeof coreEventNames)[number];

export type CoreEvent = {
  [K in CoreEventName]: { jsonrpc?: '2.0'; method: K; params: CoreEventMap[K] };
}[CoreEventName];

const coreEventNameSet = new Set<string>(coreEventNames);

export function isCoreEvent(value: unknown): value is CoreEvent {
  if (!isRecord(value) || (value.jsonrpc !== undefined && value.jsonrpc !== '2.0')) return false;
  if (typeof value.method !== 'string' || !coreEventNameSet.has(value.method)) return false;

  switch (value.method as CoreEventName) {
    case 'repository/changed':
      return isRootAndPaths(value.params, true);
    case 'review/changed':
      return isReviewChangedParams(value.params);
    case 'treeSitter/installProgress':
      return hasStrings(value.params, 'language', 'step');
    case 'lsp/installProgress':
      return hasStrings(value.params, 'serverId', 'step');
    case 'search/started':
      return hasStrings(value.params, 'searchId');
    case 'search/results':
      return isSearchResultsParams(value.params);
    case 'search/progress':
      return hasSearchIdAndNumbers(value.params, 'scannedFiles', 'totalFiles', 'emittedResults');
    case 'search/done':
      return hasSearchIdAndNumbers(value.params, 'totalResults', 'scannedFiles');
    case 'search/cancelled':
      return hasSearchIdAndNumbers(value.params, 'scannedFiles', 'emittedResults');
    case 'search/error':
      return hasStrings(value.params, 'searchId', 'message');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStrings(value: unknown, ...keys: string[]): value is Record<string, string> {
  return isRecord(value) && keys.every((key) => typeof value[key] === 'string');
}

function hasSearchIdAndNumbers(value: unknown, ...keys: string[]): boolean {
  return hasStrings(value, 'searchId') && keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRootAndPaths(value: unknown, pathsRequired: boolean): boolean {
  if (!isRecord(value) || typeof value.root !== 'string') return false;
  return pathsRequired ? isStringArray(value.paths) : value.paths === undefined || isStringArray(value.paths);
}

function isReviewChangedParams(value: unknown): boolean {
  if (!isRootAndPaths(value, false) || !isRecord(value)) return false;
  return (
    (value.sessionId === undefined || typeof value.sessionId === 'string') &&
    (value.change === undefined || typeof value.change === 'string')
  );
}

function isSearchResultsParams(value: unknown): boolean {
  return isRecord(value) && typeof value.searchId === 'string' && Array.isArray(value.results) && value.results.every(isSearchResult);
}

function isSearchResult(value: unknown): value is SearchResult {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.rank !== 'number' || !Array.isArray(value.matches)) {
    return false;
  }
  if (!['file', 'comment', 'content', 'symbol'].includes(String(value.kind))) return false;
  if (value.kind === 'file') return typeof value.fileId === 'string' && typeof value.path === 'string' && isRecord(value.file);
  if (value.kind === 'comment') {
    return (
      typeof value.fileId === 'string' &&
      typeof value.path === 'string' &&
      typeof value.threadId === 'string' &&
      typeof value.body === 'string'
    );
  }
  if (value.kind === 'content') {
    return (
      typeof value.fileId === 'string' &&
      typeof value.path === 'string' &&
      typeof value.line === 'number' &&
      (value.side === 'old' || value.side === 'new') &&
      typeof value.preview === 'string'
    );
  }
  return (
    typeof value.fileId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.line === 'number' &&
    (value.side === 'old' || value.side === 'new') &&
    typeof value.symbolName === 'string' &&
    typeof value.symbolKind === 'string'
  );
}
