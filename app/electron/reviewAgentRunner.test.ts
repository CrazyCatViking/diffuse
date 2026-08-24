import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const createOpencodeMock = vi.hoisted(() => vi.fn());

vi.mock('@opencode-ai/sdk', () => ({ createOpencode: createOpencodeMock }));

import { ReviewAgentRunner } from './reviewAgentRunner';

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
    const runner = new ReviewAgentRunner(request);

    await runner.start({ repositoryRoot: root, sessionId: 'review-session', files: [changedFile('first.ts')] });
    await expect(runner.stop()).resolves.toEqual({ running: false });

    expect(opencode.abort).toHaveBeenCalledOnce();
    expect(opencode.close).toHaveBeenCalledOnce();
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
    const runner = new ReviewAgentRunner(request);

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
  });

  async function temporaryRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'diffuse-review-runner-'));
    roots.push(root);
    return root;
  }
});

function coreRequest(maxParallelAgents: number) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const request = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params });
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

function fakeOpencode(sessionId: string) {
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
          status: vi.fn(async () => ({ data: { [sessionId]: { type: 'busy' } } })),
        },
      },
      server: { close },
    },
  };
}

function changedFile(path: string) {
  return { id: path, newPath: path, status: 'modified' };
}
