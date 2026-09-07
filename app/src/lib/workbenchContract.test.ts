import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  isAttentionMutationResult,
  isInputMutationResult,
  isWorkbenchEvent,
  isWorkbenchSnapshot,
  isWorkspaceUiStateMutationResult,
  type WorkspaceRequest,
} from './workbenchContract';

const attention = { state: 'idle', inputRequired: 0, errors: 0, unread: 0, running: 0, total: 0 } as const;

describe('workbench contract', () => {
  it('validates workspace UI-state mutation envelopes', () => {
    const result = {
      outcome: 'stale',
      record: { revision: 3, state: { route: 'review' }, updatedAt: '2026-09-03T00:00:00.000Z' },
    };

    expect(isWorkspaceUiStateMutationResult(result)).toBe(true);
    expect(isWorkspaceUiStateMutationResult(result.record)).toBe(false);
    expect(isWorkspaceUiStateMutationResult({ ...result, outcome: 'other' })).toBe(false);
  });

  it('requires workspace context for workspace-bound methods', () => {
    const request = vi.fn() as unknown as WorkspaceRequest;
    const context = { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1', requestId: 'request-1' };

    expectTypeOf(request(context, 'listBranches')).toMatchTypeOf<Promise<unknown>>();
    request(context, 'listChangedFiles', { target: { includeStaged: true, includeUnstaged: true } });

    if (false) {
      // @ts-expect-error Workspace context is required.
      request('listBranches');
      // @ts-expect-error Raw repository opening is a registry command.
      request(context, 'openRepository', { path: '/repo' });
      // @ts-expect-error Required domain params remain required after context.
      request(context, 'listChangedFiles');
    }
  });

  it('validates workspace-tagged lifecycle and core events', () => {
    const base = {
      sequence: 1,
      eventId: 'event-1',
      workspaceId: 'workspace-1',
      workspaceGeneration: 'generation-1',
    };
    const summary = { ...base, root: '/repo', displayName: 'repo', state: 'ready', attention };

    expect(isWorkbenchEvent({ ...base, kind: 'workspace/added', payload: summary })).toBe(true);
    expect(
      isWorkbenchEvent({
        ...base,
        kind: 'workspace/added',
        payload: { ...summary, state: 'degraded', serviceHealth: { repositoryWatcher: 'failed' } },
      }),
    ).toBe(true);
    expect(
      isWorkbenchEvent({
        ...base,
        kind: 'workspace/added',
        payload: { ...summary, serviceHealth: { repositoryWatcher: 'unknown' } },
      }),
    ).toBe(false);
    expect(isWorkbenchEvent({ ...base, kind: 'search/started', payload: { searchId: 'search-1' } })).toBe(true);
    expect(isWorkbenchEvent({ ...base, kind: 'search/started', payload: {} })).toBe(false);
    expect(isWorkbenchEvent({ ...base, sequence: 0, kind: 'search/started', payload: { searchId: 'search-1' } })).toBe(false);
  });

  it('requires lifecycle payload references to match their event envelopes', () => {
    const base = {
      sequence: 1,
      eventId: 'event-1',
      workspaceId: 'workspace-1',
      workspaceGeneration: 'generation-1',
    };
    const summary = {
      workspaceId: base.workspaceId,
      workspaceGeneration: base.workspaceGeneration,
      root: '/repo',
      displayName: 'repo',
      state: 'ready',
      attention,
    };
    const mismatchedId = { ...summary, workspaceId: 'workspace-2' };
    const mismatchedGeneration = { ...summary, workspaceGeneration: 'generation-2' };

    for (const kind of ['workspace/added', 'workspace/removed'] as const) {
      expect(isWorkbenchEvent({ ...base, kind, payload: mismatchedId })).toBe(false);
      expect(isWorkbenchEvent({ ...base, kind, payload: mismatchedGeneration })).toBe(false);
    }

    expect(
      isWorkbenchEvent({
        ...base,
        kind: 'workspace/activated',
        payload: { summary: mismatchedId, repository: { root: '/repo', head: 'abc123' } },
      }),
    ).toBe(false);
    expect(
      isWorkbenchEvent({
        ...base,
        kind: 'workspace/activated',
        payload: { summary: mismatchedGeneration, repository: { root: '/repo', head: 'abc123' } },
      }),
    ).toBe(false);
  });

  it('validates authoritative attention, input, UI state, and aggregate snapshot data', () => {
    const summary = {
      workspaceId: 'workspace-1',
      workspaceGeneration: 'generation-1',
      root: '/repo',
      displayName: 'repo',
      state: 'ready',
      attention: { state: 'input-required', inputRequired: 1, errors: 0, unread: 0, running: 0, total: 1 },
    } as const;
    const item = {
      id: 'attention-1',
      workspaceId: 'workspace-1',
      sourceId: 'agent-1',
      kind: 'input',
      revision: 2,
      status: 'unread',
      target: { kind: 'input', inputRequestId: 'input-1' },
      createdAt: '2026-09-02T10:00:00.000Z',
      updatedAt: '2026-09-02T10:01:00.000Z',
    } as const;
    const input = {
      id: 'input-1',
      workspaceId: 'workspace-1',
      revision: 2,
      kind: 'permission',
      status: 'pending',
      prompt: 'Allow command?',
      choices: ['Allow', 'Deny'],
      cancellationSupported: true,
      attentionId: 'attention-1',
      createdAt: '2026-09-02T10:00:00.000Z',
      updatedAt: '2026-09-02T10:01:00.000Z',
    } as const;
    const snapshot = {
      workspaces: [summary],
      activeWorkspaceId: 'workspace-1',
      activeWorkspace: { summary, repository: { root: '/repo', head: 'abc123' } },
      aggregateAttention: summary.attention,
      attentionItems: [item],
      inputRequests: [input],
      workspaceUiState: { 'workspace-1': { revision: 1, state: {}, updatedAt: '2026-09-02T10:00:00.000Z' } },
      legacyReviewImports: [{ workspaceId: 'workspace-1', imported: 2, alreadyImported: 1, diagnostics: 0 }],
      restoreDiagnostics: [
        {
          workspaceId: 'workspace-failed',
          root: '/missing/repo',
          displayName: 'repo',
          message: 'Repository no longer exists',
        },
      ],
      sequence: 2,
    };

    expect(isWorkbenchSnapshot(snapshot)).toBe(true);
    expect(isAttentionMutationResult({ outcome: 'stale', item, summary: summary.attention })).toBe(true);
    expect(isInputMutationResult({ outcome: 'applied', input, attention: item, summary: summary.attention })).toBe(true);
    expect(isInputMutationResult({ outcome: 'unknown', input, summary: summary.attention })).toBe(false);
    expect(isWorkbenchSnapshot({ ...snapshot, aggregateAttention: attention })).toBe(false);
    expect(isWorkbenchSnapshot({ ...snapshot, inputRequests: [{ ...input, revision: 0 }] })).toBe(false);
    expect(isWorkbenchSnapshot({ ...snapshot, legacyReviewImports: undefined })).toBe(false);
    expect(
      isWorkbenchSnapshot({
        ...snapshot,
        legacyReviewImports: [{ workspaceId: 'workspace-1', imported: -1, alreadyImported: 0, diagnostics: 0 }],
      }),
    ).toBe(false);
    expect(
      isWorkbenchSnapshot({
        ...snapshot,
        legacyReviewImports: [{ workspaceId: 'workspace-other', imported: 0, alreadyImported: 0, diagnostics: 0 }],
      }),
    ).toBe(false);
    expect(isWorkbenchSnapshot({ ...snapshot, restoreDiagnostics: [{ ...snapshot.restoreDiagnostics[0], message: '' }] })).toBe(false);
    expect(
      isWorkbenchEvent({
        sequence: 3,
        eventId: 'event-3',
        workspaceId: 'workspace-other',
        workspaceGeneration: 'generation-1',
        kind: 'input/requested',
        payload: input,
      }),
    ).toBe(false);
    expect(
      isWorkbenchEvent({ sequence: 3, eventId: 'event-3', kind: 'workspace/orderChanged', payload: { workspaceIds: ['workspace-1'] } }),
    ).toBe(true);
    expect(
      isWorkbenchEvent({
        sequence: 3,
        eventId: 'event-response',
        workspaceId: 'workspace-1',
        workspaceGeneration: 'generation-1',
        kind: 'input/responseSubmitted',
        payload: { ...input, revision: 3, status: 'response-submitted' },
      }),
    ).toBe(true);
  });
});
