// @vitest-environment happy-dom
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockDesktopBridge } from '../test/mockDesktopBridge';
import { acpSnapshot, adapter } from '../test/acpFixture';
import type { AcpHistory } from '../lib/acpContract';
import type { ReviewSession, ReviewThread, ChangedFile } from '../lib/protocol';
import { setActiveWorkspace } from '../lib/useClient';
import { useWorkbenchStore } from './workbench';
import { useRepoStore } from './repo';
import { useReviewStore } from './review';
import { useReviewAcpStore } from './reviewAcp';
const reviewSession: ReviewSession = {
  id: 'review-a',
  repositoryRoot: '/repo',
  headAtCreation: 'head',
  target: { base: 'HEAD', includeStaged: true, includeUnstaged: true },
  title: 'Review',
  status: 'active',
  participants: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const thread: ReviewThread = {
  id: 'thread-a',
  sessionId: reviewSession.id,
  fileId: 'file-a',
  anchor: { side: 'new', startLine: 3, endLine: 5, diffTargetFingerprint: 'target', selectedText: 'selected code' },
  status: 'open',
  createdAt: reviewSession.createdAt,
  updatedAt: reviewSession.updatedAt,
  messages: [{ id: 'message', authorId: 'local-human', body: 'Previous discussion', createdAt: reviewSession.createdAt }],
};
afterEach(() => setActiveWorkspace(undefined));
async function setup() {
  setActivePinia(createPinia());
  window.localStorage.clear();
  const bridge = createMockDesktopBridge();
  window.diffuse = bridge;
  const configuration = {
    provider: 'opencode',
    maxParallelAgents: 1,
    promptInstructions: 'Check tests',
    model: 'legacy/model',
    agent: 'legacy-agent',
  };
  const files: ChangedFile[] = [];
  bridge.workspaceRequest.mockImplementation(
    async (context, method) =>
      ({
        context,
        result:
          method === 'getReviewConfig'
            ? configuration
            : method === 'listChangedFiles'
              ? files.length
                ? files
                : [{ id: 'file-a', signature: 'sig', status: 'modified', additions: 1, deletions: 0 }]
              : [],
      }) as never,
  );
  const snapshot = acpSnapshot();
  snapshot.sessions = [];
  snapshot.turnsBySession = {};
  const histories: Record<string, AcpHistory[]> = {};
  bridge.discoverAcpAdapters.mockResolvedValue([{ adapter, available: true, platformSupported: true }]);
  bridge.getAcpSnapshot.mockImplementation(async () => structuredClone(snapshot));
  bridge.getAcpHistory.mockImplementation(async ({ sessionId, after }) =>
    (histories[sessionId] ?? []).filter((h) => h.sequence > (after ?? 0)),
  );
  bridge.getAcpActivity.mockResolvedValue([]);
  bridge.openAcpSession.mockImplementation(async (request) => {
    if (request.sessionId) {
      const existing = snapshot.sessions.find((s) => s.id === request.sessionId);
      if (!existing) throw new Error('Unknown session: supplied IDs are reconnect-only');
      if (
        request.reviewFileIds &&
        JSON.stringify([...request.reviewFileIds].sort()) !== JSON.stringify([...(existing.reviewFileIds ?? [])].sort())
      )
        throw new Error('Immutable file scope');
      existing.state = 'ready';
      return { sessionId: existing.id };
    }
    const session = {
      ...acpSnapshot().sessions[0],
      id: crypto.randomUUID(),
      reviewSessionId: request.reviewSessionId!,
      permissionPolicy: 'deny-all',
      ...(request.reviewFileIds ? { reviewFileIds: [...request.reviewFileIds].sort() } : {}),
    };
    snapshot.sessions.push(session);
    snapshot.turnsBySession[session.id] = [];
    return { sessionId: session.id };
  });
  bridge.queueAcpPrompt.mockImplementation(async (request) => {
    const turns = snapshot.turnsBySession[request.sessionId];
    const existing = turns.find((t) => t.requestId === request.context.requestId);
    if (existing) return existing;
    const turn = {
      id: `turn-${turns.length}`,
      sessionId: request.sessionId,
      requestId: request.context.requestId,
      text: request.text,
      state: 'completed' as const,
      stopReason: 'end_turn',
    };
    turns.push(turn);
    const history = (histories[request.sessionId] ??= []);
    history.push({
      sessionId: request.sessionId,
      turnId: turn.id,
      sequence: history.length + 1,
      kind: 'user-message',
      content: { text: request.text },
    });
    history.push({
      sessionId: request.sessionId,
      turnId: turn.id,
      sequence: history.length + 1,
      kind: 'agent-message',
      content: { content: { type: 'text', text: 'Scoped answer' } },
    });
    return turn;
  });
  bridge.closeAcpSession.mockImplementation(async ({ sessionId }) => {
    snapshot.sessions.find((s) => s.id === sessionId)!.state = 'closed';
    return null;
  });
  const workbench = useWorkbenchStore();
  workbench.workspaces = [snapshot.summary];
  workbench.activeWorkspaceId = snapshot.workspaceId;
  setActiveWorkspace(snapshot.summary);
  useRepoStore().$patch({ workspace: snapshot.summary, repository: { root: '/repo', head: 'head' } });
  const review = useReviewStore();
  review.session = reviewSession;
  review.agentAdapter = 'acp:fixture';
  await flushPromises();
  return { bridge, snapshot, histories, workbench, review, configuration, files };
}
describe('ACP review and inline parity', () => {
  it('bounds a 300-file prompt and rejects oversized instructions before spawning any session', async () => {
    const { review, bridge, files, configuration } = await setup();
    files.push(
      ...Array.from({ length: 300 }, (_, index) => ({
        id: `file-${index}`,
        signature: 'large-signature'.repeat(1000),
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
      })),
    );
    expect(await review.startAgentReview()).toBe(true);
    expect(bridge.openAcpSession.mock.calls[0][0].reviewFileIds).toHaveLength(300);
    expect(bridge.queueAcpPrompt.mock.calls[0][0].text.length).toBeLessThan(2048);
    expect(bridge.queueAcpPrompt.mock.calls[0][0].text).not.toContain('large-signature');
    bridge.openAcpSession.mockClear();
    configuration.promptInstructions = 'x'.repeat(32 * 1024);
    expect(await review.startAgentReview()).toBe(false);
    expect(bridge.openAcpSession).not.toHaveBeenCalled();
    expect(review.error).toContain('Shorten repository promptInstructions');
  });

  it('hands scopes beyond one concurrent wave to main rather than spawning all sessions in the renderer', async () => {
    const { review, bridge, files, configuration, snapshot } = await setup();
    configuration.maxParallelAgents = 2;
    files.push(
      ...Array.from({ length: 3000 }, (_, index) => ({
        id: `file-${index}`,
        signature: 'sig',
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
      })),
    );
    const run = {
      id: 'main-run',
      workspaceId: snapshot.workspaceId,
      workspaceGeneration: snapshot.workspaceGeneration,
      reviewSessionId: reviewSession.id,
      adapterId: 'fixture',
      createdAt: reviewSession.createdAt,
      prompt: 'Review scoped files',
      parallel: 2,
      status: 'running' as const,
      shards: Array.from({ length: 4 }, (_, i) => ({ fileIds: [`file-${i}`], requestId: `request-${i}`, state: 'queued' as const })),
    };
    bridge.startAcpReviewWaves.mockResolvedValue(run);
    bridge.getAcpReviewWaves.mockResolvedValue([run]);
    expect(await review.startAgentReview()).toBe(true);
    expect(bridge.startAcpReviewWaves).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: 'fixture',
        reviewSessionId: reviewSession.id,
        context: expect.objectContaining({ workspaceId: snapshot.workspaceId }),
      }),
    );
    expect(bridge.openAcpSession).not.toHaveBeenCalled();
    expect(review.acpReview.runGroups[0]).toMatchObject({ id: 'main-run', total: 4, status: 'running' });
    await review.stopAgentReview();
    expect(bridge.cancelAcpReviewWaves).toHaveBeenCalledWith(expect.objectContaining({ runId: 'main-run' }));
  });

  it('requires explicit adapter migration instead of executing persisted legacy selection or overrides', async () => {
    const { review, bridge, workbench, snapshot } = await setup();
    workbench.saveUiState(snapshot.workspaceId, { ...workbench.uiState(snapshot.workspaceId), reviewAgentAdapter: 'legacy' });
    expect(review.agentAdapter).toBe('');
    expect(await review.startAgentReview()).toBe(false);
    expect(bridge.openAcpSession).not.toHaveBeenCalled();
    expect('startReviewAgent' in bridge).toBe(false);
  });
  it('partitions the saved review target by maxParallelAgents with grouped status and cancellation', async () => {
    const { review, bridge, snapshot, configuration, files } = await setup();
    configuration.maxParallelAgents = 3;
    files.push(
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `file-${i}`,
        signature: `sig-${i}`,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
      })),
    );
    expect(await review.startAgentReview()).toBe(true);
    const prompts = bridge.queueAcpPrompt.mock.calls.map(([request]) => JSON.parse(request.text));
    expect(prompts).toHaveLength(3);
    const scopes = bridge.openAcpSession.mock.calls.map(([request]) => request.reviewFileIds!);
    expect(scopes.map((ids) => ids.length)).toEqual([3, 2, 2]);
    expect(scopes.flat().sort()).toEqual(files.map((f) => f.id).sort());
    expect(
      prompts.every(
        (p) =>
          p.files === undefined && p.instruction.includes('listChangedFiles') && p.instruction.includes('Core merges this shard progress'),
      ),
    ).toBe(true);
    expect(bridge.workspaceRequest).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: snapshot.workspaceId, workspaceGeneration: snapshot.workspaceGeneration }),
      'listChangedFiles',
      { target: reviewSession.target },
    );
    expect(
      bridge.openAcpSession.mock.calls.every(
        ([request]) => request.adapterId === 'fixture' && request.sessionId === undefined && request.interactive === false,
      ),
    ).toBe(true);
    expect(review.acpReview.runGroups[0]).toMatchObject({ total: 3, completed: 3, fileCount: 7, status: 'completed' });
    await review.stopAgentReview(snapshot.sessions[0].id);
    expect(new Set(bridge.closeAcpSession.mock.calls.map(([request]) => request.sessionId))).toEqual(
      new Set(snapshot.sessions.map((s) => s.id)),
    );
  });

  it('closes siblings after a shard admission failure', async () => {
    const { review, bridge, snapshot, configuration, files } = await setup();
    configuration.maxParallelAgents = 2;
    files.push(
      ...Array.from({ length: 2 }, (_, i) => ({
        id: `file-${i}`,
        signature: 'sig',
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
      })),
    );
    const admit = bridge.queueAcpPrompt.getMockImplementation()!;
    bridge.queueAcpPrompt.mockImplementationOnce(admit).mockRejectedValueOnce(new Error('Shard admission failed'));
    expect(await review.startAgentReview()).toBe(false);
    expect(snapshot.sessions.length).toBeGreaterThan(0);
    expect(snapshot.sessions.every((s) => s.state === 'closed')).toBe(true);
    expect(review.error).toContain('Shard admission failed');
    expect(review.acpReview.runGroups[0].status).toBe('failed');
  });

  it('cancels durable shard queues even when a restored failed session has no live handle', async () => {
    const { review, bridge, snapshot, configuration, files } = await setup();
    configuration.maxParallelAgents = 2;
    files.push(
      ...Array.from({ length: 2 }, (_, i) => ({
        id: `file-${i}`,
        signature: 'sig',
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
      })),
    );
    await review.startAgentReview();
    snapshot.sessions[0].state = 'failed';
    for (const turns of Object.values(snapshot.turnsBySession)) turns[0].state = 'queued';
    bridge.cancelAcpTurn.mockImplementation(async ({ sessionId, turnId }) => {
      snapshot.turnsBySession[sessionId].find((turn) => turn.id === turnId)!.state = 'cancelled';
      return { cancelled: true };
    });
    await review.acpReview.stopReviews();
    expect(bridge.cancelAcpTurn).toHaveBeenCalledTimes(2);
    expect(bridge.closeAcpSession).toHaveBeenCalledTimes(1);
    expect(bridge.closeAcpSession.mock.calls[0][0].sessionId).toBe(snapshot.sessions[1].id);
    expect(review.acpReview.hasActiveReview).toBe(false);
  });

  it('cancels sessions whose open responses arrive after Stop all shards', async () => {
    const { review, bridge, snapshot, configuration, files } = await setup();
    configuration.maxParallelAgents = 2;
    files.push(
      ...Array.from({ length: 2 }, (_, i) => ({
        id: `file-${i}`,
        signature: 'sig',
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
      })),
    );
    const create = bridge.openAcpSession.getMockImplementation()!;
    const finish: Array<() => void> = [];
    bridge.openAcpSession.mockImplementation(
      (request) => new Promise((resolve) => finish.push(async () => resolve(await create(request)))),
    );
    const starting = review.startAgentReview();
    await vi.waitFor(() => expect(bridge.openAcpSession).toHaveBeenCalledTimes(2));
    expect(review.acpReview.hasActiveReview).toBe(true);
    await review.acpReview.stopReviews();
    finish.forEach((complete) => complete());
    expect(await starting).toBe(false);
    expect(bridge.queueAcpPrompt).not.toHaveBeenCalled();
    expect(snapshot.sessions.every((s) => s.state === 'closed')).toBe(true);
  });

  it('uses core-assigned IDs on first chat creation and supplies only that saved ID on reconnect', async () => {
    const { review, bridge, snapshot } = await setup();
    expect(await review.askAgentInThread(thread, 'First question')).toBe(true);
    const sessionId = snapshot.sessions[0].id;
    expect(bridge.openAcpSession.mock.calls[0][0]).not.toHaveProperty('sessionId');
    await review.acpReview.stop(sessionId);
    expect(await review.askAgentInThread(thread, 'Follow up')).toBe(true);
    expect(bridge.openAcpSession.mock.calls[1][0].sessionId).toBe(sessionId);
    await expect(
      bridge.openAcpSession({
        context: { workspaceId: snapshot.workspaceId, workspaceGeneration: snapshot.workspaceGeneration, requestId: 'bad' },
        adapterId: 'fixture',
        sessionId: 'not-a-core-id',
      }),
    ).rejects.toThrow('reconnect-only');
  });

  it('waits for authoritative startup readiness before admitting the first prompt', async () => {
    const { review, bridge, snapshot } = await setup();
    const create = bridge.openAcpSession.getMockImplementation()!;
    bridge.openAcpSession.mockImplementation(async (request) => {
      const opened = await create(request);
      snapshot.sessions.find((s) => s.id === opened.sessionId)!.state = 'starting';
      return opened;
    });
    const starting = review.askAgentInThread(thread, 'Wait for readiness');
    await vi.waitFor(() => expect(bridge.openAcpSession).toHaveBeenCalledOnce());
    expect(bridge.queueAcpPrompt).not.toHaveBeenCalled();
    snapshot.sessions[0].state = 'ready';
    expect(await starting).toBe(true);
    expect(bridge.queueAcpPrompt).toHaveBeenCalledOnce();
  });

  it('does not confuse the old closed snapshot with a failed reconnect', async () => {
    const { review, bridge, snapshot } = await setup();
    await review.askAgentInThread(thread, 'First question');
    await review.acpReview.stop(snapshot.sessions[0].id);
    const old = structuredClone(snapshot);
    const reconnect = bridge.openAcpSession.getMockImplementation()!;
    bridge.openAcpSession.mockImplementationOnce(async (request) => {
      const result = await reconnect(request);
      bridge.getAcpSnapshot.mockResolvedValueOnce(old);
      return result;
    });
    expect(await review.askAgentInThread(thread, 'After reconnect')).toBe(true);
    expect(bridge.readAcpEvents).toHaveBeenCalledWith({ afterSequence: old.sequence });
  });

  it('repairs an old client-generated chat binding that never existed in core', async () => {
    const { review, bridge, workbench, snapshot } = await setup();
    workbench.saveUiState(snapshot.workspaceId, {
      ...workbench.uiState(snapshot.workspaceId),
      reviewAcpBindings: {
        'old-client-id': {
          sessionId: 'old-client-id',
          adapterId: 'fixture',
          reviewSessionId: reviewSession.id,
          kind: 'chat',
          createdAt: reviewSession.createdAt,
          context: { fileId: thread.fileId, selection: thread.anchor, threadIds: [thread.id] },
        },
      },
    });
    expect(await review.askAgentInThread(thread, 'Retry after upgrade')).toBe(true);
    expect(bridge.openAcpSession.mock.calls[0][0]).not.toHaveProperty('sessionId');
    expect(Object.keys(workbench.uiState(snapshot.workspaceId).reviewAcpBindings ?? {})).toEqual([snapshot.sessions[0].id]);
  });
  it('keeps a late inline reply in its background workspace without clearing the new workspace draft', async () => {
    const { review, bridge, workbench, snapshot } = await setup();
    const admit = bridge.queueAcpPrompt.getMockImplementation()!;
    let finish!: () => void;
    bridge.queueAcpPrompt.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          finish = async () => resolve(await admit(request));
        }),
    );
    const pending = review.askAgentInThread(thread, 'Background question');
    await vi.waitFor(() => expect(bridge.queueAcpPrompt).toHaveBeenCalledOnce());
    const second = acpSnapshot('workspace-b', 'generation-b');
    second.sessions = [];
    second.turnsBySession = {};
    workbench.workspaces.push(second.summary);
    bridge.getAcpSnapshot.mockImplementation(async (c) => structuredClone(c.workspaceId === second.workspaceId ? second : snapshot));
    setActiveWorkspace(second.summary);
    workbench.activeWorkspaceId = second.workspaceId;
    review.clear();
    review.session = { ...reviewSession, repositoryRoot: '/repo/b' };
    review.draftBody = 'Keep this draft';
    await flushPromises();
    finish();
    expect(await pending).toBe(false);
    await flushPromises();
    expect(review.chatMessages).toEqual([]);
    expect(review.draftBody).toBe('Keep this draft');
    expect(Object.values(workbench.uiState(snapshot.workspaceId).reviewAcpBindings ?? {})).toHaveLength(1);
    await expect(review.acpReview.stop(snapshot.sessions[0].id)).rejects.toThrow('outside this review');
  });

  it('requires explicit selection and binds review start/stop to the exact deny-all session', async () => {
    const { review, bridge, snapshot } = await setup();
    review.agentAdapter = '';
    expect(await review.startAgentReview()).toBe(false);
    expect(bridge.openAcpSession).not.toHaveBeenCalled();
    review.agentAdapter = 'acp:fixture';
    expect(await review.startAgentReview()).toBe(true);
    const opened = bridge.openAcpSession.mock.calls[0][0];
    expect(opened).toMatchObject({
      reviewSessionId: 'review-a',
      adapterId: 'fixture',
      interactive: false,
      context: { workspaceId: 'workspace-a', workspaceGeneration: 'generation-a' },
    });
    expect(bridge.queueAcpPrompt.mock.calls[0][0].text).toContain('readDiff');
    expect(opened).not.toHaveProperty('sessionId');
    await review.stopAgentReview(snapshot.sessions[0].id);
    expect(bridge.closeAcpSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: snapshot.sessions[0].id, context: expect.objectContaining({ workspaceId: 'workspace-a' }) }),
    );
    expect('startReviewAgent' in bridge).toBe(false);
  });
  it('projects thread and selection chat from core history without portable transcript writes', async () => {
    const { review, bridge, workbench, snapshot } = await setup();
    expect(await review.askAgentInThread(thread, 'Why this line?')).toBe(true);
    await flushPromises();
    const prompt = JSON.parse(bridge.queueAcpPrompt.mock.calls[0][0].text);
    expect(prompt).toMatchObject({
      reviewSessionId: 'review-a',
      fileId: 'file-a',
      anchor: thread.anchor,
      discussion: thread.messages,
      question: 'Why this line?',
    });
    expect(review.chatMessages.map((m) => m.body)).toEqual(['Why this line?', 'Scoped answer']);
    expect(review.chatMessages.every((m) => m.context?.threadIds?.[0] === thread.id)).toBe(true);
    expect(bridge.workspaceRequest.mock.calls.some((call) => call[1] === 'saveReviewChatMessage')).toBe(false);
    review.startDraft({ id: 'file-a', signature: 's', status: 'modified', additions: 1, deletions: 0 }, thread.anchor, 'chat');
    review.draftBody = 'Selection question';
    expect(await review.askAgentAtDraft('Selection question')).toBe(true);
    expect(review.chatMessages.some((m) => m.context?.threadIds?.[0].startsWith('chat:file-a:'))).toBe(true);
    expect(bridge.openAcpSession).toHaveBeenCalledTimes(2);
    const saved = structuredClone(JSON.parse(JSON.stringify(workbench.uiState(snapshot.workspaceId))));
    setActivePinia(createPinia());
    const restored = useWorkbenchStore();
    restored.workspaces = [snapshot.summary];
    restored.activeWorkspaceId = snapshot.workspaceId;
    restored.saveUiState(snapshot.workspaceId, saved);
    const projection = useReviewAcpStore();
    await projection.activate(snapshot.summary, reviewSession.id);
    await flushPromises();
    expect(projection.messages.some((m) => m.body === 'Scoped answer')).toBe(true);
    expect(projection.messages.some((m) => m.body === 'Why this line?')).toBe(true);
    expect(bridge.openAcpSession).toHaveBeenCalledTimes(2);
  });
  it('does not reuse a session for another review or thread and clears history on review navigation', async () => {
    const { review, bridge, snapshot } = await setup();
    expect(await review.askAgentInThread({ ...thread, sessionId: 'foreign' }, 'Wrong review')).toBe(false);
    expect(bridge.openAcpSession).not.toHaveBeenCalled();
    await review.askAgentInThread(thread, 'First');
    await review.askAgentInThread({ ...thread, id: 'thread-b' }, 'Second');
    expect(bridge.openAcpSession).toHaveBeenCalledTimes(2);
    await review.acpReview.activate(snapshot.summary, 'review-b');
    expect(review.acpReview.messages).toEqual([]);
    await expect(review.acpReview.stop(snapshot.sessions[0].id)).rejects.toThrow('outside this review');
  });
});
