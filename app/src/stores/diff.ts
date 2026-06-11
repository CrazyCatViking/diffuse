import { defineStore } from 'pinia'
import { useClient } from '../lib/useClient'
import type { DiffContextMode, DiffRenderModel, DiffViewMode } from '../lib/protocol'
import { ref } from 'vue';

export const useDiffStore = defineStore('diff', () => {
  const client = useClient();
  const current = ref<DiffRenderModel>();
  const loading = ref(false);
  const error = ref<string>();
  const currentFileId = ref<string>();
  const viewMode = ref<DiffViewMode>('split');
  const contextMode = ref<DiffContextMode>('diff');
  const syncScroll = ref(true);

  const loadDiff = async (fileId: string) => {
    currentFileId.value = fileId;
    loading.value = true;
    error.value = undefined;

    try {
      current.value = await client.getDiffRenderModel(fileId, {
        mode: viewMode.value,
        context: contextMode.value,
      })
    } catch (err) {
      if (err instanceof Error) {
        error.value = err.message;
      } else {
        error.value = JSON.stringify(err);
      }

      current.value = undefined;
    } finally {
      loading.value = false
    }
  };

  const clear = () => {
    current.value = undefined;
    currentFileId.value = undefined;
    error.value = undefined;
  };

  const setViewMode = (mode: DiffViewMode) => {
    viewMode.value = mode;
  };

  const setContextMode = (mode: DiffContextMode) => {
    if (contextMode.value === mode) return;
    contextMode.value = mode;
    if (currentFileId.value) void loadDiff(currentFileId.value);
  };

  const setSyncScroll = (enabled: boolean) => {
    syncScroll.value = enabled;
  };

  return {
    current,
    loading,
    error,
    viewMode,
    contextMode,
    syncScroll,
    loadDiff,
    clear,
    setViewMode,
    setContextMode,
    setSyncScroll,
  };
});
