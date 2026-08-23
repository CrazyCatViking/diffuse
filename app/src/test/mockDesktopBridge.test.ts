import { describe, expect, it, vi } from 'vitest';
import { createMockDesktopBridge } from './mockDesktopBridge';

describe('mock DesktopBridge', () => {
  it('supports event subscription and unsubscription', () => {
    const bridge = createMockDesktopBridge();
    const listener = vi.fn();
    const unsubscribe = bridge.onCoreEvent(listener);
    const event = { method: 'search/started', params: { searchId: 'search-1' } } as const;

    bridge.emitCoreEvent(event);
    unsubscribe();
    bridge.emitCoreEvent(event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('provides a deterministic agent lifecycle', async () => {
    const bridge = createMockDesktopBridge();
    const request = { repositoryRoot: '/repo', sessionId: 'review-1', files: [] };

    await expect(bridge.startReviewAgent(request)).resolves.toEqual({ running: true });
    await expect(bridge.stopReviewAgent()).resolves.toEqual({ running: false });
    expect(bridge.startReviewAgent).toHaveBeenCalledWith(request);
  });
});
