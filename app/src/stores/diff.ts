import { defineStore } from 'pinia'
import { useClient } from '../lib/useClient'
import type { DiffRenderModel } from '../lib/protocol'
import { ref } from 'vue';

export const useDiffStore = defineStore('diff', () => {
  const client = useClient();
  const current = ref<DiffRenderModel>();
  const loading = ref(false);
  const error = ref<string>();

  const loadDiff = async (fileId: string) => {
    loading.value = true;
    error.value = undefined;

    try {
      current.value = await client.getDiffRenderModel({ fileId, options: { mode: 'split' } })
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
    error.value = undefined;
  };

  return {
    current,
    loading,
    error,
    loadDiff,
    clear,
  };
});
