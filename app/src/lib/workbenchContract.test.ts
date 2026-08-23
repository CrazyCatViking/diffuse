import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { isWorkbenchEvent, type WorkspaceRequest } from './workbenchContract';

describe('workbench contract', () => {
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
    const summary = { ...base, root: '/repo', displayName: 'repo', state: 'ready' };

    expect(isWorkbenchEvent({ ...base, kind: 'workspace/added', payload: summary })).toBe(true);
    expect(isWorkbenchEvent({ ...base, kind: 'search/started', payload: { searchId: 'search-1' } })).toBe(true);
    expect(isWorkbenchEvent({ ...base, kind: 'search/started', payload: {} })).toBe(false);
    expect(isWorkbenchEvent({ ...base, sequence: 0, kind: 'search/started', payload: { searchId: 'search-1' } })).toBe(false);
  });
});
