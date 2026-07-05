import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { useClient } from '../lib/useClient';
import { useRepoStore } from './repo';
import { useReviewStore } from './review';
import { buildSearchableFiles } from '../lib/search/searchMetadata';
import { parseSearchQuery } from '../lib/search/searchQueryParser';
import { buildSearchResults, groupSearchResults } from '../lib/search/searchResults';
import type { SearchFilterKind, SearchMode, SearchResult } from '../lib/search/searchTypes';

const searchHistoryStorageKey = 'diffuse.search.history';
const maxSearchHistory = 20;
const coreSearchDelayMs = 180;

type SearchProgress = {
  scannedFiles: number;
  totalFiles: number;
  emittedResults: number;
};

export const useSearchStore = defineStore('search', () => {
  const client = useClient();
  const repo = useRepoStore();
  const review = useReviewStore();
  const query = ref('');
  const treeQuery = ref('');
  const mode = ref<SearchMode>('all');
  const overlayOpen = ref(false);
  const drawerOpen = ref(false);
  const selectedIndex = ref(0);
  const pinnedSelectedIndex = ref(0);
  const activeFilters = ref<SearchFilterKind[]>([]);
  const treeActiveFilters = ref<SearchFilterKind[]>([]);
  const pinnedRemovedResultIds = ref<string[]>([]);
  const pinnedSnapshotResults = shallowRef<SearchResult[]>([]);
  const pinnedQuery = ref('');
  const history = ref(loadHistory());
  const coreResults = shallowRef<SearchResult[]>([]);
  const activeSearchId = ref<string>();
  const searchLoading = ref(false);
  const error = ref<string>();
  const searchProgress = ref<SearchProgress>({ scannedFiles: 0, totalFiles: 0, emittedResults: 0 });
  let searchTimer: number | undefined;

  const reviewedFileIds = computed(() => repo.changedFiles.filter((file) => review.isFileReviewed(file)).map((file) => file.id));
  const searchableFiles = computed(() => buildSearchableFiles(repo.changedFiles, reviewedFileIds.value, review.threads));
  const parsedQuery = computed(() => parseSearchQuery(query.value));
  const treeParsedQuery = computed(() => parseSearchQuery(treeQuery.value));
  const hasActiveSearch = computed(() => query.value.trim().length > 0 || activeFilters.value.length > 0);
  const treeHasActiveSearch = computed(() => treeQuery.value.trim().length > 0 || treeActiveFilters.value.length > 0);
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
    if (!hasActiveSearch.value) return [];
    return coreResults.value;
  });
  const groups = computed(() => groupSearchResults(results.value));
  const selectedResult = computed<SearchResult | undefined>(() => results.value[selectedIndex.value]);
  const pinnedRemovedResultIdSet = computed(() => new Set(pinnedRemovedResultIds.value));
  const pinnedResultEntries = computed(() => {
    return pinnedSnapshotResults.value
      .map((result, index) => ({ result, index }))
      .filter((entry) => !pinnedRemovedResultIdSet.value.has(entry.result.id));
  });
  const pinnedResults = computed(() => pinnedResultEntries.value.map((entry) => entry.result));
  const pinnedResultCount = computed(() => pinnedResultEntries.value.length);
  const hasPinnedSnapshot = computed(() => pinnedSnapshotResults.value.length > 0);
  const pinnedSelectedResult = computed(() => {
    const selected = pinnedSnapshotResults.value[pinnedSelectedIndex.value];
    if (selected && !pinnedRemovedResultIdSet.value.has(selected.id)) return selected;
    return pinnedResultEntries.value[0]?.result;
  });
  const contentSearchLoading = computed(() => searchLoading.value);
  const searchScopeKey = computed(() =>
    JSON.stringify({
      repository: repo.repository?.root,
      target: repo.diffTarget,
      files: repo.changedFiles.map((file) => `${file.id}:${file.signature}`).join('\n'),
      sessionId: review.session?.id ?? '',
      reviewedFiles: Object.keys(review.reviewedFiles.files).sort().join('\n'),
      threads: review.threads.map((thread) => `${thread.id}:${thread.updatedAt}:${thread.status}`).join('\n'),
    }),
  );

  window.diffuse.onCoreEvent((event) => {
    if (event.method === 'search/started') {
      if (event.params.searchId === activeSearchId.value) searchLoading.value = true;
      return;
    }

    if (event.method === 'search/results') {
      if (event.params.searchId !== activeSearchId.value) return;
      queueCoreResults(event.params.results);
      return;
    }

    if (event.method === 'search/progress') {
      if (event.params.searchId !== activeSearchId.value) return;
      searchProgress.value = {
        scannedFiles: event.params.scannedFiles,
        totalFiles: event.params.totalFiles,
        emittedResults: event.params.emittedResults,
      };
      return;
    }

    if (event.method === 'search/done') {
      if (event.params.searchId !== activeSearchId.value) return;
      searchLoading.value = false;
      activeSearchId.value = undefined;
      flushCoreResults();
      searchProgress.value = {
        ...searchProgress.value,
        scannedFiles: event.params.scannedFiles,
        emittedResults: event.params.totalResults,
      };
      clampSelectedIndex();
      return;
    }

    if (event.method === 'search/cancelled') {
      if (event.params.searchId !== activeSearchId.value) return;
      searchLoading.value = false;
      activeSearchId.value = undefined;
      return;
    }

    if (event.method === 'search/error') {
      if (event.params.searchId !== activeSearchId.value) return;
      error.value = event.params.message;
      searchLoading.value = false;
      activeSearchId.value = undefined;
    }
  });

  const setQuery = (value: string) => {
    query.value = value;
    selectedIndex.value = 0;
    resetCoreResults();
  };

  const setTreeQuery = (value: string) => {
    treeQuery.value = value;
  };

  const setMode = (value: SearchMode) => {
    mode.value = value;
    selectedIndex.value = 0;
    resetCoreResults();
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
    pinnedSnapshotResults.value = [...results.value];
    pinnedSelectedIndex.value = Math.min(selectedIndex.value, Math.max(0, pinnedSnapshotResults.value.length - 1));
    pinnedQuery.value = query.value.trim();
    pinnedRemovedResultIds.value = [];
    drawerOpen.value = true;
    overlayOpen.value = false;
    rememberQuery();
  };

  const pinTreeResults = () => {
    const snapshot = treeResults.value;
    query.value = treeQuery.value;
    activeFilters.value = [...treeActiveFilters.value];
    selectedIndex.value = 0;
    pinnedSelectedIndex.value = 0;
    pinnedSnapshotResults.value = [...snapshot];
    pinnedQuery.value = treeQuery.value.trim();
    pinnedRemovedResultIds.value = [];
    resetCoreResults();
    drawerOpen.value = true;
    overlayOpen.value = false;
    rememberQuery();
  };

  const clearQuery = () => {
    query.value = '';
    activeFilters.value = [];
    selectedIndex.value = 0;
    resetCoreResults();
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
    resetCoreResults();
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

  const selectPinnedResult = (index: number) => {
    pinnedSelectedIndex.value = Math.min(Math.max(index, 0), Math.max(0, pinnedSnapshotResults.value.length - 1));
  };

  const removePinnedResult = (resultId: string) => {
    if (pinnedRemovedResultIdSet.value.has(resultId)) return;

    const nextRemovedResultIds = [...pinnedRemovedResultIds.value, resultId];
    pinnedRemovedResultIds.value = nextRemovedResultIds;
    if (pinnedSnapshotResults.value[pinnedSelectedIndex.value]?.id !== resultId) return;

    const removed = new Set(nextRemovedResultIds);
    const nextEntry = pinnedSnapshotResults.value
      .map((result, index) => ({ result, index }))
      .filter((entry) => !removed.has(entry.result.id))
      .find((entry) => entry.index >= pinnedSelectedIndex.value);
    const fallbackEntry = pinnedSnapshotResults.value
      .map((result, index) => ({ result, index }))
      .filter((entry) => !removed.has(entry.result.id))
      .at(-1);
    pinnedSelectedIndex.value = nextEntry?.index ?? fallbackEntry?.index ?? 0;
  };

  const rememberQuery = () => {
    const value = query.value.trim();
    if (!value) return;
    history.value = [value, ...history.value.filter((item) => item !== value)].slice(0, maxSearchHistory);
    window.localStorage.setItem(searchHistoryStorageKey, JSON.stringify(history.value));
  };

  const scheduleCoreSearch = () => {
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);

    if (!repo.repository || !hasActiveSearch.value) {
      resetCoreResults();
      searchLoading.value = false;
      error.value = undefined;
      searchProgress.value = { scannedFiles: 0, totalFiles: 0, emittedResults: 0 };
      void cancelActiveSearch();
      return;
    }

    searchLoading.value = true;
    error.value = undefined;
    searchTimer = window.setTimeout(() => {
      searchTimer = undefined;
      void refreshResults();
    }, coreSearchDelayMs);
  };

  const refreshResults = async () => {
    if (!repo.repository || !hasActiveSearch.value) return;

    const searchId = createSearchId();
    await cancelActiveSearch();
    activeSearchId.value = searchId;
    resetCoreResults();
    searchLoading.value = true;
    error.value = undefined;
    searchProgress.value = { scannedFiles: 0, totalFiles: repo.changedFiles.length, emittedResults: 0 };

    try {
      const response = await client.startSearch({
        searchId,
        sessionId: review.session?.id ?? '',
        query: query.value,
        mode: mode.value,
        filters: activeFilters.value,
        target: repo.diffTarget,
      });
      if (activeSearchId.value === searchId && response.searchId !== searchId) activeSearchId.value = response.searchId;
    } catch (err) {
      if (activeSearchId.value !== searchId) return;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
      searchLoading.value = false;
      activeSearchId.value = undefined;
    }
  };

  const cancelActiveSearch = async () => {
    const searchId = activeSearchId.value;
    if (!searchId) return;
    activeSearchId.value = undefined;
    try {
      await client.cancelSearch(searchId);
    } catch {
      // Cancellation is best-effort; stale events are still ignored by searchId.
    }
  };

  const clampSelectedIndex = () => {
    selectedIndex.value = Math.min(selectedIndex.value, Math.max(0, results.value.length - 1));
  };

  let pendingCoreResults: SearchResult[] = [];
  let coreResultsFrame: number | undefined;

  const queueCoreResults = (items: SearchResult[]) => {
    pendingCoreResults.push(...items);
    if (coreResultsFrame !== undefined) return;
    coreResultsFrame = window.requestAnimationFrame(flushCoreResults);
  };

  const flushCoreResults = () => {
    if (coreResultsFrame !== undefined) {
      window.cancelAnimationFrame(coreResultsFrame);
      coreResultsFrame = undefined;
    }
    if (pendingCoreResults.length === 0) return;

    coreResults.value = [...coreResults.value, ...pendingCoreResults];
    pendingCoreResults = [];
    clampSelectedIndex();
  };

  const resetCoreResults = () => {
    if (coreResultsFrame !== undefined) {
      window.cancelAnimationFrame(coreResultsFrame);
      coreResultsFrame = undefined;
    }
    pendingCoreResults = [];
    coreResults.value = [];
  };

  watch([() => query.value, () => mode.value, () => activeFilters.value, searchScopeKey], scheduleCoreSearch);
  watch(
    () => results.value.length,
    () => clampSelectedIndex(),
  );

  return {
    query,
    treeQuery,
    mode,
    overlayOpen,
    drawerOpen,
    selectedIndex,
    pinnedSelectedIndex,
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
    pinnedResultCount,
    hasPinnedSnapshot,
    pinnedSelectedResult,
    pinnedQuery,
    hasActiveSearch,
    treeHasActiveSearch,
    activeSearchId,
    searchLoading,
    searchProgress,
    error,
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
    selectPinnedResult,
    removePinnedResult,
    rememberQuery,
  };
});

const createSearchId = () => {
  return `search-${Date.now()}-${window.crypto.randomUUID()}`;
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
