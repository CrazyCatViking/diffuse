import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef } from 'vue';
import type { ChangedFile, DiffAnalysis, DiffAnalysisStatus, DiffAnalysisStatusKind, DiffContextMode } from '../lib/protocol';
import { useClient } from '../lib/useClient';
import { useRepoStore } from './repo';

type AnalysisFile = Pick<ChangedFile, 'id' | 'signature'>;

type QueueRequest = {
  file: AnalysisFile;
  context: DiffContextMode;
  key: string;
};

export const useDiffAnalysisStore = defineStore('diffAnalysis', () => {
  const client = useClient();
  const repo = useRepoStore();
  const statuses = shallowRef<Record<string, DiffAnalysisStatus>>({});
  const analyses = shallowRef<Record<string, DiffAnalysis>>({});
  const revision = ref(0);
  const activeContext = ref<DiffContextMode>('diff');
  const queue: QueueRequest[] = [];
  const queuedKeys = new Set<string>();
  const requestInFlightKeys = new Set<string>();
  const analysisLoadKeys = new Set<string>();
  const maxConcurrentAnalysisRequests = 2;
  let activeRequests = 0;

  const isCoreEvent = (event: unknown): event is { method: string; params?: unknown } => {
    return typeof event === 'object' && event !== null && 'method' in event && typeof (event as { method?: unknown }).method === 'string';
  };

  window.diffuse.onCoreEvent((event) => {
    if (!isCoreEvent(event) || event.method !== 'diffAnalysis/statusChanged') return;
    const status = parseStatus(event.params);
    if (!status || !currentFileMatches(status)) return;

    upsertStatus(status);
    if (status.status === 'ready') void loadAnalysis(status.fileId, status.signature, activeContext.value);
  });

  const statusForFile = (fileId: string): DiffAnalysisStatus | undefined => statuses.value[fileId];

  const statusKindForFile = (fileId: string): DiffAnalysisStatusKind => statusForFile(fileId)?.status ?? 'missing';

  const analysisForFile = (fileId: string | undefined, signature: string | undefined): DiffAnalysis | undefined => {
    if (!fileId || !signature) return undefined;
    const analysis = analyses.value[fileId];
    return analysis?.signature === signature ? analysis : undefined;
  };

  const refreshStatuses = async (files: AnalysisFile[], context: DiffContextMode) => {
    activeContext.value = context;
    if (files.length === 0) {
      clear();
      return;
    }

    const result = await client.getDiffAnalysisStatuses(files, { context }, repo.diffTarget);
    const next: Record<string, DiffAnalysisStatus> = {};
    for (const status of result) {
      next[status.fileId] = status;
      if (status.status === 'ready') void loadAnalysis(status.fileId, status.signature, context);
    }
    statuses.value = next;
    revision.value += 1;
  };

  const ensureFiles = (files: AnalysisFile[], context: DiffContextMode) => {
    activeContext.value = context;
    for (const file of files) {
      const current = statuses.value[file.id];
      if (
        current?.signature === file.signature &&
        (current.status === 'ready' || current.status === 'queued' || current.status === 'analyzing')
      )
        continue;

      const key = requestKey(file, context);
      if (queuedKeys.has(key) || requestInFlightKeys.has(key)) continue;
      queuedKeys.add(key);
      queue.push({ file, context, key });
      upsertStatus({ fileId: file.id, signature: file.signature, status: 'queued', updatedAtMs: Date.now() });
    }
    pumpQueue();
  };

  const loadAnalysis = async (fileId: string, signature: string, context: DiffContextMode) => {
    const key = `${fileId}:${signature}:${context}`;
    if (analysisLoadKeys.has(key)) return;
    analysisLoadKeys.add(key);
    try {
      const analysis = await client.getDiffAnalysis(fileId, signature, { context }, repo.diffTarget);
      if (!analysis || !currentFileMatches({ fileId, signature })) return;
      analyses.value = { ...analyses.value, [fileId]: markRaw(analysis) };
      revision.value += 1;
    } catch {
      // Analysis is an enhancement; keep the cheap diff usable if loading it fails.
    } finally {
      analysisLoadKeys.delete(key);
    }
  };

  const pumpQueue = () => {
    while (activeRequests < maxConcurrentAnalysisRequests) {
      const request = queue.shift();
      if (!request) return;
      queuedKeys.delete(request.key);
      requestInFlightKeys.add(request.key);
      activeRequests += 1;
      void runQueuedRequest(request);
    }
  };

  const runQueuedRequest = async (request: QueueRequest) => {
    try {
      const status = await client.ensureDiffAnalysis(
        request.file.id,
        request.file.signature,
        { context: request.context },
        repo.diffTarget,
      );
      if (currentFileMatches(status)) {
        upsertStatus(status);
        if (status.status === 'ready') void loadAnalysis(status.fileId, status.signature, request.context);
      }
    } catch {
      upsertStatus({ fileId: request.file.id, signature: request.file.signature, status: 'failed', updatedAtMs: Date.now() });
    } finally {
      requestInFlightKeys.delete(request.key);
      activeRequests = Math.max(0, activeRequests - 1);
      pumpQueue();
    }
  };

  const upsertStatus = (status: DiffAnalysisStatus) => {
    statuses.value = { ...statuses.value, [status.fileId]: status };
    revision.value += 1;
  };

  const currentFileMatches = (status: Pick<DiffAnalysisStatus, 'fileId' | 'signature'>) => {
    return repo.changedFiles.some((file) => file.id === status.fileId && file.signature === status.signature);
  };

  const requestKey = (file: AnalysisFile, context: DiffContextMode) => `${file.id}:${file.signature}:${context}`;

  const clear = () => {
    statuses.value = {};
    analyses.value = {};
    queue.length = 0;
    queuedKeys.clear();
    requestInFlightKeys.clear();
    analysisLoadKeys.clear();
    activeRequests = 0;
    revision.value += 1;
  };

  return {
    statuses,
    analyses,
    revision,
    statusForFile,
    statusKindForFile,
    analysisForFile,
    refreshStatuses,
    ensureFiles,
    clear,
  };
});

const parseStatus = (value: unknown): DiffAnalysisStatus | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const status = value as Partial<DiffAnalysisStatus>;
  if (typeof status.fileId !== 'string' || typeof status.signature !== 'string' || typeof status.status !== 'string') return undefined;
  return {
    fileId: status.fileId,
    signature: status.signature,
    status: status.status,
    updatedAtMs: typeof status.updatedAtMs === 'number' ? status.updatedAtMs : Date.now(),
    message: typeof status.message === 'string' ? status.message : undefined,
  };
};
