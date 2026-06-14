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

export type InstallTreeSitterGrammarResult = {
  language: string;
  installed: boolean;
  grammarPath?: string;
  highlightsQueryPath?: string;
  message?: string;
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
