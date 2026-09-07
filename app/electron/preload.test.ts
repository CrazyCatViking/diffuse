import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../src/lib/desktopBridge';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, off: electron.off },
}));

describe('preload DesktopBridge', () => {
  let bridge: DesktopBridge;

  beforeAll(async () => {
    await import('./preload');
    bridge = electron.exposeInMainWorld.mock.calls[0][1] as DesktopBridge;
  });

  it('uses the Phase 5 IPC channels and payloads', async () => {
    const summary = workspaceSummary();
    const snapshot = { summary, repository: { root: '/repo/a', head: 'head' } };
    const input = inputRequest();
    electron.invoke.mockImplementation((channel: string) => {
      if (channel === 'workspace:getSnapshot') return Promise.resolve(snapshot);
      if (channel === 'workbench:rendererReady') return Promise.resolve();
      if (channel === 'workspace:close') return Promise.resolve({ ...summary, state: 'closed' });
      if (channel === 'workspace:dismissRestoreFailure') return Promise.resolve({ workspaceId: 'workspace-failed', dismissed: true });
      if (channel === 'workspace:reorder') return Promise.resolve({ workspaceIds: ['workspace-a'] });
      if (channel === 'workspace:saveUiState') {
        return Promise.resolve({
          outcome: 'applied',
          record: { revision: 3, state: { logicalFocus: 'file-a' }, updatedAt: '2026-09-02T10:00:00.000Z' },
        });
      }
      if (channel === 'attention:acknowledge') {
        return Promise.resolve({
          outcome: 'applied',
          item: {
            id: 'attention-1',
            workspaceId: 'workspace-a',
            sourceId: 'agent-1',
            kind: 'input',
            revision: 2,
            status: 'acknowledged',
            target: { kind: 'input', inputRequestId: 'input-1' },
            createdAt: '2026-09-02T10:00:00.000Z',
            updatedAt: '2026-09-02T10:01:00.000Z',
          },
          summary: summary.attention,
        });
      }
      if (channel === 'input:answer') {
        return Promise.resolve({ outcome: 'applied', input: { ...input, status: 'response-submitted' }, summary: summary.attention });
      }
      if (channel === 'input:cancel') {
        return Promise.resolve({ outcome: 'applied', input: { ...input, status: 'cancelled' }, summary: summary.attention });
      }
      throw new Error(`Unexpected channel ${channel}`);
    });
    const reference = { workspaceId: 'workspace-a', workspaceGeneration: 'generation-a' };
    const context = { ...reference, requestId: 'request-1' };

    await bridge.getWorkspaceSnapshot(reference);
    await bridge.readyForWorkbenchNavigation();
    await bridge.closeWorkspace(reference, true);
    await bridge.dismissRestoreFailure('workspace-failed');
    await bridge.reorderWorkspaces(['workspace-a']);
    await bridge.saveWorkspaceUiState(reference, 2, { logicalFocus: 'file-a' });
    await bridge.acknowledgeAttention({ context, attentionId: 'attention-1', revision: 2 });
    await bridge.answerInputRequest({
      context,
      inputRequestId: 'input-1',
      revision: 2,
      response: { value: 'Allow' },
    });
    await bridge.cancelInputRequest({ context, inputRequestId: 'input-1', revision: 2 });

    expect(electron.invoke.mock.calls).toEqual([
      ['workspace:getSnapshot', reference],
      ['workbench:rendererReady'],
      ['workspace:close', { ...reference, force: true }],
      ['workspace:dismissRestoreFailure', { workspaceId: 'workspace-failed' }],
      ['workspace:reorder', { workspaceIds: ['workspace-a'] }],
      [
        'workspace:saveUiState',
        {
          workspaceId: 'workspace-a',
          workspaceGeneration: 'generation-a',
          expectedRevision: 2,
          state: { logicalFocus: 'file-a' },
        },
      ],
      ['attention:acknowledge', { context, attentionId: 'attention-1', revision: 2 }],
      ['input:answer', { context, inputRequestId: 'input-1', revision: 2, response: { value: 'Allow' } }],
      ['input:cancel', { context, inputRequestId: 'input-1', revision: 2 }],
    ]);
  });

  it('validates attention navigation events and removes its exact listener', () => {
    const listener = vi.fn();
    const unsubscribe = bridge.onAttentionNavigation(listener);
    const registration = electron.on.mock.calls.find(([channel]) => channel === 'attention:navigate');
    const handler = registration?.[1] as ((event: unknown, request: unknown) => void) | undefined;

    handler?.({}, { workspaceId: '', target: { kind: 'workspace' } });
    handler?.(
      {},
      {
        workspaceId: 'workspace-a',
        target: { kind: 'input', inputRequestId: 'input-1' },
        attentionId: 'attention-1',
        revision: 2,
        ignored: true,
      },
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      target: { kind: 'input', inputRequestId: 'input-1' },
      attentionId: 'attention-1',
      revision: 2,
    });
    unsubscribe();
    expect(electron.off).toHaveBeenCalledWith('attention:navigate', handler);
  });
});

function workspaceSummary() {
  return {
    workspaceId: 'workspace-a',
    workspaceGeneration: 'generation-a',
    root: '/repo/a',
    displayName: 'alpha',
    state: 'ready' as const,
    attention: { state: 'input-required' as const, inputRequired: 1, errors: 0, unread: 0, running: 0, total: 1 },
  };
}

function inputRequest() {
  return {
    id: 'input-1',
    workspaceId: 'workspace-a',
    revision: 2,
    kind: 'permission' as const,
    status: 'pending' as const,
    prompt: 'Allow command?',
    choices: ['Allow', 'Deny'],
    cancellationSupported: true,
    attentionId: 'attention-1',
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:01:00.000Z',
  };
}
