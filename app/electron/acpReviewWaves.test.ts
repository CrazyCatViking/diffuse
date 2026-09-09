import { describe, expect, it, vi } from 'vitest';
import { AcpReviewWaves } from './acpReviewWaves';
import { acpSnapshot, adapter } from '../src/test/acpFixture';
import type { CoreBackend } from './coreBackend';
import type { WorkspaceUiStateRecord } from '../src/lib/workbenchContract';
import { reviewWavesStateKey, type ReviewWaveRun } from '../src/lib/acpReviewWaves';
function setup(polling = false) {
  const snapshot = acpSnapshot();
  snapshot.sessions = [];
  snapshot.turnsBySession = {};
  const context = { workspaceId: snapshot.workspaceId, workspaceGeneration: snapshot.workspaceGeneration, requestId: 'waves' };
  let ui: WorkspaceUiStateRecord = { revision: 0, state: {}, updatedAt: '2026-01-01T00:00:00Z' };
  let peak = 0;
  const backend = {
    getWorkspaceSnapshot: vi.fn(async () => ({ summary: snapshot.summary, repository: { root: '/repo', head: 'head' } })),
    getWorkbenchSnapshot: vi.fn(async () => ({
      workspaces: [snapshot.summary],
      workspaceUiState: { [snapshot.workspaceId]: structuredClone(ui) },
    })),
    saveWorkspaceUiState: vi.fn(async (request) => {
      if (request.expectedRevision !== ui.revision) return { outcome: 'stale', record: structuredClone(ui) };
      ui = { revision: ui.revision + 1, state: structuredClone(request.state), updatedAt: ui.updatedAt };
      return { outcome: 'applied', record: structuredClone(ui) };
    }),
    discoverAcpAdapters: vi.fn(async () => [{ adapter, available: true, platformSupported: true }]),
    request: vi.fn(async (context, method) => ({
      context,
      result:
        method === 'listReviewSessions'
          ? [{ id: 'review', target: {} }]
          : method === 'getReviewConfig'
            ? { maxParallelAgents: 2, promptInstructions: 'Check tests' }
            : Array.from({ length: 3000 }, (_, i) => ({ id: `file-${String(i).padStart(4, '0')}`, signature: 'signature'.repeat(100) })),
    })),
    getAcpSnapshot: vi.fn(async () => structuredClone(snapshot)),
    openAcpSession: vi.fn(async (request) => {
      const id = `session-${snapshot.sessions.length}`;
      snapshot.sessions.push({
        ...acpSnapshot().sessions[0],
        id,
        adapterId: adapter.id,
        reviewSessionId: request.reviewSessionId,
        reviewFileIds: request.reviewFileIds,
      });
      snapshot.turnsBySession[id] = [];
      peak = Math.max(peak, snapshot.sessions.filter((s) => s.state !== 'closed').length);
      return { sessionId: id };
    }),
    queueAcpPrompt: vi.fn(async (request) => {
      const turn = {
        id: request.context.requestId,
        sessionId: request.sessionId,
        text: request.text,
        requestId: request.context.requestId,
        state: 'running' as const,
        stopReason: null,
      };
      snapshot.turnsBySession[request.sessionId].push(turn);
      return turn;
    }),
    closeAcpSession: vi.fn(async ({ sessionId }) => {
      snapshot.sessions.find((s) => s.id === sessionId)!.state = 'closed';
      return null;
    }),
    cancelAcpTurn: vi.fn(async () => ({ cancelled: true })),
    createAttention: vi.fn(async () => ({})),
  };
  const scheduler = new AcpReviewWaves(backend as unknown as CoreBackend);
  if (!polling) vi.spyOn(scheduler, 'startPolling').mockImplementation(() => undefined);
  return { backend, scheduler, context, snapshot, peak: () => peak, ui: () => ui };
}
describe('main-owned durable review waves', () => {
  it('cancels every admitted session after its initial cancel snapshot was delayed', async () => {
    const { scheduler, backend, context, snapshot } = setup();
    try {
      const run = await scheduler.start({ context, adapterId: adapter.id, reviewSessionId: 'review' });
      const queuedSnapshot = await backend.getWorkbenchSnapshot();
      const captured = deferred<void>();
      const cancelRead = deferred<typeof queuedSnapshot>();
      backend.getWorkbenchSnapshot.mockImplementationOnce(() => {
        captured.resolve();
        return cancelRead.promise;
      });
      const cancelling = scheduler.cancel({ context, runId: run.id });
      await captured.promise;
      await scheduler.pump();
      await scheduler.pump();
      expect(backend.openAcpSession).toHaveBeenCalledTimes(2);
      expect(backend.queueAcpPrompt).toHaveBeenCalledTimes(2);
      const ids = snapshot.sessions.map((session) => session.id).sort();
      cancelRead.resolve(queuedSnapshot);
      await cancelling;
      const saved = (await scheduler.list(context))[0];
      expect(saved.status).toBe('cancelled');
      expect(saved.shards.flatMap((shard) => (shard.sessionId ? [shard.sessionId] : [])).sort()).toEqual(ids);
      expect(snapshot.sessions.every((session) => session.state === 'closed')).toBe(true);
      expect(backend.closeAcpSession.mock.calls.map(([request]) => request.sessionId).sort()).toEqual(ids);
      await scheduler.pump();
      expect(backend.openAcpSession).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.dispose();
    }
  });

  it('keeps its polling wake when a stale empty pump overlaps a newly persisted start', async () => {
    vi.useFakeTimers();
    const { scheduler, backend, context } = setup(true);
    try {
      const emptySnapshot = await backend.getWorkbenchSnapshot();
      const emptyRead = deferred<typeof emptySnapshot>();
      backend.getWorkbenchSnapshot.mockImplementationOnce(() => emptyRead.promise);
      const pump = vi.spyOn(scheduler, 'pump');
      scheduler.startPolling();
      const oldPump = pump.mock.results[0].value as Promise<void>;
      const run = await scheduler.start({ context, adapterId: adapter.id, reviewSessionId: 'review' });
      expect(backend.openAcpSession).not.toHaveBeenCalled();
      emptyRead.resolve(emptySnapshot);
      await oldPump;
      await vi.advanceTimersByTimeAsync(250);
      expect(backend.openAcpSession).toHaveBeenCalledTimes(2);
      await scheduler.cancel({ context, runId: run.id });
      await vi.advanceTimersByTimeAsync(250);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      scheduler.dispose();
      vi.useRealTimers();
    }
  });

  it('rebases cancellation on the latest run after a CAS conflict without dropping new IDs', async () => {
    const { scheduler, backend, context, snapshot, ui } = setup();
    try {
      const run = await scheduler.start({ context, adapterId: adapter.id, reviewSessionId: 'review' });
      const save = backend.saveWorkspaceUiState.getMockImplementation()!;
      backend.saveWorkspaceUiState.mockImplementationOnce(async (request) => {
        const latest = structuredClone((ui().state[reviewWavesStateKey] as ReviewWaveRun[])[0]);
        const opened = await backend.openAcpSession({
          context,
          adapterId: adapter.id,
          reviewSessionId: latest.reviewSessionId,
          reviewFileIds: latest.shards[0].fileIds,
          interactive: false,
        });
        latest.shards[0].sessionId = opened.sessionId;
        latest.shards[0].state = 'starting';
        await save({ ...request, expectedRevision: ui().revision, state: { logicalFocus: 'newer-ui', [reviewWavesStateKey]: [latest] } });
        return save(request);
      });
      await scheduler.cancel({ context, runId: run.id });
      expect((await scheduler.list(context))[0].shards[0].sessionId).toBe(snapshot.sessions[0].id);
      expect(snapshot.sessions[0].state).toBe('closed');
      expect(ui().state.logicalFocus).toBe('newer-ui');
      expect(backend.saveWorkspaceUiState).toHaveBeenCalledTimes(3);
    } finally {
      scheduler.dispose();
    }
  });

  it('cancels a session returned after cancellation and never launches the remaining waves', async () => {
    const { scheduler, backend, context, snapshot } = setup();
    const run = await scheduler.start({ context, adapterId: adapter.id, reviewSessionId: 'review' });
    const create = backend.openAcpSession.getMockImplementation()!;
    let finish!: () => void;
    backend.openAcpSession.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          finish = async () => resolve(await create(request));
        }),
    );
    const pumping = scheduler.pump();
    await vi.waitFor(() => expect(backend.openAcpSession).toHaveBeenCalledOnce());
    const cancelling = scheduler.cancel({ context, runId: run.id });
    finish();
    await Promise.all([pumping, cancelling]);
    await scheduler.pump();
    expect(backend.openAcpSession).toHaveBeenCalledOnce();
    expect(snapshot.sessions[0].state).toBe('closed');
    expect((await scheduler.list(context))[0].status).toBe('cancelled');
    scheduler.dispose();
  });

  it('records failed recovery rather than pretending interrupted turns completed', async () => {
    const { scheduler, backend, context, snapshot } = setup();
    await scheduler.start({ context, adapterId: adapter.id, reviewSessionId: 'review' });
    await scheduler.pump();
    await scheduler.pump();
    scheduler.dispose();
    for (const session of snapshot.sessions) session.state = 'failed';
    const recovered = new AcpReviewWaves(backend as unknown as CoreBackend);
    await recovered.pump();
    expect((await recovered.list(context))[0].status).toBe('failed');
    expect(backend.createAttention).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: context.workspaceId, kind: 'error', target: { kind: 'review', reviewSessionId: 'review' } }),
    );
    expect(backend.openAcpSession).toHaveBeenCalledTimes(2);
    const failed = (await recovered.list(context))[0];
    await recovered.cancel({ context, runId: failed.id });
    expect(backend.createAttention).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceId: `acp-wave:${failed.id}`, revision: 2, status: 'resolved' }),
    );
    recovered.dispose();
  });
  it('honors parallelism across waves and continues without a renderer', async () => {
    const { scheduler, backend, context, snapshot, peak, ui } = setup();
    const run = await scheduler.start({ context, adapterId: adapter.id, reviewSessionId: 'review' });
    expect(run.shards).toHaveLength(4);
    for (let i = 0; i < 10; i++) {
      await scheduler.pump();
      for (const turns of Object.values(snapshot.turnsBySession)) for (const turn of turns) turn.state = 'completed';
    }
    expect(backend.openAcpSession).toHaveBeenCalledTimes(4);
    expect(peak()).toBe(2);
    expect((await scheduler.list(context))[0].status).toBe('completed');
    expect(JSON.stringify(ui().state)).not.toContain('signature'.repeat(100));
    expect(backend.queueAcpPrompt.mock.calls.every(([request]) => request.text.length < 2048)).toBe(true);
    scheduler.dispose();
  });
  it('persists cancellation and protects plans against renderer UI saves', async () => {
    const { scheduler, backend, context, ui } = setup();
    const run = await scheduler.start({ context, adapterId: adapter.id, reviewSessionId: 'review' });
    await scheduler.pump();
    await scheduler.saveRendererUi({
      workspaceId: context.workspaceId,
      workspaceGeneration: context.workspaceGeneration,
      expectedRevision: ui().revision,
      state: { logicalFocus: 'input', [reviewWavesStateKey]: [] },
    });
    expect(await scheduler.list(context)).toHaveLength(1);
    await expect(scheduler.closeWorkspace(context, false)).rejects.toThrow('WorkspaceHasActiveReview');
    await scheduler.cancel({ context, runId: run.id });
    await scheduler.pump();
    expect(backend.openAcpSession).toHaveBeenCalledTimes(2);
    expect((await scheduler.list(context))[0].status).toBe('cancelled');
    expect(backend.closeAcpSession).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
  it('restores queued waves from SQLite-backed records after scheduler recreation', async () => {
    const { scheduler, backend, context, snapshot } = setup();
    await scheduler.start({ context, adapterId: adapter.id, reviewSessionId: 'review' });
    await scheduler.pump();
    await scheduler.pump();
    for (const turns of Object.values(snapshot.turnsBySession)) for (const turn of turns) turn.state = 'completed';
    await scheduler.pump();
    scheduler.dispose();
    const restored = new AcpReviewWaves(backend as unknown as CoreBackend);
    await restored.pump();
    expect(backend.openAcpSession).toHaveBeenCalledTimes(4);
    restored.dispose();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
