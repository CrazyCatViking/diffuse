// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { dispatchWorkspaceNavigation } from './workspaceNavigation';
import { workspaceRouteNames } from './workspaceRoutes';

describe('workspace navigation dispatcher', () => {
  it('activates before routing input and review targets', async () => {
    const calls: string[] = [];
    const dispatcher = {
      activateWorkspace: vi.fn(async () => {
        calls.push('activate');
      }),
      router: {
        push: vi.fn(async () => {
          calls.push('push');
        }),
      },
    };

    await dispatchWorkspaceNavigation('workspace-a', { kind: 'input', inputRequestId: 'input-1' }, dispatcher);

    expect(calls).toEqual(['activate', 'push']);
    expect(dispatcher.router.push).toHaveBeenCalledWith({
      name: workspaceRouteNames.input,
      params: { workspaceId: 'workspace-a', inputRequestId: 'input-1' },
    });

    await dispatchWorkspaceNavigation('workspace-a', { kind: 'review', fileId: 'src/main.ts', threadId: 'thread-1' }, dispatcher);
    expect(dispatcher.router.push).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: workspaceRouteNames.diff,
        params: { workspaceId: 'workspace-a', fileId: 'src/main.ts' },
        query: { threadId: 'thread-1' },
      }),
    );
  });

  it('opens settings and routes exact agent session identity', async () => {
    const openSettings = vi.fn();
    const dispatcher = {
      activateWorkspace: vi.fn(async () => undefined),
      router: { push: vi.fn(async () => undefined) },
      openSettings,
    };

    await dispatchWorkspaceNavigation('workspace-a', { kind: 'settings', section: 'keyboard' }, dispatcher);
    expect(openSettings).toHaveBeenCalledWith('keyboard');

    await dispatchWorkspaceNavigation('workspace-a', { kind: 'agent', agentSessionId: 'agent-17' }, dispatcher);
    expect(dispatcher.router.push).toHaveBeenLastCalledWith({
      name: workspaceRouteNames.agents,
      params: { workspaceId: 'workspace-a', agentSessionId: 'agent-17' },
    });
  });

  it('selects an exact review session after activation and before routing', async () => {
    const calls: string[] = [];
    const dispatcher = {
      activateWorkspace: vi.fn(async () => {
        calls.push('activate');
      }),
      selectReviewSession: vi.fn(async () => {
        calls.push('select');
      }),
      router: {
        push: vi.fn(async () => {
          calls.push('push');
        }),
      },
    };

    await dispatchWorkspaceNavigation('workspace-a', { kind: 'review', fileId: 'src/main.ts', reviewSessionId: 'session-2' }, dispatcher);

    expect(calls).toEqual(['activate', 'select', 'push']);
    expect(dispatcher.selectReviewSession).toHaveBeenCalledWith('session-2');
  });

  it('does not route when exact review-session selection fails', async () => {
    const failure = new Error('Review session not found: missing');
    const dispatcher = {
      activateWorkspace: vi.fn(async () => undefined),
      selectReviewSession: vi.fn(async () => {
        throw failure;
      }),
      router: { push: vi.fn(async () => undefined) },
    };

    await expect(dispatchWorkspaceNavigation('workspace-a', { kind: 'review', reviewSessionId: 'missing' }, dispatcher)).rejects.toBe(
      failure,
    );
    expect(dispatcher.router.push).not.toHaveBeenCalled();
  });
});
