// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isProxy } from 'vue';
import type { AttentionItem, InputRequest, WorkspaceSnapshot } from '../lib/workbenchContract';
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
      ...snapshotState([first.summary, second.summary]),
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
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([]),
      sequence: 0,
    });
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
      .mockResolvedValueOnce({ workspaces: [], activeWorkspaceId: null, activeWorkspace: null, ...snapshotState([]), sequence: 0 })
      .mockResolvedValueOnce({
        workspaces: [restored.summary],
        activeWorkspaceId: restored.summary.workspaceId,
        activeWorkspace: restored,
        ...snapshotState([restored.summary]),
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
      ...snapshotState([first.summary]),
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
    expect(bridge.closeWorkspace).toHaveBeenCalledWith(reference, false);
  });

  it('never acknowledges attention when merely activating a workspace', async () => {
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      sequence: 0,
    });
    bridge.activateWorkspace.mockResolvedValue(target);
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    await store.activateWorkspace(target.summary.workspaceId);

    expect(bridge.acknowledgeAttention).not.toHaveBeenCalled();
  });

  it('keeps the newest input revision when an older command response loses an event race', async () => {
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    const original = inputRequest(1, 'pending');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      inputRequests: [original],
      sequence: 0,
    });
    const pendingAnswer = deferred<{
      outcome: 'applied';
      input: InputRequest;
      summary: WorkspaceSnapshot['summary']['attention'];
    }>();
    bridge.answerInputRequest.mockReturnValue(pendingAnswer.promise);
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    const answering = store.answerInputRequest(original.id, original.revision, { value: 'Allow' });
    bridge.emitWorkbenchEvent({
      sequence: 1,
      eventId: 'event-1',
      workspaceId: target.summary.workspaceId,
      workspaceGeneration: target.summary.workspaceGeneration,
      kind: 'input/resolved',
      payload: inputRequest(2, 'accepted'),
    });
    await vi.waitFor(() => expect(store.inputRequests[original.id].revision).toBe(2));
    pendingAnswer.resolve({ outcome: 'applied', input: inputRequest(1, 'response-submitted'), summary: idleAttention() });
    await answering;

    expect(store.inputRequests[original.id].status).toBe('accepted');
    expect(store.inputRequests[original.id].revision).toBe(2);
  });

  it('applies response-submitted and resolved events as distinct authoritative replacements', async () => {
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    const original = inputRequest(1, 'pending');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      inputRequests: [original],
      sequence: 0,
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    bridge.emitWorkbenchEvent({
      sequence: 1,
      eventId: 'event-response',
      workspaceId: target.summary.workspaceId,
      workspaceGeneration: target.summary.workspaceGeneration,
      kind: 'input/responseSubmitted',
      payload: inputRequest(2, 'response-submitted'),
    });
    await vi.waitFor(() => expect(store.inputRequests[original.id]).toMatchObject({ revision: 2, status: 'response-submitted' }));
    bridge.emitWorkbenchEvent({
      sequence: 2,
      eventId: 'event-resolved',
      workspaceId: target.summary.workspaceId,
      workspaceGeneration: target.summary.workspaceGeneration,
      kind: 'input/resolved',
      payload: inputRequest(3, 'accepted'),
    });

    await vi.waitFor(() => expect(store.inputRequests[original.id]).toMatchObject({ revision: 3, status: 'accepted' }));
  });

  it('replaces a pending request with the authoritative record returned for a stale CAS', async () => {
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    const original = inputRequest(1, 'pending');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      inputRequests: [original],
      sequence: 0,
    });
    bridge.answerInputRequest.mockRejectedValue({ current: inputRequest(3, 'superseded') });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    await expect(store.answerInputRequest(original.id, 1, { value: 'Allow' })).rejects.toBeDefined();

    expect(store.inputRequests[original.id]).toMatchObject({ revision: 3, status: 'superseded' });
  });

  it('treats a stale CAS envelope as authoritative ordinary data', async () => {
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    const original = inputRequest(1, 'pending');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      inputRequests: [original],
      sequence: 0,
    });
    const authoritative = inputRequest(3, 'superseded');
    const attention = attentionItem(3, 'superseded');
    const summary = { state: 'error' as const, inputRequired: 0, errors: 1, unread: 0, running: 0, total: 1 };
    bridge.answerInputRequest.mockResolvedValue({ outcome: 'stale', input: authoritative, attention, summary });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    await expect(store.answerInputRequest(original.id, original.revision, { value: 'Allow' })).resolves.toEqual(authoritative);

    expect(store.inputRequests[original.id]).toEqual(authoritative);
    expect(store.attentionItems[attention.id]).toEqual(attention);
    expect(store.workspaces[0].attention).toEqual(summary);
  });

  it('hydrates SQLite UI state ahead of fallback and saves with its current revision', async () => {
    window.localStorage.setItem(
      'diffuse.workbench.ui.v1',
      JSON.stringify({ railOrder: [], uiByWorkspaceId: { 'workspace-a': { logicalFocus: 'fallback' } } }),
    );
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      workspaceUiState: {
        'workspace-a': { revision: 4, state: { logicalFocus: 'sqlite' }, updatedAt: '2026-09-02T10:00:00.000Z' },
      },
      sequence: 0,
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    expect(store.uiState('workspace-a').logicalFocus).toBe('sqlite');
    store.saveUiState('workspace-a', { logicalFocus: 'next' });
    expect(store.uiState('workspace-a').logicalFocus).toBe('next');
    await vi.waitFor(() => expect(bridge.saveWorkspaceUiState).toHaveBeenCalled());
    expect(bridge.saveWorkspaceUiState).toHaveBeenCalledWith(
      { workspaceId: 'workspace-a', workspaceGeneration: 'workspace-a-generation' },
      4,
      { logicalFocus: 'next' },
    );
  });

  it('uses revision zero for creation and discards a stale response from a replaced workspace generation', async () => {
    const bridge = createMockDesktopBridge();
    const original = workspace('workspace-a', '/repo/a');
    const pendingSave = deferred<{
      outcome: 'stale';
      record: { revision: number; state: Record<string, unknown>; updatedAt: string };
    }>();
    bridge.saveWorkspaceUiState.mockReturnValue(pendingSave.promise);
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [original.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([original.summary]),
      sequence: 0,
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    store.saveUiState(original.summary.workspaceId, { logicalFocus: 'old-generation' });
    await vi.waitFor(() => expect(bridge.saveWorkspaceUiState).toHaveBeenCalledOnce());
    expect(bridge.saveWorkspaceUiState).toHaveBeenCalledWith(
      {
        workspaceId: original.summary.workspaceId,
        workspaceGeneration: original.summary.workspaceGeneration,
      },
      0,
      { logicalFocus: 'old-generation' },
    );

    const replacement = {
      ...original.summary,
      workspaceGeneration: 'workspace-a-reopened',
      state: 'ready' as const,
    };
    bridge.emitWorkbenchEvent({
      sequence: 1,
      eventId: 'event-removed',
      workspaceId: original.summary.workspaceId,
      workspaceGeneration: original.summary.workspaceGeneration,
      kind: 'workspace/removed',
      payload: { ...original.summary, state: 'closed' },
    });
    bridge.emitWorkbenchEvent({
      sequence: 2,
      eventId: 'event-reopened',
      workspaceId: replacement.workspaceId,
      workspaceGeneration: replacement.workspaceGeneration,
      kind: 'workspace/added',
      payload: replacement,
    });
    await vi.waitFor(() => expect(store.workspaces[0]?.workspaceGeneration).toBe(replacement.workspaceGeneration));
    pendingSave.resolve({
      outcome: 'stale',
      record: {
        revision: 1,
        state: { logicalFocus: 'old-generation' },
        updatedAt: '2026-09-02T10:00:00.000Z',
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.workspaceUiRecords[replacement.workspaceId]).toBeUndefined();
    expect(store.uiState(replacement.workspaceId).logicalFocus).toBeUndefined();
    expect(bridge.saveWorkspaceUiState).toHaveBeenCalledOnce();
  });

  it('rebases a stale UI-state save and resubmits the latest dirty state', async () => {
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      workspaceUiState: {
        'workspace-a': { revision: 2, state: { logicalFocus: 'server-old' }, updatedAt: '2026-09-02T10:00:00.000Z' },
      },
      sequence: 0,
    });
    bridge.saveWorkspaceUiState
      .mockResolvedValueOnce({
        outcome: 'stale',
        record: { revision: 4, state: { logicalFocus: 'server-new' }, updatedAt: '2026-09-02T10:01:00.000Z' },
      })
      .mockResolvedValueOnce({
        outcome: 'applied',
        record: { revision: 5, state: { logicalFocus: 'local' }, updatedAt: '2026-09-02T10:02:00.000Z' },
      });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    store.saveUiState('workspace-a', { logicalFocus: 'local' });

    await vi.waitFor(() => expect(bridge.saveWorkspaceUiState).toHaveBeenCalledTimes(2));
    expect(bridge.saveWorkspaceUiState.mock.calls.map((call) => call[1])).toEqual([2, 4]);
    await vi.waitFor(() => expect(store.workspaceUiRecords['workspace-a']?.revision).toBe(5));
    expect(store.uiState('workspace-a').logicalFocus).toBe('local');
    expect(window.localStorage.getItem('diffuse.workbench.ui.v1')).not.toContain('local');
  });

  it('does not spin on an unchanged UI-state result', async () => {
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      workspaceUiState: {
        'workspace-a': { revision: 2, state: { logicalFocus: 'local' }, updatedAt: '2026-09-02T10:00:00.000Z' },
      },
      sequence: 0,
    });
    bridge.saveWorkspaceUiState.mockResolvedValue({
      outcome: 'unchanged',
      record: { revision: 2, state: { logicalFocus: 'local' }, updatedAt: '2026-09-02T10:00:00.000Z' },
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    store.saveUiState('workspace-a', { logicalFocus: 'local' });

    await vi.waitFor(() => expect(store.error).toContain('unchanged'));
    expect(bridge.saveWorkspaceUiState).toHaveBeenCalledOnce();
  });

  it('keeps authentication drafts transient and out of persistence', async () => {
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    const request = { ...inputRequest(1, 'pending'), kind: 'authentication' as const, choices: [] };
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      inputRequests: [request],
      sequence: 0,
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    store.saveInputDraft(request, 'top-secret');

    expect(store.inputDraft(request)).toBe('');
    expect(window.localStorage.getItem('diffuse.workbench.ui.v1')).not.toContain('top-secret');
    expect(bridge.saveWorkspaceUiState).not.toHaveBeenCalled();
  });

  it('erases authentication drafts after an exact-revision response', async () => {
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    const request = { ...inputRequest(3, 'pending'), kind: 'authentication' as const, choices: [] };
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: target.summary.workspaceId,
      activeWorkspace: target,
      ...snapshotState([target.summary]),
      inputRequests: [request],
      sequence: 0,
    });
    bridge.answerInputRequest.mockResolvedValue({
      outcome: 'applied',
      input: { ...request, status: 'response-submitted' },
      summary: idleAttention(),
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());
    store.saveInputDraft(request, 'top-secret');

    await store.answerInputRequest(request.id, request.revision, { value: 'top-secret', secret: true });

    expect(store.inputDraft(request)).toBe('');
    expect(store.inputRequests[request.id]).toMatchObject({ revision: 3, status: 'response-submitted' });
    expect(window.localStorage.getItem('diffuse.workbench.ui.v1')).not.toContain('top-secret');
  });

  it('recovers generation-bound dirty UI and resaves it over older SQLite state', async () => {
    const target = workspace('workspace-a', '/repo/a');
    window.localStorage.setItem(
      'diffuse.workbench.ui.v1',
      JSON.stringify({
        railOrder: [],
        dirtyUiByWorkspaceId: {
          'workspace-a': { workspaceGeneration: target.summary.workspaceGeneration, state: { logicalFocus: 'dirty-focus' } },
        },
      }),
    );
    const bridge = createMockDesktopBridge();
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      workspaceUiState: {
        'workspace-a': { revision: 4, state: { logicalFocus: 'sqlite-focus' }, updatedAt: '2026-09-02T10:00:00.000Z' },
      },
      sequence: 0,
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();

    await store.initialize(vi.fn());

    expect(store.uiState('workspace-a').logicalFocus).toBe('dirty-focus');
    await vi.waitFor(() =>
      expect(bridge.saveWorkspaceUiState).toHaveBeenCalledWith(
        { workspaceId: 'workspace-a', workspaceGeneration: target.summary.workspaceGeneration },
        4,
        { logicalFocus: 'dirty-focus' },
      ),
    );
    await vi.waitFor(() => expect(window.localStorage.getItem('diffuse.workbench.ui.v1')).not.toContain('dirty-focus'));
  });

  it('hydrates restore diagnostics and announces new input without acknowledging it', async () => {
    const bridge = createMockDesktopBridge();
    const target = workspace('workspace-a', '/repo/a');
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [target.summary],
      activeWorkspaceId: null,
      activeWorkspace: null,
      ...snapshotState([target.summary]),
      restoreDiagnostics: [{ workspaceId: 'failed-1', root: '/missing', displayName: 'missing', message: 'Not found' }],
      sequence: 0,
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());

    bridge.emitWorkbenchEvent({
      sequence: 1,
      eventId: 'event-input',
      workspaceId: target.summary.workspaceId,
      workspaceGeneration: target.summary.workspaceGeneration,
      kind: 'input/requested',
      payload: inputRequest(1, 'pending'),
    });

    await vi.waitFor(() => expect(store.announcement).toContain('Input required in a'));
    expect(store.restoreDiagnostics).toHaveLength(1);
    expect(bridge.acknowledgeAttention).not.toHaveBeenCalled();
  });
});

function workspace(workspaceId: string, root: string): WorkspaceSnapshot {
  return {
    summary: {
      workspaceId,
      workspaceGeneration: `${workspaceId}-generation`,
      root,
      displayName: root.split('/').at(-1)!,
      state: 'ready',
      attention: idleAttention(),
    },
    repository: { root, head: `${workspaceId}-head` },
  };
}

function idleAttention() {
  return { state: 'idle' as const, inputRequired: 0, errors: 0, unread: 0, running: 0, total: 0 };
}

function snapshotState(workspaces: WorkspaceSnapshot['summary'][]) {
  const aggregateAttention = workspaces.reduce(
    (summary, workspace) => ({
      ...summary,
      inputRequired: summary.inputRequired + workspace.attention.inputRequired,
      errors: summary.errors + workspace.attention.errors,
      unread: summary.unread + workspace.attention.unread,
      running: summary.running + workspace.attention.running,
      total: summary.total + workspace.attention.total,
    }),
    idleAttention(),
  );
  return { aggregateAttention, attentionItems: [], inputRequests: [], workspaceUiState: {}, legacyReviewImports: [] };
}

function inputRequest(revision: number, status: InputRequest['status']): InputRequest {
  return {
    id: 'input-1',
    workspaceId: 'workspace-a',
    revision,
    kind: 'permission',
    status,
    prompt: 'Allow command?',
    choices: ['Allow', 'Deny'],
    cancellationSupported: true,
    attentionId: 'attention-1',
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: `2026-09-02T10:0${revision}:00.000Z`,
  };
}

function attentionItem(revision: number, status: AttentionItem['status']): AttentionItem {
  return {
    id: 'attention-1',
    workspaceId: 'workspace-a',
    sourceId: 'input-1',
    kind: 'input',
    revision,
    status,
    target: { kind: 'input', inputRequestId: 'input-1' },
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: `2026-09-02T10:0${revision}:00.000Z`,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
