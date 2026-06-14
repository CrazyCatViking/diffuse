import { defineStore } from 'pinia';
import type { ChangedFile, OpenRepositoryResult, VersionInfo } from '../lib/protocol';
import { computed, ref } from 'vue';
import { useClient } from '../lib/useClient';

export const useRepoStore = defineStore('repo', () => {
  const client = useClient();
  const version = ref<VersionInfo>();
  const repository = ref<OpenRepositoryResult>();
  const changedFiles = ref<ChangedFile[]>([]);
  const activeFileId = ref<string>();
  const loading = ref(false);
  const error = ref<string>();
  const changeRevision = ref(0);
  const changedFileIds = ref<string[]>([]);
  let refreshInFlight = false;
  let refreshQueued = false;

  const activeFile = computed(() => changedFiles.value.find((file) => file.id === activeFileId.value) ?? null);

  const isCoreEvent = (event: unknown): event is { method: string; params?: unknown } => {
    return typeof event === 'object' && event !== null && 'method' in event && typeof (event as { method?: unknown }).method === 'string';
  };

  window.diffuse.onCoreEvent((event) => {
    if (!isCoreEvent(event) || event.method !== 'repository/changed') return;
    if (!event.params || typeof event.params !== 'object') return;

    const params = event.params as { root?: unknown; paths?: unknown };
    if (params.root !== repository.value?.root) return;
    void refreshChangedFiles({ selectFallback: false, trackChangedIds: true, changedPaths: stringArrayParam(params.paths) });
  });

  const loadVersion = async () => {
    version.value = await client.getVersion();
  };

  const pickAndOpenRepository = async () => {
    const path = await client.pickRepository();
    if (!path) return;

    console.log('Selected repository path:', path);

    await openRepository(path);

    console.log('Repository opened successfully:', repository.value);
  };

  const openRepository = async (path: string) => {
    loading.value = true;
    error.value = undefined;
    try {
      repository.value = await client.openRepository(path);
      await refreshChangedFiles({ selectFallback: true, trackChangedIds: false });
    } catch (err) {
      if (err instanceof Error) {
        error.value = err.message;
      } else {
        error.value = JSON.stringify(err);
      }
    } finally {
      loading.value = false;
    }
  };

  const refreshChangedFiles = async (options: { selectFallback?: boolean; trackChangedIds?: boolean; changedPaths?: string[] } = {}) => {
    if (!repository.value) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }

    refreshInFlight = true;
    try {
      const files = await client.listChangedFiles();
      const previousActiveFileId = activeFileId.value;
      changedFileIds.value = options.trackChangedIds === false ? [] : changedFileIdsBetween(changedFiles.value, files, options.changedPaths ?? []);
      changedFiles.value = files;
      if (files.some((file) => file.id === previousActiveFileId)) {
        activeFileId.value = previousActiveFileId;
      } else if (options.selectFallback) {
        activeFileId.value = files[0]?.id;
      }
      changeRevision.value += 1;
    } catch (err) {
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
    } finally {
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refreshChangedFiles({ selectFallback: false, trackChangedIds: true });
      }
    }
  };

  const changedFileIdsBetween = (previous: ChangedFile[], next: ChangedFile[], changedPaths: string[]): string[] => {
    const previousById = new Map(previous.map((file) => [file.id, fileSignature(file)]));
    const nextById = new Map(next.map((file) => [file.id, fileSignature(file)]));
    const ids = new Set<string>();
    const allFiles = [...previous, ...next];

    for (const [id, signature] of nextById) {
      if (previousById.get(id) !== signature) ids.add(id);
    }

    for (const id of previousById.keys()) {
      if (!nextById.has(id)) ids.add(id);
    }

    for (const path of changedPaths) {
      for (const file of allFiles) {
        if (fileMatchesPath(file, path)) ids.add(file.id);
      }
    }

    return [...ids];
  };

  const fileMatchesPath = (file: ChangedFile, path: string): boolean => {
    return file.id === path || file.oldPath === path || file.newPath === path;
  };

  const stringArrayParam = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  };

  const fileSignature = (file: ChangedFile): string => {
    return JSON.stringify({
      oldPath: file.oldPath,
      newPath: file.newPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    });
  };

  const selectFile = (fileId: string) => {
    activeFileId.value = fileId;
  };

  return {
    version,
    repository,
    changedFiles,
    activeFileId,
    loading,
    error,
    changeRevision,
    changedFileIds,

    activeFile,

    loadVersion,
    pickAndOpenRepository,
    openRepository,
    refreshChangedFiles,
    selectFile,
  };
});
