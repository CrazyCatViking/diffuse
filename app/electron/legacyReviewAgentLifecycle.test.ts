import { describe, expect, it, vi } from 'vitest';
import {
  assertLegacyReviewAllowsClose,
  closeWorkspaceWithLegacyReviewAgent,
  stopLegacyReviewAgentForShutdown,
} from './legacyReviewAgentLifecycle';

describe('legacy review agent workspace lifecycle', () => {
  const reference = { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1', force: true };

  it('stops and disposes a matching runner before closing the workspace', async () => {
    const order: string[] = [];
    const owner = {
      context: reference,
      runner: {
        stop: vi.fn(async () => {
          order.push('stop');
        }),
        dispose: vi.fn(() => order.push('dispose')),
        status: vi.fn(() => ({ running: true })),
      },
    };
    const closeWorkspace = vi.fn(async () => {
      order.push('close');
      return 'closed';
    });

    await expect(closeWorkspaceWithLegacyReviewAgent(reference, owner, closeWorkspace)).resolves.toBe('closed');
    expect(order).toEqual(['stop', 'dispose', 'close']);
  });

  it('does not stop a runner owned by another workspace', async () => {
    const owner = {
      context: { ...reference, workspaceGeneration: 'generation-2' },
      runner: { stop: vi.fn(async () => undefined), dispose: vi.fn(), status: vi.fn(() => ({ running: true })) },
    };
    const closeWorkspace = vi.fn(async () => 'closed');

    await closeWorkspaceWithLegacyReviewAgent(reference, owner, closeWorkspace);
    expect(owner.runner.stop).not.toHaveBeenCalled();
    expect(owner.runner.dispose).not.toHaveBeenCalled();
    expect(closeWorkspace).toHaveBeenCalledWith(reference);
  });

  it('rejects an ordinary close before core dispatch when the matching runner is active', () => {
    const owner = {
      context: reference,
      runner: { stop: vi.fn(async () => undefined), dispose: vi.fn(), status: vi.fn(() => ({ running: true })) },
    };

    expect(() => assertLegacyReviewAllowsClose({ ...reference, force: false }, owner)).toThrow(
      expect.objectContaining({ code: 'WorkspaceHasActiveReview' }),
    );
    expect(owner.runner.stop).not.toHaveBeenCalled();
    expect(owner.runner.dispose).not.toHaveBeenCalled();
    expect(() => assertLegacyReviewAllowsClose(reference, owner)).not.toThrow();
  });

  it('does not dispose or close when forced runner stop fails', async () => {
    const failure = new Error('cancellation persistence failed');
    const owner = {
      context: reference,
      runner: { stop: vi.fn().mockRejectedValue(failure), dispose: vi.fn(), status: vi.fn(() => ({ running: true })) },
    };
    const closeWorkspace = vi.fn(async () => 'closed');

    await expect(closeWorkspaceWithLegacyReviewAgent(reference, owner, closeWorkspace)).rejects.toBe(failure);
    expect(owner.runner.dispose).not.toHaveBeenCalled();
    expect(closeWorkspace).not.toHaveBeenCalled();
  });

  it('stops before disposal during application shutdown', async () => {
    const order: string[] = [];
    const owner = {
      context: reference,
      runner: {
        stop: vi.fn(async () => {
          order.push('stop');
        }),
        dispose: vi.fn(() => order.push('dispose')),
        status: vi.fn(() => ({ running: true })),
      },
    };

    await stopLegacyReviewAgentForShutdown(owner);

    expect(order).toEqual(['stop', 'dispose']);
  });

  it('still disposes shutdown resources when stopping fails', async () => {
    const failure = new Error('stop failed');
    const owner = {
      context: reference,
      runner: {
        stop: vi.fn().mockRejectedValue(failure),
        dispose: vi.fn(),
        status: vi.fn(() => ({ running: true })),
      },
    };

    await expect(stopLegacyReviewAgentForShutdown(owner)).rejects.toBe(failure);
    expect(owner.runner.dispose).toHaveBeenCalledOnce();
  });
});
