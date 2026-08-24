import { describe, expect, it, vi } from 'vitest';
import { closeWorkspaceWithLegacyReviewAgent } from './legacyReviewAgentLifecycle';

describe('legacy review agent workspace lifecycle', () => {
  const reference = { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' };

  it('stops and disposes a matching runner before closing the workspace', async () => {
    const order: string[] = [];
    const owner = {
      context: reference,
      runner: {
        stop: vi.fn(async () => {
          order.push('stop');
        }),
        dispose: vi.fn(() => order.push('dispose')),
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
      runner: { stop: vi.fn(async () => undefined), dispose: vi.fn() },
    };
    const closeWorkspace = vi.fn(async () => 'closed');

    await closeWorkspaceWithLegacyReviewAgent(reference, owner, closeWorkspace);
    expect(owner.runner.stop).not.toHaveBeenCalled();
    expect(owner.runner.dispose).not.toHaveBeenCalled();
    expect(closeWorkspace).toHaveBeenCalledWith(reference);
  });
});
