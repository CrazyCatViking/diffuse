import { describe, expect, it, vi } from 'vitest';
import { closeWorkspaceWithPolicy } from './workspaceClose';

describe('workspace close policy', () => {
  it('requires confirmation before a known-risk forced close', async () => {
    const close = vi.fn(async () => undefined);

    await expect(
      closeWorkspaceWithPolicy(
        true,
        close,
        () => false,
        () => true,
      ),
    ).resolves.toBe(false);
    expect(close).not.toHaveBeenCalled();

    await expect(
      closeWorkspaceWithPolicy(
        true,
        close,
        () => true,
        () => false,
      ),
    ).resolves.toBe(true);
    expect(close).toHaveBeenCalledWith(true);
  });

  it('retries exactly once with force when pending input races a normal close', async () => {
    const close = vi
      .fn<(force: boolean) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('WorkspaceHasPendingInput'), { code: 'WorkspaceHasPendingInput' }))
      .mockResolvedValueOnce(undefined);
    const confirmRace = vi.fn(() => true);

    await expect(closeWorkspaceWithPolicy(false, close, () => false, confirmRace)).resolves.toBe(true);
    expect(close.mock.calls).toEqual([[false], [true]]);
    expect(confirmRace).toHaveBeenCalledOnce();
  });

  it('uses the same force retry for a background review race', async () => {
    const close = vi
      .fn<(force: boolean) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('WorkspaceHasActiveReview'), { code: 'WorkspaceHasActiveReview' }))
      .mockResolvedValueOnce(undefined);

    await expect(
      closeWorkspaceWithPolicy(
        false,
        close,
        () => false,
        () => true,
      ),
    ).resolves.toBe(true);
    expect(close.mock.calls).toEqual([[false], [true]]);
  });

  it('does not retry unrelated close failures', async () => {
    const failure = new Error('database unavailable');
    const close = vi.fn().mockRejectedValue(failure);

    await expect(
      closeWorkspaceWithPolicy(
        false,
        close,
        () => true,
        () => true,
      ),
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });
});
