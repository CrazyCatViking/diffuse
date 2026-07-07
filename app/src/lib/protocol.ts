export type VersionInfo = {
  name: string;
  version: string;
};

export type OpenRepositoryResult = {
  root: string;
  head: string;
};

export type ChangedFile = {
  id: string;
  oldPath?: string;
  newPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  signature: string;
};

export type DiffTarget = {
  base?: string;
  compare?: string;
  includeStaged: boolean;
  includeUnstaged: boolean;
};

export type DiffTargetDefaults = DiffTarget & {
  dirty: boolean;
  upstream?: string;
};

export type BranchInfo = {
  name: string;
  current: boolean;
};

export type DiffViewMode = 'split' | 'inline';

export type DiffContextMode = 'diff' | 'full';

export type DiffRenderOptions = {
  mode: DiffViewMode;
  context: DiffContextMode;
  intelligence?: 'basic' | 'full';
};

export type DiffRenderModel = {
  fileId: string;
  mode: DiffViewMode;
  context: DiffContextMode;
  syntax: SyntaxStatus;
  rows: DiffRow[];
  annotations?: DiffAnnotations;
};

export type DiffAnalysisStatusKind = 'missing' | 'queued' | 'analyzing' | 'ready' | 'stale' | 'failed' | 'skipped' | string;

export type DiffAnalysisStatus = {
  fileId: string;
  signature: string;
  status: DiffAnalysisStatusKind;
  updatedAtMs: number;
  message?: string;
};

export type DiffAnalysisSummary = {
  tokenChanges: number;
  changeGroups: number;
  movedBlocks: number;
  semanticGroups: number;
  crossFileLinks: number;
  formatterOnlyGroups: number;
  highImpactGroups: number;
};

export type DiffAnalysis = {
  version: number;
  fileId: string;
  signature: string;
  targetKey: string;
  generatedAtMs: number;
  summary: DiffAnalysisSummary;
  annotations: DiffAnnotations;
  rows: DiffAnalysisRow[];
};

export type DiffAnalysisRow = {
  kind: DiffRow['kind'];
  oldLine?: number;
  newLine?: number;
  oldDiffSpans?: DiffTokenSpan[];
  newDiffSpans?: DiffTokenSpan[];
  changeGroupId?: string;
  changeRole?: string;
  changeConfidence?: number;
  symbol?: string;
  semanticSummary?: string;
};

export type DiffAnnotations = {
  columnUnit: 'utf16' | string;
  linePairs: DiffLinePair[];
  changeGroups: DiffChangeGroup[];
  anchorRemaps?: DiffAnchorRemap[];
};

export type DiffLinePair = {
  oldLine: number;
  newLine: number;
  oldRow: number;
  newRow: number;
  kind: 'replacement' | string;
  confidence: number;
};

export type DiffChangeGroup = {
  id: string;
  kind:
    | 'moved-block'
    | 'moved-and-edited-block'
    | 'symbol-change'
    | 'identifier-rename'
    | 'formatter-only'
    | 'import-reorder'
    | 'wrapper-added'
    | 'argument-change'
    | 'extracted-function'
    | 'inlined-function'
    | 'call-site-update'
    | 'condition-change'
    | 'condition-inverted'
    | 'control-flow-change'
    | 'return-value-change'
    | 'assignment-change'
    | 'cross-file-move'
    | string;
  oldStartLine?: number;
  oldEndLine?: number;
  newStartLine?: number;
  newEndLine?: number;
  confidence: number;
  symbol?: string;
  summary?: string;
  relatedFile?: string;
  oldName?: string;
  newName?: string;
};

export type DiffAnchorRemap = {
  oldLine: number;
  newLine: number;
  oldRow?: number;
  newRow?: number;
  kind: string;
  confidence: number;
  summary?: string;
  relatedFile?: string;
};

export type DiffTokenSpanKind = 'inserted-token' | 'deleted-token' | 'replaced-token' | 'whitespace' | string;

export type DiffTokenSpan = {
  startColumn: number;
  endColumn: number;
  kind: DiffTokenSpanKind;
};

export type SyntaxStatus = {
  language?: string;
  grammarInstalled: boolean;
  grammarPath?: string;
  highlightsQueryPath?: string;
  highlightsInstalled: boolean;
  missingReason?: string;
};

export type SyntaxSpan = {
  startColumn: number;
  endColumn: number;
  scope: string;
};

export type SyntaxSide = 'old' | 'new';

export type SyntaxLineSpans = {
  line: number;
  spans: SyntaxSpan[];
};

export type LspStatus = {
  language?: string;
  serverId?: string;
  command?: string;
  configured: boolean;
  installed: boolean;
  starting?: boolean;
  running?: boolean;
  configSource?: string;
  lastError?: string;
  message?: string;
};

export type LspHover = {
  status: 'ok' | 'language-unknown' | 'server-not-configured' | 'server-not-installed' | 'hover-unavailable' | 'request-failed' | string;
  language?: string;
  serverId?: string;
  contents?: string;
  message?: string;
};

export type LspDiagnostic = {
  line: number;
  startColumn: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info' | 'hint' | string;
  message: string;
  source?: string;
  code?: string;
};

export type LspDiagnostics = {
  status: 'ok' | 'language-unknown' | 'server-not-configured' | 'server-not-installed' | 'request-failed' | string;
  language?: string;
  serverId?: string;
  diagnostics: LspDiagnostic[];
  message?: string;
};

export type LspConfigInfo = {
  configPath?: string;
  servers: LspServerInfo[];
};

export type LspServerInfo = {
  language: string;
  serverId: string;
  command: string;
  args: string[];
  configSource: string;
  installed: boolean;
  starting?: boolean;
  running?: boolean;
  lastError?: string;
  install?: LspInstallInfo;
};

export type LspInstallInfo = {
  manager: string;
  command: string;
  args: string[];
  description: string;
  requiresShell: boolean;
  safeToRun: boolean;
  note?: string;
};

export type InstallLspServerResult = {
  serverId: string;
  command: string;
  installed: boolean;
  message?: string;
};

export type RestartLspServerResult = {
  serverId: string;
  restarted: boolean;
  message?: string;
};

export type ReviewSide = 'old' | 'new';

export type ReviewParticipant = {
  id: string;
  kind: 'human' | 'ai';
  displayName: string;
  agent?: {
    provider?: string;
    model?: string;
    harnessId?: string;
    runId?: string;
    transcriptPath?: string;
  };
};

export type ReviewSession = {
  id: string;
  repositoryRoot: string;
  target: DiffTarget;
  headAtCreation: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  status: 'active' | 'closed';
  participants: ReviewParticipant[];
};

export type ReviewProgress = {
  status: 'idle' | 'planning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  totalFiles?: number;
  reviewedFiles?: number;
  activeFiles?: string[];
  pendingFiles?: string[];
  completedFiles?: string[];
  message?: string;
  lastActivityAt?: string;
};

export type ReviewedFile = {
  fileId: string;
  reviewedAt: string;
  reviewedBy: string;
  signature: string;
};

export type ReviewedFilesState = {
  files: Record<string, ReviewedFile>;
};

export type ReviewedFilesUpdate = {
  files?: Record<string, ReviewedFile>;
  removeFileIds?: string[];
};

export type ReviewConfig = {
  provider: 'opencode' | string;
  model?: string;
  agent?: string;
  maxParallelAgents: number;
  promptInstructions: string;
};

export type ReviewAgentState = {
  id: string;
  provider: string;
  status: 'starting' | 'running' | 'idle' | 'completed' | 'failed' | 'cancelled';
  currentPhase?: string;
  currentFile?: string;
  lastThoughtSummary?: string;
  reviewedFiles?: string[];
  startedAt?: string;
  updatedAt?: string;
};

export type ReviewRun = {
  id: string;
  sessionId: string;
  provider: string;
  status: 'starting' | 'planning' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  currentPhase?: string;
  message?: string;
  opencodeSessionId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ReviewChatMessage = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  body: string;
  createdAt: string;
  provider?: string;
  runId?: string;
  context?: {
    fileId?: string;
    selection?: ReviewAnchor;
    threadIds?: string[];
  };
};

export type ReviewAnchor = {
  side: ReviewSide;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  selectedText?: string;
  hunkHeader?: string;
  lineText?: string;
  diffTargetFingerprint: string;
};

export type ReviewMessage = {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
};

export type ReviewThread = {
  id: string;
  sessionId: string;
  fileId: string;
  oldPath?: string;
  newPath?: string;
  anchor: ReviewAnchor;
  status: 'open' | 'resolved';
  severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  category?: 'bug' | 'security' | 'performance' | 'maintainability' | 'test' | 'style' | 'question';
  confidence?: 'low' | 'medium' | 'high';
  source?: {
    kind: 'human' | 'agent';
    provider?: string;
    agentRunId?: string;
  };
  createdAt: string;
  updatedAt: string;
  messages: ReviewMessage[];
};

export type InstallTreeSitterGrammarResult = {
  language: string;
  installed: boolean;
  grammarPath?: string;
  highlightsQueryPath?: string;
  highlightsInstalled: boolean;
  message?: string;
};

export type UninstallTreeSitterGrammarResult = {
  language: string;
  uninstalled: boolean;
  message?: string;
};

export type SyncTreeSitterRegistryResult = {
  path: string;
  synced: boolean;
  message?: string;
};

export type TreeSitterGrammar = {
  id: string;
  url?: string;
  revision?: string;
  requires: string[];
  installed: boolean;
  grammarPath?: string;
  highlightsQueryPath?: string;
  highlightsInstalled: boolean;
};

export type DiffRow = {
  kind: 'context' | 'added' | 'deleted' | 'modified' | 'hunk';
  oldLine?: number;
  newLine?: number;
  oldText?: string;
  newText?: string;
  text?: string;
  hunkHeader?: string;
  oldSyntaxSpans?: SyntaxSpan[];
  newSyntaxSpans?: SyntaxSpan[];
  oldDiffSpans?: DiffTokenSpan[];
  newDiffSpans?: DiffTokenSpan[];
  changeGroupId?: string;
  changeRole?: 'moved-from' | 'moved-to' | string;
  changeConfidence?: number;
  symbol?: string;
  semanticSummary?: string;
};
