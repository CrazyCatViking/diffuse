import { describe, expect, it, vi } from 'vitest';
import { createReviewAttentionWithRetry } from './reviewAttention';

describe('review attention persistence', () => {
  const context = { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1', requestId: 'request-1' };
  const terminal = { runId: 'run-1', sessionId: 'session-1', status: 'completed' as const, message: 'complete' };

  it('retries transient failures with the same idempotent identity', async () => {
    const createAttention = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'DatabaseBusy' }))
      .mockResolvedValueOnce({ outcome: 'applied' });
    const sleep = vi.fn(async () => undefined);

    await createReviewAttentionWithRetry(async () => ({ createAttention }) as never, context, terminal, sleep);

    expect(createAttention).toHaveBeenCalledTimes(2);
    expect(createAttention.mock.calls[0][0]).toEqual(createAttention.mock.calls[1][0]);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('does not retry permanent workspace failures', async () => {
    const failure = Object.assign(new Error('gone'), { code: 'WorkspaceNotFound' });
    const createAttention = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn(async () => undefined);

    await expect(createReviewAttentionWithRetry(async () => ({ createAttention }) as never, context, terminal, sleep)).rejects.toBe(
      failure,
    );
    expect(createAttention).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
