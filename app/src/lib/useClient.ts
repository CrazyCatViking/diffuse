import {
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
import type { SearchFilterKind, SearchMode } from './search/searchTypes';
import type {
  WorkbenchSnapshot,
  WorkspaceCoreMethod,
  WorkspaceReference,
  WorkspaceRequestContext,
  WorkspaceSnapshot,
} from './workbenchContract';
import type { CoreMethods, CoreRequestArgs } from './coreContract';

let activeWorkspace: WorkspaceReference | undefined;
let activationEpoch = 0;

export function setActiveWorkspace(reference: WorkspaceReference | undefined): void {
  if (activeWorkspace?.workspaceId !== reference?.workspaceId || activeWorkspace?.workspaceGeneration !== reference?.workspaceGeneration) {
    activationEpoch += 1;
  }
  activeWorkspace = reference ? { ...reference } : undefined;
}

export function getActiveWorkspace(): WorkspaceReference | undefined {
  return activeWorkspace ? { ...activeWorkspace } : undefined;
}

export function isActiveWorkspace(reference: WorkspaceReference): boolean {
  return activeWorkspace?.workspaceId === reference.workspaceId && activeWorkspace.workspaceGeneration === reference.workspaceGeneration;
}

export const useClient = () => {
  const plainDiffTarget = (target: DiffTarget): DiffTarget => ({
    base: target.base,
    compare: target.compare,
    includeStaged: target.includeStaged,
    includeUnstaged: target.includeUnstaged,
  });

  const plainJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const requestContext = (): WorkspaceRequestContext => {
    if (!activeWorkspace) throw new Error('No active workspace');
    return { ...activeWorkspace, requestId: crypto.randomUUID() };
  };

  const workspaceRequest = async <M extends WorkspaceCoreMethod>(
    method: M,
    ...args: CoreRequestArgs<CoreMethods[M]['params']>
  ): Promise<CoreMethods[M]['result']> => {
    const context = requestContext();
    const requestActivationEpoch = activationEpoch;
    const response = await window.diffuse.workspaceRequest(context, method, ...args);
    if (
      response.context.workspaceId !== context.workspaceId ||
      response.context.workspaceGeneration !== context.workspaceGeneration ||
      response.context.requestId !== context.requestId
    ) {
      throw new Error(`Workspace response context mismatch for ${method}`);
    }
    if (!isActiveWorkspace(context) || requestActivationEpoch !== activationEpoch) {
      throw new Error(`Workspace changed while ${method} was running`);
    }
    return response.result;
  };

  const pickRepository = async (): Promise<string | null> => {
    return window.diffuse.pickRepository();
  };

  const getVersion = async (): Promise<VersionInfo> => {
    return window.diffuse.getVersion();
  };

  const openRepository = async (path: string): Promise<WorkspaceSnapshot> => {
    const snapshot = await window.diffuse.openWorkspace(path);
    setActiveWorkspace(snapshot.summary);
    return snapshot;
  };

  const getWorkbenchSnapshot = async (): Promise<WorkbenchSnapshot> => {
    const snapshot = await window.diffuse.getWorkbenchSnapshot();
    setActiveWorkspace(snapshot.activeWorkspace?.summary);
    return snapshot;
  };

  const activateWorkspace = async (reference: WorkspaceReference | null): Promise<WorkspaceSnapshot | null> => {
    const snapshot = await window.diffuse.activateWorkspace(reference);
    setActiveWorkspace(snapshot?.summary);
    return snapshot;
  };

  const getDiffTargetDefaults = async (): Promise<DiffTargetDefaults> => {
    return workspaceRequest('getDiffTargetDefaults');
  };

  const listBranches = async (): Promise<BranchInfo[]> => {
    return workspaceRequest('listBranches');
  };

  const listChangedFiles = async (target: DiffTarget): Promise<ChangedFile[]> => {
    return workspaceRequest('listChangedFiles', { target: plainDiffTarget(target) });
  };

  const getDiffRenderModel = async (fileId: string, options: DiffRenderOptions, target: DiffTarget): Promise<DiffRenderModel> => {
    return workspaceRequest('getDiffRenderModel', { fileId, options, target: plainDiffTarget(target) });
  };

  const getSyntaxSpans = async (
    fileId: string,
    side: SyntaxSide,
    startLine: number,
    endLine: number,
    options: Pick<DiffRenderOptions, 'context'>,
    target: DiffTarget,
  ): Promise<SyntaxLineSpans[]> => {
    return workspaceRequest('getSyntaxSpans', { fileId, side, startLine, endLine, options, target: plainDiffTarget(target) });
  };

  const getLspStatus = async (fileId: string, side: SyntaxSide, target: DiffTarget): Promise<LspStatus> => {
    return workspaceRequest('getLspStatus', { fileId, side, target: plainDiffTarget(target) });
  };

  const getLspConfigInfo = async (): Promise<LspConfigInfo> => {
    return workspaceRequest('getLspConfigInfo');
  };

  const getLspInstallInfo = async (serverId: string, command: string): Promise<LspInstallInfo> => {
    return workspaceRequest('getLspInstallInfo', { serverId, command });
  };

  const installLspServer = async (serverId: string, command: string): Promise<InstallLspServerResult> => {
    return workspaceRequest('installLspServer', { serverId, command });
  };

  const restartLspServer = async (serverId: string): Promise<RestartLspServerResult> => {
    return workspaceRequest('restartLspServer', { serverId });
  };

  const getLspHover = async (fileId: string, side: SyntaxSide, line: number, column: number, target: DiffTarget): Promise<LspHover> => {
    return workspaceRequest('getLspHover', { fileId, side, line, column, target: plainDiffTarget(target) });
  };

  const getLspDiagnostics = async (fileId: string, side: SyntaxSide, target: DiffTarget): Promise<LspDiagnostics> => {
    return workspaceRequest('getLspDiagnostics', { fileId, side, target: plainDiffTarget(target) });
  };

  const installTreeSitterGrammar = async (language: string): Promise<InstallTreeSitterGrammarResult> => {
    return workspaceRequest('installTreeSitterGrammar', { language });
  };

  const getActiveReviewSession = async (): Promise<ReviewSession | null> => {
    return workspaceRequest('getActiveReviewSession');
  };

  const getReviewConfig = async (): Promise<ReviewConfig> => {
    return workspaceRequest('getReviewConfig');
  };

  const saveReviewConfig = async (config: ReviewConfig): Promise<ReviewConfig> => {
    return workspaceRequest('saveReviewConfig', { config: plainJson(config) });
  };

  const createReviewSession = async (session: ReviewSession): Promise<ReviewSession> => {
    return workspaceRequest('createReviewSession', { session: plainJson(session) });
  };

  const listReviewSessions = async (): Promise<ReviewSession[]> => {
    return workspaceRequest('listReviewSessions');
  };

  const getReviewProgress = async (sessionId: string): Promise<ReviewProgress | null> => {
    return workspaceRequest('getReviewProgress', { sessionId });
  };

  const saveReviewProgress = async (sessionId: string, progress: ReviewProgress): Promise<ReviewProgress> => {
    return workspaceRequest('saveReviewProgress', { sessionId, progress: plainJson(progress) });
  };

  const getReviewedFiles = async (sessionId: string): Promise<ReviewedFilesState> => {
    return workspaceRequest('getReviewedFiles', { sessionId });
  };

  const saveReviewedFiles = async (sessionId: string, reviewedFiles: ReviewedFilesState): Promise<ReviewedFilesState> => {
    return workspaceRequest('saveReviewedFiles', { sessionId, reviewedFiles: plainJson(reviewedFiles) });
  };

  const updateReviewedFiles = async (sessionId: string, update: ReviewedFilesUpdate): Promise<ReviewedFilesState> => {
    return workspaceRequest('updateReviewedFiles', { sessionId, update: plainJson(update) });
  };

  const saveReviewAgentState = async (sessionId: string, agent: ReviewAgentState): Promise<ReviewAgentState> => {
    return workspaceRequest('saveReviewAgentState', { sessionId, agent: plainJson(agent) });
  };

  const getReviewAgentStates = async (sessionId: string): Promise<ReviewAgentState[]> => {
    return workspaceRequest('getReviewAgentStates', { sessionId });
  };

  const getReviewRuns = async (sessionId: string): Promise<ReviewRun[]> => {
    return workspaceRequest('getReviewRuns', { sessionId });
  };

  const recoverStaleReviewRuns = async (sessionId: string): Promise<{ recovered: number }> => {
    return workspaceRequest('recoverStaleReviewRuns', { sessionId });
  };

  const saveReviewRun = async (sessionId: string, run: ReviewRun): Promise<ReviewRun> => {
    return workspaceRequest('saveReviewRun', { sessionId, run: plainJson(run) });
  };

  const getReviewThreads = async (sessionId: string): Promise<ReviewThread[]> => {
    return workspaceRequest('getReviewThreads', { sessionId });
  };

  const saveReviewThread = async (sessionId: string, thread: ReviewThread): Promise<ReviewThread> => {
    return workspaceRequest('saveReviewThread', { sessionId, thread: plainJson(thread) });
  };

  const getReviewChatMessages = async (sessionId: string): Promise<ReviewChatMessage[]> => {
    return workspaceRequest('getReviewChatMessages', { sessionId });
  };

  const saveReviewChatMessage = async (sessionId: string, message: ReviewChatMessage): Promise<ReviewChatMessage> => {
    return workspaceRequest('saveReviewChatMessage', { sessionId, message: plainJson(message) });
  };

  const addReviewComment = async (sessionId: string, comment: ReviewThread): Promise<ReviewThread> => {
    return workspaceRequest('addReviewComment', { sessionId, comment: plainJson(comment) });
  };

  const startReviewAgent = async (_repositoryRoot: string, sessionId: string, files: ChangedFile[]): Promise<void> => {
    await window.diffuse.startReviewAgent({ context: requestContext(), sessionId, files: plainJson(files) });
  };

  const stopReviewAgent = async (): Promise<void> => {
    await window.diffuse.stopReviewAgent(requestContext());
  };

  const chatWithReviewAgent = async (
    _repositoryRoot: string,
    sessionId: string,
    thread: ReviewThread,
    question: string,
    chatMessages: ReviewChatMessage[],
    userMessageId?: string,
    responseMessageId?: string,
  ): Promise<ReviewChatMessage> => {
    return window.diffuse.chatWithReviewAgent({
      context: requestContext(),
      sessionId,
      thread: plainJson(thread),
      question,
      userMessageId,
      responseMessageId,
      chatMessages: plainJson(chatMessages),
    });
  };

  const listTreeSitterGrammars = async (): Promise<TreeSitterGrammar[]> => {
    return workspaceRequest('listTreeSitterGrammars');
  };

  const syncTreeSitterRegistry = async (gitUrl?: string): Promise<SyncTreeSitterRegistryResult> => {
    return workspaceRequest('syncTreeSitterRegistry', { gitUrl });
  };

  const uninstallTreeSitterGrammar = async (language: string): Promise<UninstallTreeSitterGrammarResult> => {
    return workspaceRequest('uninstallTreeSitterGrammar', { language });
  };

  const startSearch = async (request: {
    searchId?: string;
    sessionId: string;
    query: string;
    mode: SearchMode;
    filters: SearchFilterKind[];
    target: DiffTarget;
  }): Promise<{ searchId: string }> => {
    return workspaceRequest('startSearch', {
      searchId: request.searchId,
      sessionId: request.sessionId,
      query: request.query,
      mode: request.mode,
      filters: plainJson(request.filters),
      target: plainDiffTarget(request.target),
    });
  };

  const cancelSearch = async (searchId: string): Promise<{ cancelled: boolean }> => {
    return workspaceRequest('cancelSearch', { searchId });
  };

  return {
    pickRepository,
    getVersion,
    getWorkbenchSnapshot,
    activateWorkspace,
    openRepository,
    getDiffTargetDefaults,
    listBranches,
    listChangedFiles,
    getDiffRenderModel,
    getSyntaxSpans,
    getLspConfigInfo,
    getLspInstallInfo,
    installLspServer,
    restartLspServer,
    getLspStatus,
    getLspHover,
    getLspDiagnostics,
    getReviewConfig,
    saveReviewConfig,
    getActiveReviewSession,
    listReviewSessions,
    createReviewSession,
    getReviewProgress,
    saveReviewProgress,
    getReviewedFiles,
    saveReviewedFiles,
    updateReviewedFiles,
    getReviewAgentStates,
    saveReviewAgentState,
    getReviewRuns,
    recoverStaleReviewRuns,
    saveReviewRun,
    getReviewThreads,
    addReviewComment,
    saveReviewThread,
    getReviewChatMessages,
    saveReviewChatMessage,
    startReviewAgent,
    stopReviewAgent,
    chatWithReviewAgent,
    installTreeSitterGrammar,
    listTreeSitterGrammars,
    syncTreeSitterRegistry,
    uninstallTreeSitterGrammar,
    startSearch,
    cancelSearch,
  };
};
