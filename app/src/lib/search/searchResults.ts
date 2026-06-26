import type { ReviewThread } from '../protocol';
import { fieldMatch, matchText, normalizeSearchText } from './searchMatch';
import { threadSearchText } from './searchMetadata';
import type {
  CommentSearchResult,
  ContentSearchResult,
  FileSearchResult,
  ParsedSearchFilter,
  ParsedSearchQuery,
  SearchFilterKind,
  SearchResult,
  SearchResultGroup,
  SearchableFile,
} from './searchTypes';

type BuildResultsOptions = {
  files: SearchableFile[];
  threads: ReviewThread[];
  query: ParsedSearchQuery;
  activeFilters: SearchFilterKind[];
};

export const buildSearchResults = ({ files, threads, query, activeFilters }: BuildResultsOptions): SearchResult[] => {
  const fileResults = buildFileResults(files, query, activeFilters);
  const commentResults = buildCommentResults(files, threads, query, activeFilters);
  return [...fileResults, ...commentResults].sort((first, second) => second.rank - first.rank || first.title.localeCompare(second.title));
};

export const groupSearchResults = (results: SearchResult[]): SearchResultGroup[] => {
  const files = results.filter((result): result is FileSearchResult => result.kind === 'file');
  const content = results.filter((result): result is ContentSearchResult => result.kind === 'content');
  const comments = results.filter((result): result is CommentSearchResult => result.kind === 'comment');
  const groups: SearchResultGroup[] = [];
  if (files.length > 0) groups.push({ id: 'files', label: 'File names and paths', results: files });
  if (content.length > 0) groups.push({ id: 'content', label: 'File contents', results: content });
  if (comments.length > 0) groups.push({ id: 'comments', label: 'Comments', results: comments });
  return groups;
};

const buildFileResults = (files: SearchableFile[], query: ParsedSearchQuery, activeFilters: SearchFilterKind[]): FileSearchResult[] => {
  const terms = [...query.terms, ...query.phrases];
  const hasText = terms.length > 0;

  return files
    .map((file): FileSearchResult | null => {
      if (!searchableFilePassesFilters(file, query.filters, activeFilters)) return null;

      const nameMatch = fieldMatch('name', file.name, terms, 500);
      const pathMatch = fieldMatch('path', file.path, terms, 160);
      const matches = [nameMatch, pathMatch].filter((match) => match !== null);
      if (hasText && matches.length === 0) return null;

      const metadataBoost = file.metadata.unresolvedCount > 0 ? 140 : file.metadata.commentCount > 0 ? 80 : 0;
      const reviewBoost = file.metadata.reviewed ? 0 : 45;
      const generatedPenalty = file.metadata.generated && !hasGeneratedFilter(query.filters, activeFilters) ? 260 : 0;
      const rank = matches.reduce((total, match) => total + match.score, 0) + metadataBoost + reviewBoost - generatedPenalty;

      return {
        id: `file:${file.file.id}`,
        kind: 'file',
        fileId: file.file.id,
        path: file.path,
        name: file.name,
        title: file.name,
        subtitle: file.path,
        rank,
        matches,
        file: file.file,
        metadata: file.metadata,
      };
    })
    .filter((result) => result !== null);
};

const buildCommentResults = (
  files: SearchableFile[],
  threads: ReviewThread[],
  query: ParsedSearchQuery,
  activeFilters: SearchFilterKind[],
): CommentSearchResult[] => {
  const terms = [
    ...query.terms,
    ...query.phrases,
    ...query.filters.filter((filter) => filter.key === 'comment').map((filter) => filter.value),
  ];
  if (terms.length === 0 && !activeFilters.includes('commented') && !activeFilters.includes('unresolved')) return [];

  const filesById = new Map(files.map((file) => [file.file.id, file]));
  return threads
    .map((thread): CommentSearchResult | null => {
      const file = filesById.get(thread.fileId);
      if (!file) return null;
      if (
        !searchableFilePassesFilters(
          file,
          query.filters.filter((filter) => filter.key !== 'comment'),
          activeFilters,
        )
      )
        return null;

      const body = threadSearchText(thread);
      const bodyMatch = fieldMatch('body', body, terms, 320);
      const pathMatch = fieldMatch('path', file.path, terms, 100);
      const matches = [bodyMatch, pathMatch].filter((match) => match !== null);
      if (terms.length > 0 && matches.length === 0) return null;

      return {
        id: `comment:${thread.id}`,
        kind: 'comment',
        fileId: thread.fileId,
        path: file.path,
        title: file.name,
        subtitle: body || `${thread.anchor.side} line ${thread.anchor.startLine}`,
        rank: matches.reduce((total, match) => total + match.score, 0) + (thread.status === 'open' ? 220 : 80),
        matches,
        thread,
        body,
      };
    })
    .filter((result) => result !== null);
};

export const searchableFilePassesFilters = (
  file: SearchableFile,
  queryFilters: ParsedSearchFilter[],
  activeFilters: SearchFilterKind[],
): boolean => {
  for (const filter of activeFilters) {
    if (!filePassesFilterKind(file, filter)) return false;
  }

  for (const filter of queryFilters) {
    const passes = filePassesQueryFilter(file, filter);
    if (filter.negated ? passes : !passes) return false;
  }

  return true;
};

const filePassesFilterKind = (file: SearchableFile, filter: SearchFilterKind): boolean => {
  if (filter === 'unviewed') return !file.metadata.reviewed;
  if (filter === 'viewed') return file.metadata.reviewed;
  if (filter === 'commented') return file.metadata.commentCount > 0;
  if (filter === 'unresolved') return file.metadata.unresolvedCount > 0;
  if (filter === 'generated') return file.metadata.generated;
  if (filter === 'test') return file.metadata.test;
  if (filter === 'docs') return file.metadata.docs;
  if (filter === 'renamed') return file.file.status === 'renamed';
  if (filter === 'deleted') return file.file.status === 'deleted';
  return true;
};

const filePassesQueryFilter = (file: SearchableFile, filter: ParsedSearchFilter): boolean => {
  const value = normalizeSearchText(filter.value);
  if (filter.key === 'is') return filePassesIsFilter(file, value);
  if (filter.key === 'status') return file.file.status === value;
  if (filter.key === 'ext') return file.extension === value.replace(/^\./, '');
  if (filter.key === 'lang') return languageMatchesExtension(value, file.extension);
  if (filter.key === 'path') return normalizeSearchText(file.path).includes(value);
  if (filter.key === 'file') return normalizeSearchText(file.name).includes(value);
  if (filter.key === 'changes') return compareNumber(file.file.additions + file.file.deletions, value);
  if (filter.key === 'added') return compareNumber(file.file.additions, value);
  if (filter.key === 'deleted') return compareNumber(file.file.deletions, value);
  if (filter.key === 'comment') return matchText(file.commentText, [value]).matched;
  return matchText(file.searchText, [filter.value]).matched;
};

const filePassesIsFilter = (file: SearchableFile, value: string): boolean => {
  if (value === 'unviewed' || value === 'unreviewed') return !file.metadata.reviewed;
  if (value === 'viewed' || value === 'reviewed') return file.metadata.reviewed;
  if (value === 'commented' || value === 'comments') return file.metadata.commentCount > 0;
  if (value === 'unresolved') return file.metadata.unresolvedCount > 0;
  if (value === 'generated') return file.metadata.generated;
  if (value === 'test' || value === 'tests') return file.metadata.test;
  if (value === 'doc' || value === 'docs') return file.metadata.docs;
  if (value === 'renamed') return file.file.status === 'renamed';
  if (value === 'deleted') return file.file.status === 'deleted';
  if (value === 'added') return file.file.status === 'added';
  if (value === 'modified') return file.file.status === 'modified';
  return false;
};

const hasGeneratedFilter = (filters: ParsedSearchFilter[], activeFilters: SearchFilterKind[]): boolean => {
  return (
    activeFilters.includes('generated') ||
    filters.some((filter) => filter.key === 'is' && normalizeSearchText(filter.value) === 'generated')
  );
};

const compareNumber = (actual: number, expression: string): boolean => {
  const match = /^(>=|<=|>|<)?(\d+)$/.exec(expression.trim());
  if (!match) return false;
  const operator = match[1] ?? '=';
  const expected = Number(match[2]);
  if (operator === '>') return actual > expected;
  if (operator === '>=') return actual >= expected;
  if (operator === '<') return actual < expected;
  if (operator === '<=') return actual <= expected;
  return actual === expected;
};

const languageMatchesExtension = (language: string, extension: string): boolean => {
  const aliases: Record<string, string[]> = {
    javascript: ['js', 'jsx', 'mjs', 'cjs'],
    typescript: ['ts', 'tsx'],
    vue: ['vue'],
    markdown: ['md', 'markdown'],
    python: ['py'],
    rust: ['rs'],
    go: ['go'],
    zig: ['zig'],
    shell: ['sh', 'bash', 'zsh'],
  };
  return aliases[language]?.includes(extension) ?? extension === language;
};
