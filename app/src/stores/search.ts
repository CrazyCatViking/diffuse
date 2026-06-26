import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { useClient } from '../lib/useClient';
import { useDiffStore } from './diff';
import { useRepoStore } from './repo';
import { useReviewStore } from './review';
import { buildSearchableFiles } from '../lib/search/searchMetadata';
import { parseSearchQuery } from '../lib/search/searchQueryParser';
import { buildSearchResults, groupSearchResults, searchableFilePassesFilters } from '../lib/search/searchResults';
import type {
  ContentSearchResult,
  SearchFilterKind,
  SearchMatchRange,
  SearchMode,
  SearchResult,
  SearchableFile,
} from '../lib/search/searchTypes';
import type { DiffRenderModel, SyntaxSide } from '../lib/protocol';

const searchHistoryStorageKey = 'diffuse.search.history';
const maxSearchHistory = 20;
const contentSearchDelayMs = 180;
const minContentSearchLength = 2;
const maxConcurrentContentRequests = 3;

type ContentSearchLine = {
  side: SyntaxSide;
  line: number;
  text: string;
};

export const useSearchStore = defineStore('search', () => {
  const client = useClient();
  const repo = useRepoStore();
  const diff = useDiffStore();
  const review = useReviewStore();
  const query = ref('');
  const treeQuery = ref('');
  const mode = ref<SearchMode>('all');
  const overlayOpen = ref(false);
  const drawerOpen = ref(false);
  const selectedIndex = ref(0);
  const activeFilters = ref<SearchFilterKind[]>([]);
  const treeActiveFilters = ref<SearchFilterKind[]>([]);
  const pinnedRemovedResultIds = ref<string[]>([]);
  const history = ref(loadHistory());
  const contentResults = ref<ContentSearchResult[]>([]);
  const contentSearchLoading = ref(false);
  const contentLineCache = new Map<string, ContentSearchLine[]>();
  let contentSearchTimer: number | undefined;
  let contentSearchGeneration = 0;

  const reviewedFileIds = computed(() => repo.changedFiles.filter((file) => review.isFileReviewed(file)).map((file) => file.id));
  const searchableFiles = computed(() => buildSearchableFiles(repo.changedFiles, reviewedFileIds.value, review.threads));
  const parsedQuery = computed(() => parseSearchQuery(query.value));
  const treeParsedQuery = computed(() => parseSearchQuery(treeQuery.value));
  const hasActiveSearch = computed(() => query.value.trim().length > 0 || activeFilters.value.length > 0);
  const treeHasActiveSearch = computed(() => treeQuery.value.trim().length > 0 || treeActiveFilters.value.length > 0);
  const contentSearchTerms = computed(() => [...parsedQuery.value.terms, ...parsedQuery.value.phrases].filter(Boolean));
  const contentScopeKey = computed(() =>
    JSON.stringify({
      target: repo.diffTarget,
      context: diff.contextMode,
      files: repo.changedFiles.map((file) => `${file.id}:${file.signature}`).join('\n'),
    }),
  );
  const baseResults = computed(() => {
    if (!hasActiveSearch.value) return [];
    return buildSearchResults({
      files: searchableFiles.value,
      threads: review.threads,
      query: parsedQuery.value,
      activeFilters: activeFilters.value,
    });
  });
  const allResults = computed<SearchResult[]>(() => {
    if (!hasActiveSearch.value) return [];
    return [...baseResults.value, ...contentResults.value];
  });
  const treeResults = computed(() => {
    if (!treeHasActiveSearch.value) return [];
    return buildSearchResults({
      files: searchableFiles.value,
      threads: review.threads,
      query: treeParsedQuery.value,
      activeFilters: treeActiveFilters.value,
    });
  });
  const results = computed<SearchResult[]>(() => {
    if (mode.value === 'comments') return baseResults.value.filter((result) => result.kind === 'comment');
    if (mode.value === 'files') return baseResults.value.filter((result) => result.kind === 'file');
    if (mode.value === 'content') return contentResults.value;
    if (mode.value === 'symbols') return [];
    return groupSearchResults(allResults.value).flatMap((group) => group.results);
  });
  const groups = computed(() => groupSearchResults(results.value));
  const selectedResult = computed<SearchResult | undefined>(() => results.value[selectedIndex.value]);
  const pinnedRemovedResultIdSet = computed(() => new Set(pinnedRemovedResultIds.value));
  const pinnedResultEntries = computed(() => {
    return results.value
      .map((result, index) => ({ result, index }))
      .filter((entry) => !pinnedRemovedResultIdSet.value.has(entry.result.id));
  });
  const pinnedResults = computed(() => pinnedResultEntries.value.map((entry) => entry.result));
  const pinnedSelectedResult = computed(() => {
    const selected = selectedResult.value;
    if (selected && !pinnedRemovedResultIdSet.value.has(selected.id)) return selected;
    return pinnedResultEntries.value[0]?.result;
  });
  const pinnedSelectedPosition = computed(() => {
    const index = pinnedResultEntries.value.findIndex((entry) => entry.index === selectedIndex.value);
    return index >= 0 ? index : 0;
  });

  const setQuery = (value: string) => {
    query.value = value;
    selectedIndex.value = 0;
    pinnedRemovedResultIds.value = [];
  };

  const setTreeQuery = (value: string) => {
    treeQuery.value = value;
  };

  const setMode = (value: SearchMode) => {
    mode.value = value;
    selectedIndex.value = 0;
  };

  const openOverlay = (nextMode: SearchMode = 'all') => {
    mode.value = nextMode;
    overlayOpen.value = true;
    selectedIndex.value = Math.min(selectedIndex.value, Math.max(0, results.value.length - 1));
  };

  const closeOverlay = () => {
    overlayOpen.value = false;
    rememberQuery();
  };

  const openDrawer = () => {
    drawerOpen.value = true;
    rememberQuery();
  };

  const closeDrawer = () => {
    drawerOpen.value = false;
  };

  const pinResults = () => {
    pinnedRemovedResultIds.value = [];
    drawerOpen.value = true;
    overlayOpen.value = false;
    rememberQuery();
  };

  const pinTreeResults = () => {
    query.value = treeQuery.value;
    activeFilters.value = [...treeActiveFilters.value];
    selectedIndex.value = 0;
    pinnedRemovedResultIds.value = [];
    drawerOpen.value = true;
    overlayOpen.value = false;
    rememberQuery();
  };

  const clearQuery = () => {
    query.value = '';
    activeFilters.value = [];
    selectedIndex.value = 0;
  };

  const clearTreeQuery = () => {
    treeQuery.value = '';
    treeActiveFilters.value = [];
  };

  const toggleFilter = (filter: SearchFilterKind) => {
    activeFilters.value = activeFilters.value.includes(filter)
      ? activeFilters.value.filter((item) => item !== filter)
      : [...activeFilters.value, filter];
    selectedIndex.value = 0;
  };

  const toggleTreeFilter = (filter: SearchFilterKind) => {
    treeActiveFilters.value = treeActiveFilters.value.includes(filter)
      ? treeActiveFilters.value.filter((item) => item !== filter)
      : [...treeActiveFilters.value, filter];
  };

  const nextResult = () => {
    if (results.value.length === 0) return;
    selectedIndex.value = (selectedIndex.value + 1) % results.value.length;
  };

  const previousResult = () => {
    if (results.value.length === 0) return;
    selectedIndex.value = (selectedIndex.value - 1 + results.value.length) % results.value.length;
  };

  const selectResult = (index: number) => {
    selectedIndex.value = Math.min(Math.max(index, 0), Math.max(0, results.value.length - 1));
  };

  const nextPinnedResult = () => {
    const entries = pinnedResultEntries.value;
    if (entries.length === 0) return;

    const currentPosition = entries.findIndex((entry) => entry.index === selectedIndex.value);
    selectedIndex.value = entries[(currentPosition + 1) % entries.length]?.index ?? entries[0].index;
  };

  const previousPinnedResult = () => {
    const entries = pinnedResultEntries.value;
    if (entries.length === 0) return;

    const currentPosition = entries.findIndex((entry) => entry.index === selectedIndex.value);
    const nextPosition = currentPosition === -1 ? entries.length - 1 : (currentPosition - 1 + entries.length) % entries.length;
    selectedIndex.value = entries[nextPosition]?.index ?? entries[0].index;
  };

  const removePinnedResult = (resultId: string) => {
    if (pinnedRemovedResultIdSet.value.has(resultId)) return;

    const nextRemovedResultIds = [...pinnedRemovedResultIds.value, resultId];
    pinnedRemovedResultIds.value = nextRemovedResultIds;
    if (selectedResult.value?.id !== resultId) return;

    const removed = new Set(nextRemovedResultIds);
    const nextEntry = results.value
      .map((result, index) => ({ result, index }))
      .filter((entry) => !removed.has(entry.result.id))
      .find((entry) => entry.index >= selectedIndex.value);
    const fallbackEntry = results.value
      .map((result, index) => ({ result, index }))
      .filter((entry) => !removed.has(entry.result.id))
      .at(-1);
    selectedIndex.value = nextEntry?.index ?? fallbackEntry?.index ?? 0;
  };

  const rememberQuery = () => {
    const value = query.value.trim();
    if (!value) return;
    history.value = [value, ...history.value.filter((item) => item !== value)].slice(0, maxSearchHistory);
    window.localStorage.setItem(searchHistoryStorageKey, JSON.stringify(history.value));
  };

  const scheduleContentSearch = () => {
    if (contentSearchTimer !== undefined) window.clearTimeout(contentSearchTimer);

    if (!shouldSearchContent()) {
      contentSearchGeneration += 1;
      contentResults.value = [];
      contentSearchLoading.value = false;
      return;
    }

    contentSearchLoading.value = true;
    contentResults.value = [];
    contentSearchTimer = window.setTimeout(() => {
      contentSearchTimer = undefined;
      void refreshContentResults();
    }, contentSearchDelayMs);
  };

  const shouldSearchContent = () => {
    if (mode.value !== 'all' && mode.value !== 'content') return false;
    const raw = query.value.trim();
    if (raw.length < minContentSearchLength) return false;
    return contentSearchTerms.value.length > 0;
  };

  const refreshContentResults = async () => {
    const generation = ++contentSearchGeneration;
    const terms = contentSearchTerms.value;
    const files = searchableFiles.value.filter((file) => searchableFilePassesFilters(file, parsedQuery.value.filters, activeFilters.value));
    const nextResults: ContentSearchResult[] = [];
    let fileIndex = 0;

    const runWorker = async () => {
      while (fileIndex < files.length && generation === contentSearchGeneration) {
        const file = files[fileIndex];
        fileIndex += 1;
        const matches = await contentResultsForFile(file, terms);
        nextResults.push(...matches);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(maxConcurrentContentRequests, files.length) }, runWorker));
      if (generation !== contentSearchGeneration) return;

      contentResults.value = sortContentResults(nextResults);
    } finally {
      if (generation === contentSearchGeneration) contentSearchLoading.value = false;
    }
  };

  const contentResultsForFile = async (file: SearchableFile, terms: string[]): Promise<ContentSearchResult[]> => {
    const lines = await contentLinesForFile(file);
    const results: ContentSearchResult[] = [];

    for (const line of lines) {
      const match = matchContentLine(line.text, terms);
      if (!match) continue;

      const preview = contentPreview(line.text, match.ranges);
      results.push({
        id: `content:${file.file.id}:${line.side}:${line.line}:${results.length}`,
        kind: 'content',
        fileId: file.file.id,
        path: file.path,
        line: line.line,
        side: line.side,
        title: file.name,
        subtitle: `${file.path}:${line.line}`,
        rank: match.score + (file.metadata.reviewed ? 0 : 20),
        matches: [{ field: 'body', ranges: preview.ranges, score: match.score }],
        preview: preview.text,
      });
    }

    return results;
  };

  const contentLinesForFile = async (file: SearchableFile): Promise<ContentSearchLine[]> => {
    const cacheKey = `${contentScopeKey.value}:${file.file.id}`;
    const cached = contentLineCache.get(cacheKey);
    if (cached) return cached;

    const model = await client.getDiffRenderModel(file.file.id, { mode: 'inline', context: diff.contextMode }, repo.diffTarget);
    const lines = linesFromDiffModel(model);
    contentLineCache.set(cacheKey, lines);
    return lines;
  };

  const linesFromDiffModel = (model: DiffRenderModel): ContentSearchLine[] => {
    const lines: ContentSearchLine[] = [];
    const seen = new Set<string>();

    for (const row of model.rows) {
      const side = row.newLine ? 'new' : row.oldLine ? 'old' : undefined;
      const line = side === 'new' ? row.newLine : row.oldLine;
      const text = side === 'new' ? row.newText : row.oldText;
      if (!side || !line || text === undefined) continue;

      const key = `${side}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ side, line, text });
    }

    return lines;
  };

  watch(contentScopeKey, () => {
    contentLineCache.clear();
    scheduleContentSearch();
  });

  watch([() => query.value, () => mode.value, () => activeFilters.value], scheduleContentSearch);

  return {
    query,
    treeQuery,
    mode,
    overlayOpen,
    drawerOpen,
    selectedIndex,
    activeFilters,
    treeActiveFilters,
    history,
    searchableFiles,
    parsedQuery,
    results,
    treeResults,
    groups,
    selectedResult,
    pinnedResultEntries,
    pinnedResults,
    pinnedSelectedResult,
    pinnedSelectedPosition,
    hasActiveSearch,
    treeHasActiveSearch,
    contentSearchLoading,
    setQuery,
    setTreeQuery,
    setMode,
    openOverlay,
    closeOverlay,
    openDrawer,
    closeDrawer,
    pinResults,
    pinTreeResults,
    clearQuery,
    clearTreeQuery,
    toggleFilter,
    toggleTreeFilter,
    nextResult,
    previousResult,
    selectResult,
    nextPinnedResult,
    previousPinnedResult,
    removePinnedResult,
    rememberQuery,
  };
});

const matchContentLine = (text: string, terms: string[]): { score: number; ranges: SearchMatchRange[] } | undefined => {
  const lowerText = text.toLowerCase();
  const ranges: SearchMatchRange[] = [];
  let score = 0;

  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    if (!lowerTerm) continue;

    const termRanges = rangesForTerm(lowerText, lowerTerm);
    if (termRanges.length === 0) return undefined;

    ranges.push(...termRanges);
    score += 1200 - termRanges[0].start + Math.min(termRanges.length, 8) * 30;
  }

  return { score, ranges: mergeRanges(ranges) };
};

const rangesForTerm = (lowerText: string, lowerTerm: string): SearchMatchRange[] => {
  const ranges: SearchMatchRange[] = [];
  let searchFrom = 0;

  while (searchFrom < lowerText.length) {
    const index = lowerText.indexOf(lowerTerm, searchFrom);
    if (index === -1) break;
    ranges.push({ start: index, end: index + lowerTerm.length });
    searchFrom = index + lowerTerm.length;
  }

  return ranges;
};

const contentPreview = (text: string, ranges: SearchMatchRange[]): { text: string; ranges: SearchMatchRange[] } => {
  const firstRange = ranges[0];
  const previewLength = 150;
  const prefixLength = 48;
  const start = Math.max(0, (firstRange?.start ?? 0) - prefixLength);
  const end = Math.min(text.length, start + previewLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  const previewText = `${prefix}${text.slice(start, end)}${suffix}`;
  const offset = prefix.length - start;
  const previewRanges = ranges
    .map((range) => ({ start: Math.max(start, range.start), end: Math.min(end, range.end) }))
    .filter((range) => range.end > range.start)
    .map((range) => ({ start: range.start + offset, end: range.end + offset }));

  return { text: previewText, ranges: previewRanges };
};

const sortContentResults = (results: ContentSearchResult[]) => {
  return [...results].sort(
    (first, second) => second.rank - first.rank || first.path.localeCompare(second.path) || first.line - second.line,
  );
};

const mergeRanges = (ranges: SearchMatchRange[]): SearchMatchRange[] => {
  const sorted = [...ranges].sort((first, second) => first.start - second.start || first.end - second.end);
  const merged: SearchMatchRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }

  return merged;
};

const loadHistory = (): string[] => {
  const raw = window.localStorage.getItem(searchHistoryStorageKey);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, maxSearchHistory) : [];
  } catch {
    return [];
  }
};
