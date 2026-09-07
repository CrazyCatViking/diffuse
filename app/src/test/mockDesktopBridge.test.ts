import { describe, expect, it, vi } from 'vitest';
import { createMockDesktopBridge } from './mockDesktopBridge';

describe('mock DesktopBridge', () => {
  it('supports event subscription and unsubscription', () => {
    const bridge = createMockDesktopBridge();
    const listener = vi.fn();
    const unsubscribe = bridge.onWorkbenchEvent(listener);
    const event = {
      sequence: 1,
      eventId: 'event-1',
      workspaceId: 'workspace-1',
      workspaceGeneration: 'generation-1',
      kind: 'search/started',
      payload: { searchId: 'search-1' },
    } as const;

    bridge.emitWorkbenchEvent(event);
    unsubscribe();
    bridge.emitWorkbenchEvent(event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('provides a deterministic agent lifecycle', async () => {
    const bridge = createMockDesktopBridge();
    const context = { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1', requestId: 'request-1' };
    const request = { context, sessionId: 'review-1', files: [] };

    await expect(bridge.startReviewAgent(request)).resolves.toEqual({ running: true });
    await expect(bridge.stopReviewAgent(context)).resolves.toEqual({ running: false });
    expect(bridge.startReviewAgent).toHaveBeenCalledWith(request);
  });

  it('supports Phase 5 workspace persistence commands', async () => {
    const bridge = createMockDesktopBridge();

    await expect(bridge.reorderWorkspaces(['workspace-b', 'workspace-a'])).resolves.toEqual({
      workspaceIds: ['workspace-b', 'workspace-a'],
    });
    const reference = { workspaceId: 'workspace-a', workspaceGeneration: 'generation-a' };
    await expect(bridge.saveWorkspaceUiState(reference, 4, { logicalFocus: 'file-a' })).resolves.toMatchObject({
      outcome: 'applied',
      record: { revision: 5, state: { logicalFocus: 'file-a' } },
    });
  });
});
