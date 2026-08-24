// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isProxy } from 'vue';
import type { WorkspaceSnapshot } from '../lib/workbenchContract';
import { createMockDesktopBridge } from '../test/mockDesktopBridge';
import { useWorkbenchStore } from './workbench';

describe('useWorkbenchStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
  });

  it('hydrates all summaries and restores the active workspace', async () => {
    const bridge = createMockDesktopBridge();
    const first = workspace('workspace-a', '/repo/a');
    const second = workspace('workspace-b', '/repo/b');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [first.summary, second.summary],
      activeWorkspaceId: second.summary.workspaceId,
      activeWorkspace: second,
      sequence: 4,
    });
    window.diffuse = bridge;
    const handler = vi.fn();
    const store = useWorkbenchStore();

    await store.initialize(handler);

    expect(store.workspaces.map((item) => item.workspaceId)).toEqual(['workspace-a', 'workspace-b']);
    expect(store.activeWorkspaceId).toBe('workspace-b');
    expect(store.sequence).toBe(4);
    expect(handler).toHaveBeenCalledWith(second);
  });

  it('keeps compact UI records independent per workspace', () => {
    window.diffuse = createMockDesktopBridge();
    const store = useWorkbenchStore();
    store.saveUiState('workspace-a', { logicalFocus: 'file-a' });
    store.saveUiState('workspace-b', { logicalFocus: 'file-b' });

    expect(store.uiState('workspace-a').logicalFocus).toBe('file-a');
    expect(store.uiState('workspace-b').logicalFocus).toBe('file-b');
  });

  it('keeps an external activation that arrives during a pending command', async () => {
    const bridge = createMockDesktopBridge();
    bridge.getWorkbenchSnapshot.mockResolvedValue({ workspaces: [], activeWorkspaceId: null, activeWorkspace: null, sequence: 0 });
    const pendingOpen = deferred<WorkspaceSnapshot>();
    bridge.openWorkspace.mockReturnValue(pendingOpen.promise);
    window.diffuse = bridge;
    const handler = vi.fn();
    const store = useWorkbenchStore();
    await store.initialize(handler);
    const first = workspace('workspace-a', '/repo/a');
    const external = workspace('workspace-b', '/repo/b');

    const opening = store.openWorkspace('/repo/a');
    bridge.emitWorkbenchEvent({
      sequence: 1,
      eventId: 'event-1',
      workspaceId: external.summary.workspaceId,
      workspaceGeneration: external.summary.workspaceGeneration,
      kind: 'workspace/activated',
      payload: external,
    });
    await vi.waitFor(() => expect(store.activeWorkspaceId).toBe('workspace-b'));
    pendingOpen.resolve(first);
    await opening;

    expect(store.activeWorkspaceId).toBe('workspace-b');
    expect(handler).toHaveBeenCalledWith(external);
    expect(handler).not.toHaveBeenCalledWith(first);
  });

  it('restores an authoritative snapshot for a sequence gap after sequence zero', async () => {
    const bridge = createMockDesktopBridge();
    const restored = workspace('workspace-restored', '/repo/restored');
    const skippedEventWorkspace = workspace('workspace-event', '/repo/event');
    bridge.getWorkbenchSnapshot
      .mockResolvedValueOnce({ workspaces: [], activeWorkspaceId: null, activeWorkspace: null, sequence: 0 })
      .mockResolvedValueOnce({
        workspaces: [restored.summary],
        activeWorkspaceId: restored.summary.workspaceId,
        activeWorkspace: restored,
        sequence: 2,
      });
    window.diffuse = bridge;
    const handler = vi.fn();
    const store = useWorkbenchStore();
    await store.initialize(handler);

    bridge.emitWorkbenchEvent({
      sequence: 2,
      eventId: 'event-2',
      workspaceId: skippedEventWorkspace.summary.workspaceId,
      workspaceGeneration: skippedEventWorkspace.summary.workspaceGeneration,
      kind: 'workspace/activated',
      payload: skippedEventWorkspace,
    });

    await vi.waitFor(() => expect(store.sequence).toBe(2));
    expect(bridge.getWorkbenchSnapshot).toHaveBeenCalledTimes(2);
    expect(store.activeWorkspaceId).toBe(restored.summary.workspaceId);
    expect(store.workspaces).toEqual([restored.summary]);
    expect(handler).toHaveBeenCalledWith(restored);
    expect(handler).not.toHaveBeenCalledWith(skippedEventWorkspace);
  });

  it('sends plain workspace references when switching and closing', async () => {
    const bridge = createMockDesktopBridge();
    const first = workspace('workspace-a', '/repo/a');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [first.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      sequence: 0,
    });
    bridge.activateWorkspace.mockResolvedValue(first);
    bridge.closeWorkspace.mockResolvedValue({ ...first.summary, state: 'closed' });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    await store.activateWorkspace(first.summary.workspaceId);

    const reference = bridge.activateWorkspace.mock.calls[0][0];
    expect(reference).toEqual({
      workspaceId: first.summary.workspaceId,
      workspaceGeneration: first.summary.workspaceGeneration,
    });
    expect(isProxy(reference)).toBe(false);

    await store.closeWorkspace(first.summary.workspaceId);
    const closeReference = bridge.closeWorkspace.mock.calls[0][0];
    expect(closeReference).toEqual(reference);
    expect(isProxy(closeReference)).toBe(false);
  });
});

function workspace(workspaceId: string, root: string): WorkspaceSnapshot {
  return {
    summary: { workspaceId, workspaceGeneration: `${workspaceId}-generation`, root, displayName: root.split('/').at(-1)!, state: 'ready' },
    repository: { root, head: `${workspaceId}-head` },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
