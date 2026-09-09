import { isAcpRequest, isReviewFileIds, record, utf8Bytes, maxAcpPromptBytes } from './acpContract';
import type { WorkspaceRequestContext } from './workbenchContract';

export const reviewWavesStateKey = 'acpReviewWaves';
export type ReviewWaveState = 'queued' | 'starting' | 'running' | 'completed' | 'cancelled' | 'failed';
export type ReviewWaveRun = {
  id: string;
  workspaceId: string;
  workspaceGeneration: string;
  reviewSessionId: string;
  adapterId: string;
  createdAt: string;
  prompt: string;
  parallel: number;
  status: ReviewWaveState;
  error?: string;
  shards: { fileIds: string[]; requestId: string; sessionId?: string; startedAt?: string; state: ReviewWaveState }[];
};
export type StartReviewWaves = { context: WorkspaceRequestContext; reviewSessionId: string; adapterId: string };
export type CancelReviewWaves = { context: WorkspaceRequestContext; runId: string };
export interface ReviewWavesBridge {
  startAcpReviewWaves(request: StartReviewWaves): Promise<ReviewWaveRun>;
  getAcpReviewWaves(context: WorkspaceRequestContext): Promise<ReviewWaveRun[]>;
  cancelAcpReviewWaves(request: CancelReviewWaves): Promise<null>;
}
export function isStartReviewWaves(value: unknown): value is StartReviewWaves {
  return (
    record(value) &&
    Object.keys(value).every((key) => ['context', 'reviewSessionId', 'adapterId'].includes(key)) &&
    isAcpRequest('openAcpSession', value) &&
    typeof value.reviewSessionId === 'string' &&
    !!value.reviewSessionId
  );
}
export function isCancelReviewWaves(value: unknown): value is CancelReviewWaves {
  return (
    record(value) &&
    Object.keys(value).every((key) => ['context', 'runId'].includes(key)) &&
    isAcpRequest('getAcpSnapshot', value.context) &&
    typeof value.runId === 'string' &&
    !!value.runId
  );
}
export function isReviewWaveRun(value: unknown): value is ReviewWaveRun {
  const states = ['queued', 'starting', 'running', 'completed', 'cancelled', 'failed'];
  return (
    record(value) &&
    ['id', 'workspaceId', 'workspaceGeneration', 'reviewSessionId', 'adapterId', 'createdAt'].every(
      (key) => typeof value[key] === 'string' && !!value[key],
    ) &&
    typeof value.prompt === 'string' &&
    utf8Bytes(value.prompt) <= maxAcpPromptBytes &&
    Number.isSafeInteger(value.parallel) &&
    Number(value.parallel) >= 1 &&
    states.includes(String(value.status)) &&
    (value.error === undefined || typeof value.error === 'string') &&
    Array.isArray(value.shards) &&
    value.shards.length > 0 &&
    value.shards.every(
      (shard) =>
        record(shard) &&
        isReviewFileIds(shard.fileIds) &&
        typeof shard.requestId === 'string' &&
        !!shard.requestId &&
        (shard.sessionId === undefined || (typeof shard.sessionId === 'string' && !!shard.sessionId)) &&
        (shard.startedAt === undefined || (typeof shard.startedAt === 'string' && Number.isFinite(Date.parse(shard.startedAt)))) &&
        states.includes(String(shard.state)),
    )
  );
}
export function rendererUiState(state: Record<string, unknown>) {
  const { [reviewWavesStateKey]: _waves, ...renderer } = state;
  return renderer;
}
