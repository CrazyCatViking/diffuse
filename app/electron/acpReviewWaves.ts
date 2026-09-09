import { randomUUID } from 'node:crypto';
import type { CoreBackend } from './coreBackend';
import { CoreBackendError } from './coreBackend';
import { reviewShardPrompt, planReviewScopes } from '../src/lib/acpReviewPlan';
import {
  isReviewWaveRun,
  reviewWavesStateKey,
  type ReviewWaveRun,
  type StartReviewWaves,
  type CancelReviewWaves,
} from '../src/lib/acpReviewWaves';
import { sameReviewFileIds } from '../src/lib/acpContract';
import type { WorkspaceRequestContext, SaveWorkspaceUiStateRequest } from '../src/lib/workbenchContract';

/** Main-process ownership lets pending waves survive renderer loss. SQLite UI records
 * retain the device-local plan, never transcripts or repository-portable artifacts. */
export class AcpReviewWaves {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private busy = false;
  private wakeVersion = 0;
  private runOperations = new Map<string, Promise<void>>();
  private cancellations = new Map<string, number>();
  constructor(private readonly backend: CoreBackend) {}
  startPolling() {
    if (this.stopped) return;
    // Even an existing timer needs a new wake: an older pump may still hold an empty snapshot.
    this.wakeVersion += 1;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pump().catch(() => undefined);
    }, 250);
    this.timer.unref?.();
    void this.pump().catch(() => undefined);
  }
  dispose() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async list(context: WorkspaceRequestContext): Promise<ReviewWaveRun[]> {
    await this.backend.getWorkspaceSnapshot(context);
    const snapshot = await this.backend.getWorkbenchSnapshot();
    const stored = snapshot.workspaceUiState[context.workspaceId]?.state[reviewWavesStateKey];
    return Array.isArray(stored) ? stored.filter((run) => isReviewWaveRun(run) && run.workspaceId === context.workspaceId) : [];
  }
  async start(request: StartReviewWaves) {
    if (this.stopped) throw new Error('ACP review scheduler is stopping');
    const { context, adapterId, reviewSessionId } = request;
    const adapters = await this.backend.discoverAcpAdapters();
    if (!adapters.some((item) => item.adapter.id === adapterId && item.available && item.platformSupported))
      throw new Error('Selected ACP adapter is unavailable');
    const reviews = (await this.backend.request(context, 'listReviewSessions', undefined)).result;
    const review = reviews.find((review) => review.id === reviewSessionId);
    if (!review) throw new Error('Review session is outside this workspace');
    const config = (await this.backend.request(context, 'getReviewConfig', undefined)).result;
    const prompt = reviewShardPrompt(config.promptInstructions);
    const files = (await this.backend.request(context, 'listChangedFiles', { target: review.target })).result;
    const plan = planReviewScopes(
      files.map((file) => file.id),
      config.maxParallelAgents,
    );
    const run: ReviewWaveRun = {
      id: randomUUID(),
      workspaceId: context.workspaceId,
      workspaceGeneration: context.workspaceGeneration,
      reviewSessionId,
      adapterId,
      createdAt: new Date().toISOString(),
      prompt,
      parallel: plan.parallel,
      status: 'running',
      shards: plan.scopes.map((fileIds) => ({ fileIds, requestId: randomUUID(), state: 'queued' })),
    };
    await this.persist(context, run);
    this.startPolling();
    return run;
  }
  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.runOperations.get(runId) ?? Promise.resolve()).then(operation);
    const tail = pending.then(
      () => undefined,
      () => undefined,
    );
    this.runOperations.set(runId, tail);
    try {
      return await pending;
    } finally {
      if (this.runOperations.get(runId) === tail) this.runOperations.delete(runId);
    }
  }
  private async persist(context: WorkspaceRequestContext, run: ReviewWaveRun, cancelLatest = false): Promise<ReviewWaveRun> {
    for (;;) {
      await this.backend.getWorkspaceSnapshot(context);
      const record = (await this.backend.getWorkbenchSnapshot()).workspaceUiState[context.workspaceId];
      const stored = record?.state[reviewWavesStateKey];
      const runs = Array.isArray(stored) ? stored.filter(isReviewWaveRun) : [];
      const current = runs.find((item) => item.id === run.id);
      if (cancelLatest && !current) throw new Error('Review wave run is outside this workspace');
      // Rebase cancellation on the record read for this CAS attempt, not its earlier
      // validation snapshot. Admissions may have added IDs while that read was pending.
      const next = cancelLatest ? current! : run;
      if (cancelLatest && next.status === 'completed') return next;
      if (current?.status === 'cancelled' || this.cancellations.has(run.id)) {
        next.status = 'cancelled';
        for (const shard of next.shards) if (shard.state !== 'completed') shard.state = 'cancelled';
      }
      const result = await this.backend.saveWorkspaceUiState({
        workspaceId: context.workspaceId,
        workspaceGeneration: context.workspaceGeneration,
        expectedRevision: record?.revision ?? 0,
        state: { ...record?.state, [reviewWavesStateKey]: [...runs.filter((item) => item.id !== run.id), next] },
      });
      if (result.outcome === 'stale') continue;
      if (!['applied', 'unchanged'].includes(result.outcome)) throw new Error('Could not persist ACP review wave plan');
      return next;
    }
  }
  async saveRendererUi(request: SaveWorkspaceUiStateRequest) {
    const snapshot = await this.backend.getWorkbenchSnapshot();
    const state = { ...request.state };
    delete state[reviewWavesStateKey];
    const waves = snapshot.workspaceUiState[request.workspaceId]?.state[reviewWavesStateKey];
    if (waves !== undefined) state[reviewWavesStateKey] = waves;
    return this.backend.saveWorkspaceUiState({ ...request, state });
  }
  async cancel(request: CancelReviewWaves): Promise<null> {
    const run = (await this.list(request.context)).find((run) => run.id === request.runId);
    if (!run) throw new Error('Review wave run is outside this workspace');
    this.cancellations.set(run.id, (this.cancellations.get(run.id) ?? 0) + 1);
    try {
      return await this.withRunLock(run.id, async () => {
        const cancelled = await this.persist(request.context, run, true);
        if (cancelled.status === 'completed') return null;
        await this.stopSessions(request.context, cancelled);
        if (cancelled.error)
          await this.backend.createAttention({
            workspaceId: request.context.workspaceId,
            workspaceGeneration: request.context.workspaceGeneration,
            sourceId: `acp-wave:${cancelled.id}`,
            kind: 'error',
            revision: 2,
            status: 'resolved',
            target: { kind: 'review', reviewSessionId: cancelled.reviewSessionId },
          });
        return null;
      });
    } finally {
      const remaining = this.cancellations.get(run.id)! - 1;
      if (remaining) this.cancellations.set(run.id, remaining);
      else this.cancellations.delete(run.id);
    }
  }
  private async stopSessions(context: WorkspaceRequestContext, run: ReviewWaveRun) {
    const snapshot = await this.backend.getAcpSnapshot(context);
    const stops: Promise<unknown>[] = [];
    for (const shard of run.shards) {
      if (!shard.sessionId) continue;
      const sessionId = shard.sessionId;
      const session = snapshot.sessions.find((session) => session.id === sessionId);
      if (!session) {
        stops.push(this.backend.closeAcpSession({ context, sessionId }));
        continue;
      }
      if (
        !session ||
        session.reviewSessionId !== run.reviewSessionId ||
        session.adapterId !== run.adapterId ||
        !sameReviewFileIds(session.reviewFileIds, shard.fileIds)
      )
        continue;
      for (const turn of snapshot.turnsBySession[sessionId] ?? [])
        if (turn.state === 'queued') stops.push(this.backend.cancelAcpTurn({ context, sessionId, turnId: turn.id }));
      if (['starting', 'ready', 'running'].includes(session.state)) stops.push(this.backend.closeAcpSession({ context, sessionId }));
    }
    const results = await Promise.allSettled(stops);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  async closeWorkspace(context: WorkspaceRequestContext, force: boolean) {
    const active = (await this.list(context)).filter((run) => ['queued', 'starting', 'running'].includes(run.status));
    if (active.length && !force)
      throw new CoreBackendError('WorkspaceHasActiveReview', 'WorkspaceHasActiveReview: ACP review waves are queued or running');
    for (const run of active) await this.cancel({ context, runId: run.id });
  }
  async pump() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    const wakeVersion = this.wakeVersion;
    let pendingJobs = true;
    try {
      const workbench = await this.backend.getWorkbenchSnapshot();
      pendingJobs = false;
      for (const workspace of workbench.workspaces) {
        const context = { workspaceId: workspace.workspaceId, workspaceGeneration: workspace.workspaceGeneration, requestId: randomUUID() };
        const stored = workbench.workspaceUiState[workspace.workspaceId]?.state[reviewWavesStateKey];
        if (!Array.isArray(stored)) continue;
        for (const candidate of stored.filter(
          (run): run is ReviewWaveRun => isReviewWaveRun(run) && run.workspaceId === workspace.workspaceId,
        )) {
          if (!['running', 'starting', 'queued'].includes(candidate.status) || this.stopped) continue;
          pendingJobs = true;
          await this.withRunLock(candidate.id, async () => {
            const run = (await this.list(context)).find((run) => run.id === candidate.id);
            if (!run || !['running', 'starting', 'queued'].includes(run.status) || this.stopped || this.cancellations.has(run.id)) return;
            try {
              run.workspaceGeneration = context.workspaceGeneration;
              const snapshot = await this.backend.getAcpSnapshot(context);
              let changed = false;
              for (const shard of run.shards) {
                if (this.stopped || this.cancellations.has(run.id)) break;
                if (shard.state === 'completed' || shard.state === 'cancelled') continue;
                if (!shard.sessionId) continue;
                const session = snapshot.sessions.find((session) => session.id === shard.sessionId);
                if (!session && shard.state === 'starting' && Date.now() - Date.parse(shard.startedAt ?? run.createdAt) < 30000) continue;
                if (
                  !session ||
                  session.reviewSessionId !== run.reviewSessionId ||
                  session.adapterId !== run.adapterId ||
                  session.permissionPolicy !== 'deny-all' ||
                  !sameReviewFileIds(session.reviewFileIds, shard.fileIds)
                )
                  throw new Error('Review wave session is unavailable or has a mismatched scope');
                const turn = snapshot.turnsBySession[session.id]?.find((turn) => turn.requestId === shard.requestId);
                if (turn?.state === 'completed') {
                  if (['closed', 'failed'].includes(session.state)) {
                    shard.state = 'completed';
                    changed = true;
                  } else await this.backend.closeAcpSession({ context, sessionId: session.id });
                } else if (
                  turn?.state === 'failed' ||
                  turn?.state === 'cancelled' ||
                  session.state === 'failed' ||
                  session.state === 'closed'
                )
                  throw new Error('A review wave was interrupted. Start a new review or inspect the failed session history.');
                else if (!turn && session.state === 'ready') {
                  await this.backend.queueAcpPrompt({
                    context: { ...context, requestId: shard.requestId },
                    sessionId: session.id,
                    text: run.prompt,
                  });
                  shard.state = 'running';
                  changed = true;
                }
              }
              if (run.shards.every((shard) => shard.state === 'completed')) {
                run.status = 'completed';
                changed = true;
              }
              let active = run.shards.filter((shard) => shard.sessionId && ['starting', 'running'].includes(shard.state)).length;
              for (const shard of run.shards) {
                if (this.stopped || this.cancellations.has(run.id) || active >= run.parallel) break;
                if (shard.state !== 'queued' && !(shard.state === 'starting' && !shard.sessionId)) continue;
                shard.state = 'starting';
                shard.startedAt = new Date().toISOString();
                await this.persist(context, run);
                if (this.cancellations.has(run.id) || this.stopped) break;
                const opened = await this.backend.openAcpSession({
                  context,
                  adapterId: run.adapterId,
                  reviewSessionId: run.reviewSessionId,
                  reviewFileIds: shard.fileIds,
                  interactive: false,
                });
                shard.sessionId = opened.sessionId;
                active += 1;
                changed = true;
                await this.persist(context, run);
                if (this.cancellations.has(run.id)) await this.backend.closeAcpSession({ context, sessionId: opened.sessionId });
              }
              if (changed) await this.persist(context, run);
            } catch (error) {
              run.status = this.cancellations.has(run.id) ? 'cancelled' : 'failed';
              run.error = error instanceof Error ? error.message : 'ACP review wave failed';
              for (const shard of run.shards) if (shard.state === 'queued') shard.state = 'cancelled';
              await this.persist(context, run).catch(() => undefined);
              await this.stopSessions(context, run).catch(() => undefined);
              if (run.status === 'failed')
                await this.backend
                  .createAttention({
                    workspaceId: context.workspaceId,
                    workspaceGeneration: context.workspaceGeneration,
                    sourceId: `acp-wave:${run.id}`,
                    kind: 'error',
                    revision: 1,
                    target: { kind: 'review', reviewSessionId: run.reviewSessionId },
                  })
                  .catch(() => undefined);
            }
          });
        }
      }
    } finally {
      this.busy = false;
      if (!pendingJobs && this.timer && wakeVersion === this.wakeVersion) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }
  }
}
