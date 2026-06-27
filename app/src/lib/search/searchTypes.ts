import type { ChangedFile, ReviewAnchor, ReviewThread, SyntaxSide } from '../protocol';

export type SearchMode = 'all' | 'files' | 'content' | 'symbols' | 'comments';

export type SearchFilterKind = 'unviewed' | 'viewed' | 'commented' | 'unresolved' | 'generated' | 'test' | 'docs' | 'renamed' | 'deleted';

export type SearchFilterDefinition = {
  kind: SearchFilterKind;
  label: string;
  token: string;
  description: string;
};

export const searchFilterDefinitions: SearchFilterDefinition[] = [
  { kind: 'unviewed', label: 'Unviewed', token: 'is:unviewed', description: 'Files not marked reviewed' },
  { kind: 'viewed', label: 'Viewed', token: 'is:viewed', description: 'Files already marked reviewed' },
  { kind: 'commented', label: 'Comments', token: 'is:commented', description: 'Files with review threads' },
  { kind: 'unresolved', label: 'Unresolved', token: 'is:unresolved', description: 'Files with open review threads' },
  { kind: 'generated', label: 'Generated', token: 'is:generated', description: 'Generated, lock, vendor, or build output files' },
  { kind: 'test', label: 'Tests', token: 'is:test', description: 'Test files and test folders' },
  { kind: 'docs', label: 'Docs', token: 'is:doc', description: 'Documentation files' },
  { kind: 'renamed', label: 'Renamed', token: 'status:renamed', description: 'Renamed files' },
  { kind: 'deleted', label: 'Deleted', token: 'status:deleted', description: 'Deleted files' },
];

export type SearchMatchRange = {
  start: number;
  end: number;
};

export type SearchFieldMatch = {
  field: 'name' | 'path' | 'body' | 'symbol';
  ranges: SearchMatchRange[];
  score: number;
};

export type ParsedSearchFilter = {
  key: string;
  value: string;
  negated: boolean;
};

export type ParsedSearchQuery = {
  raw: string;
  terms: string[];
  phrases: string[];
  filters: ParsedSearchFilter[];
};

export type FileSearchMetadata = {
  reviewed: boolean;
  commentCount: number;
  unresolvedCount: number;
  generated: boolean;
  test: boolean;
  docs: boolean;
};

export type SearchableFile = {
  file: ChangedFile;
  path: string;
  name: string;
  extension: string;
  metadata: FileSearchMetadata;
  searchText: string;
  commentText: string;
};

export type SearchResultBase = {
  id: string;
  kind: 'file' | 'comment' | 'content' | 'symbol' | 'action';
  fileId?: string;
  path?: string;
  title: string;
  subtitle?: string;
  rank: number;
  matches: SearchFieldMatch[];
};

export type FileSearchResult = SearchResultBase & {
  kind: 'file';
  fileId: string;
  path: string;
  name: string;
  file: ChangedFile;
  metadata: FileSearchMetadata;
};

export type CommentSearchResult = SearchResultBase & {
  kind: 'comment';
  fileId: string;
  path: string;
  threadId: string;
  status: 'open' | 'resolved';
  anchor: ReviewAnchor;
  thread: ReviewThread;
  body: string;
};

export type ContentSearchResult = SearchResultBase & {
  kind: 'content';
  fileId: string;
  path: string;
  line: number;
  side: SyntaxSide;
  preview: string;
};

export type SymbolSearchResult = SearchResultBase & {
  kind: 'symbol';
  fileId: string;
  path: string;
  side: SyntaxSide;
  line: number;
  symbolName: string;
  symbolKind: string;
  containerName?: string;
};

export type SearchResult = FileSearchResult | CommentSearchResult | ContentSearchResult | SymbolSearchResult;

export type SearchResultGroup = {
  id: string;
  label: string;
  results: SearchResult[];
};
