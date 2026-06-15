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
  oldPath: string | null;
  newPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
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
};

export type DiffRenderModel = {
  fileId: string;
  mode: DiffViewMode;
  context: DiffContextMode;
  syntax: SyntaxStatus;
  rows: DiffRow[];
};

export type SyntaxStatus = {
  language?: string;
  grammarInstalled: boolean;
  grammarPath?: string;
  highlightsQueryPath?: string;
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
  message?: string;
};

export type UninstallTreeSitterGrammarResult = {
  language: string;
  uninstalled: boolean;
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
};

export type DiffRow = {
  kind: 'context' | 'added' | 'deleted' | 'hunk';
  oldLine?: number;
  newLine?: number;
  oldText?: string;
  newText?: string;
  text?: string;
  hunkHeader?: string;
  oldSyntaxSpans?: SyntaxSpan[];
  newSyntaxSpans?: SyntaxSpan[];
};
