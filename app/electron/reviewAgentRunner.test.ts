import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const createOpencodeMock = vi.hoisted(() => vi.fn());

vi.mock('@opencode-ai/sdk', () => ({ createOpencode: createOpencodeMock }));

import { ReviewAgentRunner } from './reviewAgentRunner';
import { assertLegacyReviewAllowsClose, closeWorkspaceWithLegacyReviewAgent } from './legacyReviewAgentLifecycle';

describe('ReviewAgentRunner lifecycle', () => {
  const roots: string[] = [];

  afterEach(async () => {
    createOpencodeMock.mockReset();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('persists terminal cancellation state before stop returns', async () => {
    const root = await temporaryRepository();
    const opencode = fakeOpencode('opencode-session-1');
    createOpencodeMock.mockResolvedValue(opencode.value);
    const { request, calls } = coreRequest(1);
    const terminal = vi.fn();
    const runner = new ReviewAgentRunner(request, terminal);

    await runner.start({ repositoryRoot: root, sessionId: 'review-session', files: [changedFile('first.ts')] });
    await expect(runner.stop()).resolves.toEqual({ running: false });

    expect(opencode.abort).toHaveBeenCalledOnce();
    expect(opencode.close).toHaveBeenCalledOnce();
    expect(terminal).not.toHaveBeenCalled();
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'finishReviewRun',
          params: expect.objectContaining({ run: expect.objectContaining({ status: 'cancelled' }) }),
        }),
        expect.objectContaining({
          method: 'saveReviewAgentState',
          params: expect.objectContaining({ agent: expect.objectContaining({ status: 'cancelled' }) }),
        }),
        expect.objectContaining({
          method: 'saveReviewProgress',
          params: expect.objectContaining({ progress: expect.objectContaining({ status: 'cancelled' }) }),
        }),
      ]),
    );
  });

  it('cancels every started shard when a parallel shard fails to start', async () => {
    const root = await temporaryRepository();
    const started = fakeOpencode('opencode-session-started');
    createOpencodeMock.mockResolvedValueOnce(started.value).mockRejectedValueOnce(new Error('second shard failed'));
    const { request, calls } = coreRequest(2);
    const terminal = vi.fn();
    const runner = new ReviewAgentRunner(request, terminal);

    await expect(
      runner.start({
        repositoryRoot: root,
        sessionId: 'review-session',
        files: [changedFile('first.ts'), changedFile('second.ts')],
      }),
    ).rejects.toThrow('second shard failed');

    expect(runner.status()).toEqual({ running: false });
    expect(started.abort).toHaveBeenCalledOnce();
    expect(started.close).toHaveBeenCalledOnce();
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'finishReviewRun',
          params: expect.objectContaining({ run: expect.objectContaining({ status: 'cancelled' }) }),
        }),
        expect.objectContaining({
          method: 'finishReviewRun',
          params: expect.objectContaining({ run: expect.objectContaining({ status: 'failed' }) }),
        }),
      ]),
    );
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'review-session', status: 'failed', message: 'second shard failed' }),
    );
  });

  it('reports completion after persistence and contains callback failures', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const root = await temporaryRepository();
      const opencode = fakeOpencode('opencode-session-complete', 'idle');
      createOpencodeMock.mockResolvedValue(opencode.value);
      const { request, calls } = coreRequest(1);
      const terminal = vi.fn(async () => {
        throw new Error('attention unavailable');
      });
      const runner = new ReviewAgentRunner(request, terminal);

      await runner.start({ repositoryRoot: root, sessionId: 'review-session', files: [changedFile('first.ts')] });
      await vi.advanceTimersByTimeAsync(4_000);

      expect(runner.status()).toEqual({ running: false });
      expect(terminal).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'review-session', status: 'completed', message: 'Review completed' }),
      );
      expect(calls.at(-1)).toMatchObject({ method: 'saveReviewProgress', params: { progress: { status: 'completed' } } });
      expect(consoleError).toHaveBeenCalledWith('Review terminal callback failed:', expect.any(Error));
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it.each(['saveReviewAgentState', 'saveReviewProgress'])(
    'reports completion when %s fails after the terminal run save',
    async (method) => {
      vi.useFakeTimers();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const root = await temporaryRepository();
        const opencode = fakeOpencode('opencode-session-complete', 'idle');
        createOpencodeMock.mockResolvedValue(opencode.value);
        const { request, calls } = coreRequest(1, (candidate, params) => candidate === method && terminalStatus(params) === 'completed');
        const terminal = vi.fn(async () => undefined);
        const runner = new ReviewAgentRunner(request, terminal);

        await runner.start({ repositoryRoot: root, sessionId: 'review-session', files: [changedFile('first.ts')] });
        await vi.advanceTimersByTimeAsync(4_000);

        expect(calls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              method: 'finishReviewRun',
              params: expect.objectContaining({ run: expect.objectContaining({ status: 'completed' }) }),
            }),
          ]),
        );
        expect(terminal).toHaveBeenCalledOnce();
        expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
        expect(consoleError).toHaveBeenCalledWith('Review terminal ancillary persistence failed:', expect.any(Error));
      } finally {
        vi.useRealTimers();
        consoleError.mockRestore();
      }
    },
  );

  it('preserves a startup error while reporting terminal attention after ancillary failure', async () => {
    const root = await temporaryRepository();
    const startupFailure = new Error('opencode startup failed');
    createOpencodeMock.mockRejectedValue(startupFailure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { request } = coreRequest(1, (method, params) => method === 'saveReviewAgentState' && terminalStatus(params) === 'failed');
      const terminal = vi.fn(async () => undefined);
      const runner = new ReviewAgentRunner(request, terminal);

      await expect(runner.start({ repositoryRoot: root, sessionId: 'review-session', files: [changedFile('first.ts')] })).rejects.toBe(
        startupFailure,
      );
      expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', message: startupFailure.message }));
      expect(consoleError).toHaveBeenCalledWith('Review terminal ancillary persistence failed:', expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('tracks config-pending startup, blocks ordinary close, and drains before forced close', async () => {
    const config = deferred<ReturnType<typeof reviewConfig>>();
    const request = vi.fn(async (method: string) => {
      if (method === 'getReviewConfig') return await config.promise;
      return {};
    });
    const runner = new ReviewAgentRunner(request as never);
    const startRequest = { repositoryRoot: '/repo', sessionId: 'review-session', files: [changedFile('first.ts')] };

    const starting = runner.start(startRequest);
    expect(runner.status()).toMatchObject({ running: true, status: 'running' });
    expect(() =>
      assertLegacyReviewAllowsClose(
        { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1', force: false },
        { context: { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' }, runner },
      ),
    ).toThrow(expect.objectContaining({ code: 'WorkspaceHasActiveReview' }));
    await expect(runner.start(startRequest)).resolves.toMatchObject({ running: true });
    expect(request).toHaveBeenCalledTimes(1);

    const closeWorkspace = vi.fn(async () => 'closed');
    const closing = closeWorkspaceWithLegacyReviewAgent(
      { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1', force: true },
      { context: { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' }, runner },
      closeWorkspace,
    );
    expect(runner.status()).toMatchObject({ running: true, status: 'stopping' });
    expect(closeWorkspace).not.toHaveBeenCalled();
    config.resolve(reviewConfig());

    await expect(starting).rejects.toThrow('Review run stopped because the workspace was closed');
    await expect(closing).resolves.toBe('closed');
    expect(closeWorkspace).toHaveBeenCalledOnce();
    expect(createOpencodeMock).not.toHaveBeenCalled();
    expect(runner.status()).toEqual({ running: false });
  });

  it('waits for delayed review session creation, then aborts without prompting', async () => {
    const root = await temporaryRepository();
    const created = deferred<{ data: { id: string } }>();
    const abort = vi.fn(async () => ({}));
    const close = vi.fn();
    const promptAsync = vi.fn(async () => ({}));
    createOpencodeMock.mockResolvedValue({
      client: {
        session: {
          create: vi.fn(() => created.promise),
          promptAsync,
          abort,
          status: vi.fn(),
        },
      },
      server: { close },
    });
    const { request, calls } = coreRequest(1);
    const runner = new ReviewAgentRunner(request);
    const starting = runner.start({ repositoryRoot: root, sessionId: 'review-session', files: [changedFile('first.ts')] });
    await vi.waitFor(() => expect(createOpencodeMock).toHaveBeenCalledOnce());

    let stopSettled = false;
    const stopping = runner.stop().finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    created.resolve({ data: { id: 'delayed-session' } });

    await expect(starting).rejects.toThrow('Review run stopped because the workspace was closed');
    await expect(stopping).resolves.toEqual({ running: false });
    expect(abort).toHaveBeenCalledOnce();
    expect(promptAsync).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(calls.filter((call) => call.method === 'finishReviewRun').at(-1)).toMatchObject({
      params: { run: { status: 'cancelled' } },
    });
  });

  it('drains an admitted bridge mutation before persisting cancellation', async () => {
    const root = await temporaryRepository();
    const opencode = fakeOpencode('bridge-session');
    createOpencodeMock.mockResolvedValue(opencode.value);
    const admitted = deferred<void>();
    const release = deferred<void>();
    const order: string[] = [];
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const request = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === 'getReviewConfig') return reviewConfig() as T;
      if (method === 'saveReviewProgress' && (params?.progress as { message?: unknown } | undefined)?.message === 'deferred bridge write') {
        order.push('bridge-admitted');
        admitted.resolve();
        await release.promise;
        order.push('bridge-settled');
      }
      const status = terminalStatus(params);
      if (status === 'cancelling' || status === 'cancelled') order.push(String(status));
      return params as T;
    };
    const runner = new ReviewAgentRunner(request);
    await runner.start({ repositoryRoot: root, sessionId: 'review-session', files: [changedFile('first.ts')] });

    const bridgeRequest = fetch(`${process.env.DIFFUSE_REVIEW_BRIDGE_URL}/set-progress`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.DIFFUSE_REVIEW_BRIDGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'running', message: 'deferred bridge write' }),
    });
    await admitted.promise;

    let stopSettled = false;
    const stopping = runner.stop().finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(order).toEqual(['bridge-admitted']);
    expect(calls.some((call) => terminalStatus(call.params) === 'cancelled')).toBe(false);

    release.resolve();
    await expect(bridgeRequest).resolves.toMatchObject({ status: 200 });
    await expect(stopping).resolves.toEqual({ running: false });

    expect(order.indexOf('bridge-settled')).toBeLessThan(order.indexOf('cancelling'));
    expect(order.indexOf('cancelling')).toBeLessThan(order.indexOf('cancelled'));
    const cancelledIndex = calls.findIndex((call) => call.method === 'finishReviewRun' && terminalStatus(call.params) === 'cancelled');
    expect(cancelledIndex).toBeGreaterThanOrEqual(0);
    expect(
      calls
        .slice(cancelledIndex + 1)
        .map((call) => terminalStatus(call.params))
        .filter((status) => status !== undefined && status !== 'cancelled'),
    ).toEqual([]);
  });

  it('keeps natural completion when stop races an in-flight terminal callback', async () => {
    vi.useFakeTimers();
    try {
      const root = await temporaryRepository();
      const opencode = fakeOpencode('completed-session', 'idle');
      createOpencodeMock.mockResolvedValue(opencode.value);
      const callbackStarted = deferred<void>();
      const releaseCallback = deferred<void>();
      const { request, calls } = coreRequest(1);
      const terminal = vi.fn(async () => {
        callbackStarted.resolve();
        await releaseCallback.promise;
      });
      const runner = new ReviewAgentRunner(request, terminal);
      await runner.start({ repositoryRoot: root, sessionId: 'review-session', files: [changedFile('first.ts')] });

      const polling = vi.advanceTimersByTimeAsync(4_000);
      await callbackStarted.promise;
      let stopSettled = false;
      const stopping = runner.stop().finally(() => {
        stopSettled = true;
      });
      await Promise.resolve();

      expect(stopSettled).toBe(false);
      expect(terminal).toHaveBeenCalledOnce();
      expect(calls.filter((call) => call.method === 'finishReviewRun').map((call) => terminalStatus(call.params))).toEqual(['completed']);

      releaseCallback.resolve();
      await polling;
      await expect(stopping).resolves.toEqual({ running: false });
      expect(calls.some((call) => terminalStatus(call.params) === 'cancelled')).toBe(false);
      expect(opencode.abort).not.toHaveBeenCalled();
      expect(opencode.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets cancellation win before an in-flight poll resolves', async () => {
    vi.useFakeTimers();
    try {
      const root = await temporaryRepository();
      const status = deferred<{ data: Record<string, { type: 'busy' }> }>();
      const opencode = fakeOpencode('poll-session');
      opencode.value.client.session.status.mockImplementation(() => status.promise);
      createOpencodeMock.mockResolvedValue(opencode.value);
      const { request, calls } = coreRequest(1);
      const terminal = vi.fn();
      const runner = new ReviewAgentRunner(request, terminal);
      await runner.start({ repositoryRoot: root, sessionId: 'review-session', files: [changedFile('first.ts')] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(opencode.value.client.session.status).toHaveBeenCalledOnce();

      let stopSettled = false;
      const stopping = runner.stop().finally(() => {
        stopSettled = true;
      });
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      status.resolve({ data: { 'poll-session': { type: 'busy' } } });

      await expect(stopping).resolves.toEqual({ running: false });
      const terminalWrites = calls.filter((call) =>
        ['finishReviewRun', 'saveReviewAgentState', 'saveReviewProgress'].includes(call.method),
      );
      expect(terminalStatus(terminalWrites.at(-3)?.params)).toBe('cancelled');
      expect(terminalStatus(terminalWrites.at(-2)?.params)).toBe('cancelled');
      expect(terminalStatus(terminalWrites.at(-1)?.params)).toBe('cancelled');
      const cancellationIndex = calls.findIndex((call) => call.method === 'finishReviewRun' && terminalStatus(call.params) === 'cancelled');
      expect(cancellationIndex).toBeGreaterThanOrEqual(0);
      expect(
        calls
          .slice(cancellationIndex + 1)
          .map((call) => terminalStatus(call.params))
          .filter((value) => value === 'running' || value === 'completed' || value === 'failed'),
      ).toEqual([]);
      expect(terminal).not.toHaveBeenCalled();
      expect(opencode.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes review resources idempotently', async () => {
    const root = await temporaryRepository();
    const opencode = fakeOpencode('opencode-session-1');
    createOpencodeMock.mockResolvedValue(opencode.value);
    const { request } = coreRequest(1);
    const runner = new ReviewAgentRunner(request);
    await runner.start({ repositoryRoot: root, sessionId: 'review-session', files: [changedFile('first.ts')] });

    runner.dispose();
    runner.dispose();

    expect(opencode.close).toHaveBeenCalledOnce();
    expect(runner.status()).toEqual({ running: false });
  });

  it('tracks chat immediately, blocks ordinary close, and prevents a full review start', async () => {
    const config = deferred<ReturnType<typeof reviewConfig>>();
    const opencode = fakeOpencode('chat-session');
    createOpencodeMock.mockResolvedValue(opencode.value);
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'getReviewConfig') return await config.promise;
      if (method === 'saveReviewChatMessage') return params?.message;
      return {};
    });
    const runner = new ReviewAgentRunner(request as never);

    const chatting = runner.chat(chatRequest());
    expect(runner.status()).toMatchObject({ running: true, provider: 'opencode', status: 'running' });
    expect(runner.status().runIds).toBeUndefined();
    expect(() =>
      assertLegacyReviewAllowsClose(
        { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1', force: false },
        { context: { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' }, runner },
      ),
    ).toThrow(expect.objectContaining({ code: 'WorkspaceHasActiveReview' }));
    await expect(
      runner.start({ repositoryRoot: '/repo', sessionId: 'review-session', files: [changedFile('first.ts')] }),
    ).resolves.toMatchObject({
      running: true,
    });
    expect(createOpencodeMock).not.toHaveBeenCalled();

    config.resolve(reviewConfig());
    await expect(chatting).resolves.toMatchObject({ id: 'response-1' });
    expect(runner.status()).toEqual({ running: false });
    expect(opencode.close).toHaveBeenCalledOnce();
  });

  it('stops an active chat, aborts before cleanup, and durably replaces its pending response', async () => {
    const order: string[] = [];
    const prompt = deferred<{ data: { parts: unknown[] } }>();
    const abort = vi.fn(async () => {
      order.push('abort');
      prompt.reject(new Error('aborted'));
      return {};
    });
    const close = vi.fn(() => order.push('close'));
    const promptCall = vi.fn(() => prompt.promise);
    createOpencodeMock.mockResolvedValue(chatOpencode({ abort, close, prompt: promptCall }));
    const savedMessages: unknown[] = [];
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'getReviewConfig') return reviewConfig();
      if (method === 'saveReviewChatMessage') {
        order.push('save-cancellation');
        savedMessages.push(params?.message);
        return params?.message;
      }
      return {};
    });
    const runner = new ReviewAgentRunner(request as never);
    const chatting = runner.chat(chatRequest());
    await vi.waitFor(() => expect(promptCall).toHaveBeenCalledOnce());

    const stopping = runner.stop();

    await expect(chatting).rejects.toThrow();
    await expect(stopping).resolves.toEqual({ running: false });
    expect(abort).toHaveBeenCalledOnce();
    expect(order).toEqual(['abort', 'save-cancellation', 'close']);
    expect(savedMessages).toEqual([
      expect.objectContaining({
        id: 'response-1',
        sessionId: 'review-session',
        role: 'assistant',
        body: 'Response cancelled because the workspace was closed.',
        provider: 'opencode',
        runId: expect.stringMatching(/^chat-run-/),
        context: chatRequest().chatMessages?.[0].context,
      }),
    ]);
  });

  it('waits for pending session creation, then aborts without starting a prompt', async () => {
    const created = deferred<{ data: { id: string } }>();
    const abort = vi.fn(async () => ({}));
    const close = vi.fn();
    const prompt = vi.fn(async () => ({ data: { parts: [] } }));
    createOpencodeMock.mockResolvedValue(chatOpencode({ abort, close, prompt, create: vi.fn(() => created.promise) }));
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'getReviewConfig') return reviewConfig();
      if (method === 'saveReviewChatMessage') return params?.message;
      return {};
    });
    const runner = new ReviewAgentRunner(request as never);
    const chatting = runner.chat(chatRequest());
    await vi.waitFor(() => expect(createOpencodeMock).toHaveBeenCalledOnce());

    let stopSettled = false;
    const stopping = runner.stop().finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(runner.status()).toMatchObject({ running: true, status: 'stopping' });
    created.resolve({ data: { id: 'chat-session' } });

    await expect(chatting).rejects.toThrow();
    await expect(stopping).resolves.toEqual({ running: false });
    expect(abort).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects stop and remains guarded when cancellation persistence fails', async () => {
    const config = deferred<ReturnType<typeof reviewConfig>>();
    const persistenceFailure = new Error('cancellation persistence failed');
    const request = vi.fn(async (method: string) => {
      if (method === 'getReviewConfig') return await config.promise;
      if (method === 'saveReviewChatMessage') throw persistenceFailure;
      return {};
    });
    const runner = new ReviewAgentRunner(request as never);
    const chatting = runner.chat(chatRequest());
    const stopping = runner.stop();
    config.resolve(reviewConfig());

    await expect(chatting).rejects.toBe(persistenceFailure);
    await expect(stopping).rejects.toBe(persistenceFailure);
    expect(runner.status()).toMatchObject({ running: true, status: 'stopping' });
  });

  it('does not persist a cancellation duplicate when chat had no pending response ID', async () => {
    const config = deferred<ReturnType<typeof reviewConfig>>();
    const request = vi.fn(async (method: string) => {
      if (method === 'getReviewConfig') return await config.promise;
      return {};
    });
    const runner = new ReviewAgentRunner(request as never);
    const chat = chatRequest();
    const chatting = runner.chat({ ...chat, responseMessageId: undefined, chatMessages: [] });
    const stopping = runner.stop();
    config.resolve(reviewConfig());

    await expect(chatting).rejects.toThrow();
    await expect(stopping).resolves.toEqual({ running: false });
    expect(request.mock.calls.some(([method]) => method === 'saveReviewChatMessage')).toBe(false);
  });

  async function temporaryRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'diffuse-review-runner-'));
    roots.push(root);
    return root;
  }
});

function coreRequest(maxParallelAgents: number, shouldFail?: (method: string, params?: Record<string, unknown>) => boolean) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const request = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params });
    if (shouldFail?.(method, params)) throw new Error(`${method} failed`);
    if (method === 'getReviewConfig') {
      return {
        provider: 'opencode',
        maxParallelAgents,
        promptInstructions: 'Review carefully.',
      } as T;
    }
    return params as T;
  };
  return { request, calls };
}

function terminalStatus(params?: Record<string, unknown>): unknown {
  return (
    (params?.run as { status?: unknown } | undefined)?.status ??
    (params?.agent as { status?: unknown } | undefined)?.status ??
    (params?.progress as { status?: unknown } | undefined)?.status
  );
}

function fakeOpencode(sessionId: string, status: 'busy' | 'idle' = 'busy') {
  const abort = vi.fn(async () => ({}));
  const close = vi.fn();
  return {
    abort,
    close,
    value: {
      client: {
        session: {
          create: vi.fn(async () => ({ data: { id: sessionId } })),
          promptAsync: vi.fn(async () => ({})),
          prompt: vi.fn(async () => ({ data: { parts: [] } })),
          abort,
          status: vi.fn(async () => ({ data: { [sessionId]: { type: status } } })),
        },
      },
      server: { close },
    },
  };
}

function changedFile(path: string) {
  return { id: path, newPath: path, status: 'modified' };
}

function reviewConfig() {
  return { provider: 'opencode', maxParallelAgents: 1, promptInstructions: 'Review carefully.' };
}

function chatRequest() {
  const context = {
    fileId: 'src/main.ts',
    selection: { side: 'new' as const, startLine: 1, endLine: 1 },
    threadIds: ['thread-1'],
  };
  return {
    repositoryRoot: '/repo',
    sessionId: 'review-session',
    question: 'Why?',
    responseMessageId: 'response-1',
    chatMessages: [
      {
        id: 'response-1',
        sessionId: 'review-session',
        role: 'assistant' as const,
        body: 'Thinking...',
        createdAt: '2026-09-03T00:00:00.000Z',
        provider: 'opencode',
        context,
      },
    ],
    thread: {
      id: 'thread-1',
      sessionId: 'review-session',
      fileId: 'src/main.ts',
      anchor: context.selection,
      status: 'open',
      messages: [],
    },
  };
}

function chatOpencode(options: {
  abort: () => Promise<unknown>;
  close: () => void;
  prompt: () => Promise<unknown>;
  create?: () => Promise<{ data: { id: string } }>;
}) {
  return {
    client: {
      session: {
        create: options.create ?? (async () => ({ data: { id: 'chat-session' } })),
        prompt: options.prompt,
        abort: options.abort,
      },
    },
    server: { close: options.close },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}
