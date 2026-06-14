import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useClient } from '../lib/useClient';
import type { DiffContextMode, DiffRenderModel, DiffViewMode } from '../lib/protocol';

export const useDiffStore = defineStore('diff', () => {
  const client = useClient();
  const current = ref<DiffRenderModel>();
  const loading = ref(false);
  const error = ref<string>();
  const currentFileId = ref<string>();
  const viewMode = ref<DiffViewMode>('split');
  const contextMode = ref<DiffContextMode>('diff');
  const syncScroll = ref(true);
  const installingGrammar = ref(false);
  const grammarInstallStep = ref<string>();

  const isCoreEvent = (event: unknown): event is { method: string; params?: unknown } => {
    return typeof event === 'object' && event !== null && 'method' in event && typeof (event as { method?: unknown }).method === 'string';
  };

  window.diffuse.onCoreEvent((event) => {
    if (!isCoreEvent(event) || event.method !== 'treeSitter/installProgress') return;
    if (!event.params || typeof event.params !== 'object') return;

    const params = event.params as { language?: unknown; step?: unknown };
    if (params.language !== current.value?.syntax.language) return;
    if (typeof params.step === 'string') grammarInstallStep.value = params.step;
  });

  const loadDiff = async (fileId: string) => {
    currentFileId.value = fileId;
    loading.value = true;
    error.value = undefined;

    try {
      current.value = await client.getDiffRenderModel(fileId, {
        mode: viewMode.value,
        context: contextMode.value,
      });
    } catch (err) {
      if (err instanceof Error) {
        error.value = err.message;
      } else {
        error.value = JSON.stringify(err);
      }

      current.value = undefined;
    } finally {
      loading.value = false;
    }
  };

  const installMissingGrammar = async () => {
    const language = current.value?.syntax.language;
    if (!language || installingGrammar.value) return;

    installingGrammar.value = true;
    grammarInstallStep.value = 'Starting install';
    error.value = undefined;

    try {
      const result = await client.installTreeSitterGrammar(language);
      if (!result.installed) throw new Error(result.message ?? `Failed to install ${language} grammar`);
      if (currentFileId.value) await loadDiff(currentFileId.value);
    } catch (err) {
      error.value = err instanceof Error ? err.message : JSON.stringify(err);
    } finally {
      installingGrammar.value = false;
      grammarInstallStep.value = undefined;
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
    installingGrammar,
    grammarInstallStep,
    loadDiff,
    installMissingGrammar,
    clear,
    setViewMode,
    setContextMode,
    setSyncScroll,
  };
});
