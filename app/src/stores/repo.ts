import { defineStore } from 'pinia';
import type { ChangedFile, OpenRepositoryResult, VersionInfo } from '../lib/protocol'
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

  const activeFile = computed(() => changedFiles.value.find((file) => file.id === activeFileId.value) ?? null);

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
      changedFiles.value = await client.listChangedFiles();
      activeFileId.value = changedFiles.value[0]?.id ?? null;
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

  const selectFile = (fileId: string) => {
    activeFileId.value = fileId
  };

  return {
    version,
    repository,
    changedFiles,
    activeFileId,
    loading,
    error,

    activeFile,

    loadVersion,
    pickAndOpenRepository,
    openRepository,
    selectFile,
  };
});
