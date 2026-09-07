import { describe, expect, it, vi } from 'vitest';
import type { AttentionNavigationRequest } from './attentionPresentation';
import { WorkbenchNavigationQueue } from './workbenchNavigationQueue';

describe('WorkbenchNavigationQueue', () => {
  it('queues fast clicks until ready, then flushes in order', () => {
    const queue = new WorkbenchNavigationQueue();
    const target = { send: vi.fn() };
    const first = request('attention-1', 1);
    const second = request('attention-2', 1);

    queue.enqueue(first, target);
    queue.enqueue(second, target);
    expect(target.send).not.toHaveBeenCalled();

    queue.markReady(target);
    expect(target.send.mock.calls).toEqual([
      ['attention:navigate', first],
      ['attention:navigate', second],
    ]);
  });

  it('deduplicates exact revisions and retains only the latest bounded requests', () => {
    const queue = new WorkbenchNavigationQueue(2);
    const target = { send: vi.fn() };

    queue.enqueue(request('attention-1', 1), target);
    queue.enqueue(request('attention-1', 1), target);
    queue.enqueue(request('attention-1', 2), target);
    queue.enqueue(request('attention-2', 1), target);
    queue.markReady(target);

    expect(target.send.mock.calls.map((call) => call[1])).toEqual([request('attention-1', 2), request('attention-2', 1)]);
  });

  it('delivers immediately only while the current renderer remains ready', () => {
    const queue = new WorkbenchNavigationQueue();
    const target = { send: vi.fn() };
    queue.markReady(target);
    queue.enqueue(request('attention-1', 1), target);
    expect(target.send).toHaveBeenCalledOnce();

    queue.markNotReady(target);
    queue.enqueue(request('attention-2', 1), target);
    expect(target.send).toHaveBeenCalledOnce();
    queue.markReady(target);
    expect(target.send).toHaveBeenCalledTimes(2);
  });
});

function request(attentionId: string, revision: number): AttentionNavigationRequest {
  return { workspaceId: 'workspace-1', target: { kind: 'workspace' }, attentionId, revision };
}
