import { defineStore } from 'pinia';
import type { BranchInfo, ChangedFile, DiffTarget, DiffTargetDefaults, OpenRepositoryResult, VersionInfo } from '../lib/protocol';
import { computed, ref } from 'vue';
import { isActiveWorkspace, setActiveWorkspace, useClient } from '../lib/useClient';
import type { WorkspaceReference, WorkspaceSnapshot } from '../lib/workbenchContract';

const recentRepositoriesStorageKey = 'diffuse.recentRepositories';
const maxRecentRepositories = 10;

export type RecentRepository = {
  path: string;
  name: string;
  openedAt: number;
};

const loadRecentRepositories = (): RecentRepository[] => {
  const raw = window.localStorage.getItem(recentRepositoriesStorageKey);
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((repository): repository is RecentRepository => {
        return isRecentRepository(repository);
      })
      .slice(0, maxRecentRepositories);
  } catch {
    return [];
  }
};

const saveRecentRepositories = (repositories: RecentRepository[]) => {
  window.localStorage.setItem(recentRepositoriesStorageKey, JSON.stringify(repositories));
};

const isRecentRepository = (value: unknown): value is RecentRepository => {
  if (typeof value !== 'object' || value === null) return false;

  const repository = value as Partial<RecentRepository>;
  return typeof repository.path === 'string' && typeof repository.name === 'string' && typeof repository.openedAt === 'number';
};

const repositoryName = (path: string): string => {
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || path;
};

export const useRepoStore = defineStore('repo', () => {
  const client = useClient();
  const version = ref<VersionInfo>();
  const workspace = ref<WorkspaceReference>();
  const repository = ref<OpenRepositoryResult>();
  const diffTarget = ref<DiffTarget>({ includeStaged: true, includeUnstaged: true });
  const diffTargetDefaults = ref<DiffTargetDefaults>();
  const branches = ref<BranchInfo[]>([]);
  const recentRepositories = ref<RecentRepository[]>(loadRecentRepositories());
  const changedFiles = ref<ChangedFile[]>([]);
  const activeFileId = ref<string>();
  const loading = ref(false);
  const error = ref<string>();
  const changeRevision = ref(0);
  const changedFileIds = ref<string[]>([]);
  let refreshInFlight = false;
  let refreshQueued = false;
  let workspaceLoadGeneration = 0;
  let refreshEpoch = 0;

  const activeFile = computed(() => changedFiles.value.find((file) => file.id === activeFileId.value) ?? null);

  window.diffuse.onWorkbenchEvent((event) => {
    if (event.kind !== 'repository/changed' || !isActiveWorkspace(event)) return;
    if (event.payload.root !== repository.value?.root) return;
    void refreshChangedFiles({ selectFallback: false, trackChangedIds: true, changedPaths: event.payload.paths });
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
      const snapshot = await withContext(`open repository ${path}`, () => client.openRepository(path));
      await loadWorkspace(snapshot);
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

  const restoreWorkbench = async () => {
    const snapshot = await client.getWorkbenchSnapshot();
    if (snapshot.activeWorkspace) await loadWorkspace(snapshot.activeWorkspace);
  };

  const loadWorkspace = async (snapshot: WorkspaceSnapshot, restoredTarget?: DiffTarget) => {
    const generation = ++workspaceLoadGeneration;
    refreshEpoch += 1;
    refreshInFlight = false;
    refreshQueued = false;
    workspace.value = snapshot.summary;
    repository.value = snapshot.repository;
    setActiveWorkspace(snapshot.summary);
    rememberRepository(snapshot.repository.root);
    const [defaults, nextBranches] = await Promise.all([
      withContext('load diff target defaults', () => client.getDiffTargetDefaults()),
      withContext('list branches', () => client.listBranches()),
    ]);
    if (generation !== workspaceLoadGeneration || !isActiveWorkspace(snapshot.summary)) return;
    diffTargetDefaults.value = defaults;
    branches.value = nextBranches;
    diffTarget.value = restoredTarget ? normalizeTarget(restoredTarget) : targetFromDefaults(defaults);
    await refreshChangedFiles({ selectFallback: true, trackChangedIds: false });
  };

  const clearActiveWorkspace = () => {
    workspaceLoadGeneration += 1;
    refreshEpoch += 1;
    refreshInFlight = false;
    refreshQueued = false;
    workspace.value = undefined;
    repository.value = undefined;
    diffTarget.value = { includeStaged: true, includeUnstaged: true };
    diffTargetDefaults.value = undefined;
    branches.value = [];
    changedFiles.value = [];
    activeFileId.value = undefined;
    changedFileIds.value = [];
    loading.value = false;
    error.value = undefined;
  };

  const refreshChangedFiles = async (options: { selectFallback?: boolean; trackChangedIds?: boolean; changedPaths?: string[] } = {}) => {
    if (!repository.value) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }

    refreshInFlight = true;
    const epoch = refreshEpoch;
    try {
      const files = await withContext('list changed files', () => client.listChangedFiles(diffTarget.value));
      if (epoch !== refreshEpoch) return;
      const previousActiveFileId = activeFileId.value;
      changedFileIds.value =
        options.trackChangedIds === false ? [] : changedFileIdsBetween(changedFiles.value, files, options.changedPaths ?? []);
      changedFiles.value = files;
      if (files.some((file) => file.id === previousActiveFileId)) {
        activeFileId.value = previousActiveFileId;
      } else if (options.selectFallback) {
        activeFileId.value = files[0]?.id;
      }
      changeRevision.value += 1;
    } catch (err) {
      if (epoch !== refreshEpoch) return;
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
    } finally {
      if (epoch !== refreshEpoch) return;
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refreshChangedFiles({ selectFallback: false, trackChangedIds: true });
      }
    }
  };

  const withContext = async <T>(action: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : JSON.stringify(err);
      throw new Error(`Failed to ${action}: ${message}`);
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

  const fileSignature = (file: ChangedFile): string => {
    return JSON.stringify({
      oldPath: file.oldPath,
      newPath: file.newPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      signature: file.signature,
    });
  };

  const selectFile = (fileId: string) => {
    activeFileId.value = fileId;
  };

  const setDiffTarget = async (target: DiffTarget) => {
    diffTarget.value = normalizeTarget(target);
    await refreshChangedFiles({ selectFallback: true, trackChangedIds: false });
  };

  const resetDiffTarget = async () => {
    if (!repository.value) return;
    diffTargetDefaults.value = await client.getDiffTargetDefaults();
    branches.value = await client.listBranches();
    await setDiffTarget(targetFromDefaults(diffTargetDefaults.value));
  };

  const normalizeTarget = (target: DiffTarget): DiffTarget => {
    return {
      base: target.base?.trim() || undefined,
      compare: target.compare?.trim() || undefined,
      includeStaged: target.includeStaged,
      includeUnstaged: target.includeUnstaged,
    };
  };

  const targetFromDefaults = (target: DiffTargetDefaults): DiffTarget => {
    return {
      base: target.base,
      compare: target.compare,
      includeStaged: target.includeStaged,
      includeUnstaged: target.includeUnstaged,
    };
  };

  function rememberRepository(path: string) {
    recentRepositories.value = [
      { path, name: repositoryName(path), openedAt: Date.now() },
      ...recentRepositories.value.filter((repository) => repository.path !== path),
    ].slice(0, maxRecentRepositories);
    saveRecentRepositories(recentRepositories.value);
  }

  return {
    version,
    workspace,
    repository,
    diffTarget,
    diffTargetDefaults,
    branches,
    recentRepositories,
    changedFiles,
    activeFileId,
    loading,
    error,
    changeRevision,
    changedFileIds,

    activeFile,

    loadVersion,
    restoreWorkbench,
    loadWorkspace,
    clearActiveWorkspace,
    pickAndOpenRepository,
    openRepository,
    refreshChangedFiles,
    selectFile,
    setDiffTarget,
    resetDiffTarget,
  };
});
