import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef } from 'vue';
import { useClient } from '../lib/useClient';
import type { DiffContextMode, DiffRenderModel, DiffViewMode } from '../lib/protocol';
import { useRepoStore } from './repo';

export const useDiffStore = defineStore('diff', () => {
  const client = useClient();
  const repo = useRepoStore();
  const maxEnrichedCacheEntries = 40;
  const enrichedModelCache = new Map<string, DiffRenderModel>();
  const pendingEnrichment = new Map<string, Promise<DiffRenderModel>>();
  const current = shallowRef<DiffRenderModel>();
  const loading = ref(false);
  const error = ref<string>();
  const currentFileId = ref<string>();
  const hasNewChanges = ref(false);
  const viewMode = ref<DiffViewMode>('split');
  const contextMode = ref<DiffContextMode>('diff');
  const syncScroll = ref(true);
  const installingGrammar = ref(false);
  const grammarInstallStep = ref<string>();
  let loadGeneration = 0;

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

  const loadDiff = async (fileId: string, options: { silent?: boolean } = {}) => {
    const generation = ++loadGeneration;
    currentFileId.value = fileId;
    if (!options.silent) loading.value = true;
    error.value = undefined;
    const cacheKey = diffCacheKey(fileId);
    const cached = enrichedModelCache.get(cacheKey);
    if (cached) {
      current.value = markRaw(cached);
      hasNewChanges.value = false;
      if (!options.silent) loading.value = false;
      return;
    }

    try {
      const basic = await client.getDiffRenderModel(
        fileId,
        {
          mode: viewMode.value,
          context: contextMode.value,
          intelligence: 'basic',
        },
        repo.diffTarget,
      );
      if (generation !== loadGeneration || cacheKey !== diffCacheKey(fileId)) return;
      current.value = markRaw(basic);
      hasNewChanges.value = false;
      void loadEnrichedDiff(fileId, cacheKey, generation);
    } catch (err) {
      if (generation !== loadGeneration) return;
      if (err instanceof Error) {
        error.value = err.message;
      } else {
        error.value = JSON.stringify(err);
      }

      if (!options.silent) current.value = undefined;
    } finally {
      if (generation === loadGeneration && !options.silent) loading.value = false;
    }
  };

  const loadEnrichedDiff = async (fileId: string, cacheKey: string, generation: number) => {
    try {
      const enriched = await enrichedModelFor(fileId, cacheKey);
      if (generation !== loadGeneration || currentFileId.value !== fileId || cacheKey !== diffCacheKey(fileId)) return;
      current.value = markRaw(enriched);
    } catch {
      // Keep the basic diff usable if semantic enrichment is slow or fails.
    }
  };

  const enrichedModelFor = async (fileId: string, cacheKey: string) => {
    const cached = enrichedModelCache.get(cacheKey);
    if (cached) return cached;

    const pending =
      pendingEnrichment.get(cacheKey) ??
      client
        .getDiffRenderModel(
          fileId,
          {
            mode: viewMode.value,
            context: contextMode.value,
            intelligence: 'full',
          },
          repo.diffTarget,
        )
        .then((model) => {
          rememberEnrichedModel(cacheKey, model);
          return model;
        })
        .finally(() => pendingEnrichment.delete(cacheKey));
    pendingEnrichment.set(cacheKey, pending);
    return pending;
  };

  const rememberEnrichedModel = (cacheKey: string, model: DiffRenderModel) => {
    enrichedModelCache.delete(cacheKey);
    enrichedModelCache.set(cacheKey, markRaw(model));
    while (enrichedModelCache.size > maxEnrichedCacheEntries) {
      const oldest = enrichedModelCache.keys().next().value;
      if (!oldest) break;
      enrichedModelCache.delete(oldest);
    }
  };

  const diffCacheKey = (fileId: string) => {
    const file = repo.changedFiles.find((candidate) => candidate.id === fileId);
    return JSON.stringify({
      root: repo.repository?.root,
      head: repo.repository?.head,
      fileId,
      signature: file?.signature,
      mode: viewMode.value,
      context: contextMode.value,
      target: {
        base: repo.diffTarget.base,
        compare: repo.diffTarget.compare,
        includeStaged: repo.diffTarget.includeStaged,
        includeUnstaged: repo.diffTarget.includeUnstaged,
      },
    });
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
      enrichedModelCache.clear();
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
    hasNewChanges.value = false;
    enrichedModelCache.clear();
    pendingEnrichment.clear();
  };

  const markNewChanges = () => {
    if (current.value) hasNewChanges.value = true;
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
    hasNewChanges,
    viewMode,
    contextMode,
    syncScroll,
    installingGrammar,
    grammarInstallStep,
    loadDiff,
    installMissingGrammar,
    clear,
    markNewChanges,
    setViewMode,
    setContextMode,
    setSyncScroll,
  };
});
