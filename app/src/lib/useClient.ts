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

export const useClient = () => {
  const plainDiffTarget = (target: DiffTarget): DiffTarget => ({
    base: target.base,
    compare: target.compare,
    includeStaged: target.includeStaged,
    includeUnstaged: target.includeUnstaged,
  });

  const plainJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const pickRepository = async (): Promise<string | null> => {
    return window.diffuse.pickRepository();
  };

  const getVersion = async (): Promise<VersionInfo> => {
    return window.diffuse.coreRequest('getVersion');
  };

  const openRepository = async (path: string): Promise<OpenRepositoryResult> => {
    return window.diffuse.coreRequest('openRepository', { path });
  };

  const getDiffTargetDefaults = async (): Promise<DiffTargetDefaults> => {
    return window.diffuse.coreRequest('getDiffTargetDefaults');
  };

  const listBranches = async (): Promise<BranchInfo[]> => {
    return window.diffuse.coreRequest('listBranches');
  };

  const listChangedFiles = async (target: DiffTarget): Promise<ChangedFile[]> => {
    return window.diffuse.coreRequest('listChangedFiles', { target: plainDiffTarget(target) });
  };

  const getDiffRenderModel = async (fileId: string, options: DiffRenderOptions, target: DiffTarget): Promise<DiffRenderModel> => {
    return window.diffuse.coreRequest('getDiffRenderModel', { fileId, options, target: plainDiffTarget(target) });
  };

  const getSyntaxSpans = async (
    fileId: string,
    side: SyntaxSide,
    startLine: number,
    endLine: number,
    options: Pick<DiffRenderOptions, 'context'>,
    target: DiffTarget,
  ): Promise<SyntaxLineSpans[]> => {
    return window.diffuse.coreRequest('getSyntaxSpans', { fileId, side, startLine, endLine, options, target: plainDiffTarget(target) });
  };

  const getLspStatus = async (fileId: string, side: SyntaxSide, target: DiffTarget): Promise<LspStatus> => {
    return window.diffuse.coreRequest('getLspStatus', { fileId, side, target: plainDiffTarget(target) });
  };

  const getLspConfigInfo = async (): Promise<LspConfigInfo> => {
    return window.diffuse.coreRequest('getLspConfigInfo');
  };

  const getLspInstallInfo = async (serverId: string, command: string): Promise<LspInstallInfo> => {
    return window.diffuse.coreRequest('getLspInstallInfo', { serverId, command });
  };

  const installLspServer = async (serverId: string, command: string): Promise<InstallLspServerResult> => {
    return window.diffuse.coreRequest('installLspServer', { serverId, command });
  };

  const restartLspServer = async (serverId: string): Promise<RestartLspServerResult> => {
    return window.diffuse.coreRequest('restartLspServer', { serverId });
  };

  const getLspHover = async (fileId: string, side: SyntaxSide, line: number, column: number, target: DiffTarget): Promise<LspHover> => {
    return window.diffuse.coreRequest('getLspHover', { fileId, side, line, column, target: plainDiffTarget(target) });
  };

  const getLspDiagnostics = async (fileId: string, side: SyntaxSide, target: DiffTarget): Promise<LspDiagnostics> => {
    return window.diffuse.coreRequest('getLspDiagnostics', { fileId, side, target: plainDiffTarget(target) });
  };

  const installTreeSitterGrammar = async (language: string): Promise<InstallTreeSitterGrammarResult> => {
    return window.diffuse.coreRequest('installTreeSitterGrammar', { language });
  };

  const getActiveReviewSession = async (): Promise<ReviewSession | null> => {
    return window.diffuse.coreRequest('getActiveReviewSession');
  };

  const getReviewConfig = async (): Promise<ReviewConfig> => {
    return window.diffuse.coreRequest('getReviewConfig');
  };

  const saveReviewConfig = async (config: ReviewConfig): Promise<ReviewConfig> => {
    return window.diffuse.coreRequest('saveReviewConfig', { config: plainJson(config) });
  };

  const createReviewSession = async (session: ReviewSession): Promise<ReviewSession> => {
    return window.diffuse.coreRequest('createReviewSession', { session: plainJson(session) });
  };

  const listReviewSessions = async (): Promise<ReviewSession[]> => {
    return window.diffuse.coreRequest('listReviewSessions');
  };

  const getReviewProgress = async (sessionId: string): Promise<ReviewProgress | null> => {
    return window.diffuse.coreRequest('getReviewProgress', { sessionId });
  };

  const saveReviewProgress = async (sessionId: string, progress: ReviewProgress): Promise<ReviewProgress> => {
    return window.diffuse.coreRequest('saveReviewProgress', { sessionId, progress: plainJson(progress) });
  };

  const getReviewedFiles = async (sessionId: string): Promise<ReviewedFilesState> => {
    return window.diffuse.coreRequest('getReviewedFiles', { sessionId });
  };

  const saveReviewedFiles = async (sessionId: string, reviewedFiles: ReviewedFilesState): Promise<ReviewedFilesState> => {
    return window.diffuse.coreRequest('saveReviewedFiles', { sessionId, reviewedFiles: plainJson(reviewedFiles) });
  };

  const updateReviewedFiles = async (sessionId: string, update: ReviewedFilesUpdate): Promise<ReviewedFilesState> => {
    return window.diffuse.coreRequest('updateReviewedFiles', { sessionId, update: plainJson(update) });
  };

  const saveReviewAgentState = async (sessionId: string, agent: ReviewAgentState): Promise<ReviewAgentState> => {
    return window.diffuse.coreRequest('saveReviewAgentState', { sessionId, agent: plainJson(agent) });
  };

  const getReviewAgentStates = async (sessionId: string): Promise<ReviewAgentState[]> => {
    return window.diffuse.coreRequest('getReviewAgentStates', { sessionId });
  };

  const getReviewRuns = async (sessionId: string): Promise<ReviewRun[]> => {
    return window.diffuse.coreRequest('getReviewRuns', { sessionId });
  };

  const recoverStaleReviewRuns = async (sessionId: string): Promise<{ recovered: number }> => {
    return window.diffuse.coreRequest('recoverStaleReviewRuns', { sessionId });
  };

  const saveReviewRun = async (sessionId: string, run: ReviewRun): Promise<ReviewRun> => {
    return window.diffuse.coreRequest('saveReviewRun', { sessionId, run: plainJson(run) });
  };

  const getReviewThreads = async (sessionId: string): Promise<ReviewThread[]> => {
    return window.diffuse.coreRequest('getReviewThreads', { sessionId });
  };

  const saveReviewThread = async (sessionId: string, thread: ReviewThread): Promise<ReviewThread> => {
    return window.diffuse.coreRequest('saveReviewThread', { sessionId, thread: plainJson(thread) });
  };

  const getReviewChatMessages = async (sessionId: string): Promise<ReviewChatMessage[]> => {
    return window.diffuse.coreRequest('getReviewChatMessages', { sessionId });
  };

  const saveReviewChatMessage = async (sessionId: string, message: ReviewChatMessage): Promise<ReviewChatMessage> => {
    return window.diffuse.coreRequest('saveReviewChatMessage', { sessionId, message: plainJson(message) });
  };

  const addReviewComment = async (sessionId: string, comment: ReviewThread): Promise<ReviewThread> => {
    return window.diffuse.coreRequest('addReviewComment', { sessionId, comment: plainJson(comment) });
  };

  const startReviewAgent = async (repositoryRoot: string, sessionId: string, files: ChangedFile[]): Promise<void> => {
    await window.diffuse.startReviewAgent({ repositoryRoot, sessionId, files: plainJson(files) });
  };

  const stopReviewAgent = async (): Promise<void> => {
    await window.diffuse.stopReviewAgent();
  };

  const chatWithReviewAgent = async (
    repositoryRoot: string,
    sessionId: string,
    thread: ReviewThread,
    question: string,
    chatMessages: ReviewChatMessage[],
    userMessageId?: string,
    responseMessageId?: string,
  ): Promise<ReviewChatMessage> => {
    return window.diffuse.chatWithReviewAgent({
      repositoryRoot,
      sessionId,
      thread: plainJson(thread),
      question,
      userMessageId,
      responseMessageId,
      chatMessages: plainJson(chatMessages),
    });
  };

  const listTreeSitterGrammars = async (): Promise<TreeSitterGrammar[]> => {
    return window.diffuse.coreRequest('listTreeSitterGrammars');
  };

  const syncTreeSitterRegistry = async (gitUrl?: string): Promise<SyncTreeSitterRegistryResult> => {
    return window.diffuse.coreRequest('syncTreeSitterRegistry', { gitUrl });
  };

  const uninstallTreeSitterGrammar = async (language: string): Promise<UninstallTreeSitterGrammarResult> => {
    return window.diffuse.coreRequest('uninstallTreeSitterGrammar', { language });
  };

  return {
    pickRepository,
    getVersion,
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
  };
};
