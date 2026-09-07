import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { CoreEvent } from '../src/lib/coreContract';
import type { WorkbenchEvent, WorkspaceRequestContext } from '../src/lib/workbenchContract';
import { LegacyWorkspaceRegistry, StaleWorkspaceError } from './legacyWorkspaceRegistry';

describe('LegacyWorkspaceRegistry', () => {
  it('routes interleaved requests and events to independent workspaces', async () => {
    const events: WorkbenchEvent[] = [];
    const clients: FakeCoreClient[] = [];
    const registry = createRegistry(clients, events);
    const first = await registry.openWorkspace('/repo-a');
    const second = await registry.openWorkspace('/repo-b');
    const firstDeferred = deferred<unknown>();
    const secondDeferred = deferred<unknown>();
    clients[0].responses.set('listBranches', firstDeferred.promise);
    clients[1].responses.set('listBranches', secondDeferred.promise);

    const firstRequest = registry.request(context(first, 'request-a'), 'listBranches', undefined);
    const secondRequest = registry.request(context(second, 'request-b'), 'listBranches', undefined);
    secondDeferred.resolve([{ name: 'second' }]);
    firstDeferred.resolve([{ name: 'first' }]);

    await expect(firstRequest).resolves.toMatchObject({ context: { requestId: 'request-a' }, result: [{ name: 'first' }] });
    await expect(secondRequest).resolves.toMatchObject({ context: { requestId: 'request-b' }, result: [{ name: 'second' }] });

    clients[0].emitCoreEvent({ method: 'search/started', params: { searchId: 'search-a' } });
    clients[1].emitCoreEvent({ method: 'search/started', params: { searchId: 'search-b' } });
    const searchEvents = events.filter((event) => event.kind === 'search/started');
    expect(searchEvents).toEqual([
      expect.objectContaining({ workspaceId: first.summary.workspaceId, workspaceGeneration: first.summary.workspaceGeneration }),
      expect.objectContaining({ workspaceId: second.summary.workspaceId, workspaceGeneration: second.summary.workspaceGeneration }),
    ]);
  });

  it('deduplicates canonical roots and activates the existing workspace', async () => {
    const events: WorkbenchEvent[] = [];
    const clients: FakeCoreClient[] = [];
    const registry = createRegistry(clients, events, async () => '/canonical/repo');

    const first = await registry.openWorkspace('/repo');
    const duplicate = await registry.openWorkspace('/repo-alias');

    expect(duplicate.summary.workspaceId).toBe(first.summary.workspaceId);
    expect(duplicate.summary.workspaceGeneration).toBe(first.summary.workspaceGeneration);
    expect(clients[1].disposed).toBe(true);
    expect(registry.getWorkbenchSnapshot().workspaces).toHaveLength(1);
  });

  it('changes generation on reopen and rejects stale results and events', async () => {
    const events: WorkbenchEvent[] = [];
    const clients: FakeCoreClient[] = [];
    const registry = createRegistry(clients, events);
    const first = await registry.openWorkspace('/repo');
    const pending = deferred<unknown>();
    clients[0].responses.set('listBranches', pending.promise);
    const staleRequest = registry.request(context(first, 'stale-request'), 'listBranches', undefined);

    registry.closeWorkspace({ ...first.summary, force: false });
    clients[0].emitCoreEvent({ method: 'search/started', params: { searchId: 'stale-search' } });
    pending.resolve([]);
    await expect(staleRequest).rejects.toBeInstanceOf(StaleWorkspaceError);

    const reopened = await registry.openWorkspace('/repo');
    expect(reopened.summary.workspaceId).toBe(first.summary.workspaceId);
    expect(reopened.summary.workspaceGeneration).not.toBe(first.summary.workspaceGeneration);
    expect(events.some((event) => event.kind === 'search/started' && event.payload.searchId === 'stale-search')).toBe(false);
    await expect(registry.request(context(first, 'old-generation'), 'listBranches', undefined)).rejects.toBeInstanceOf(StaleWorkspaceError);
  });

  it('does not let a slow open override a newer activation intent', async () => {
    const events: WorkbenchEvent[] = [];
    const clients: FakeCoreClient[] = [];
    const openSecond = deferred<unknown>();
    let id = 0;
    const registry = new LegacyWorkspaceRegistry({
      createClient: () => {
        const client = new FakeCoreClient();
        if (clients.length === 1) client.openRepositoryResponse = openSecond.promise;
        clients.push(client);
        return client;
      },
      canonicalizeRoot: async (root) => root,
      createId: () => `intent-${++id}`,
      onEvent: (event) => events.push(event),
    });
    const first = await registry.openWorkspace('/repo-a');
    const slowOpen = registry.openWorkspace('/repo-b');
    await Promise.resolve();

    registry.activateWorkspace(first.summary);
    openSecond.resolve({ root: '/repo-b', head: 'head-b' });
    await slowOpen;

    expect(registry.getWorkbenchSnapshot().activeWorkspaceId).toBe(first.summary.workspaceId);
    expect(events.filter((event) => event.kind === 'workspace/activated').at(-1)?.workspaceId).toBe(first.summary.workspaceId);
  });

  it('provides strict idle defaults and process-local order and UI state', async () => {
    const events: WorkbenchEvent[] = [];
    const clients: FakeCoreClient[] = [];
    const registry = createRegistry(clients, events);
    const first = await registry.openWorkspace('/repo-a');
    const second = await registry.openWorkspace('/repo-b');

    expect(registry.getWorkbenchSnapshot()).toMatchObject({
      aggregateAttention: { state: 'idle', inputRequired: 0, errors: 0, unread: 0, running: 0, total: 0 },
      attentionItems: [],
      inputRequests: [],
      workspaceUiState: {},
      legacyReviewImports: [],
    });
    expect(first.summary.attention).toEqual({ state: 'idle', inputRequired: 0, errors: 0, unread: 0, running: 0, total: 0 });

    expect(registry.reorderWorkspaces([second.summary.workspaceId, first.summary.workspaceId])).toEqual({
      workspaceIds: [second.summary.workspaceId, first.summary.workspaceId],
    });
    const firstUi = registry.saveWorkspaceUiState({ ...first.summary, expectedRevision: 0, state: { route: 'review' } });
    const secondUi = registry.saveWorkspaceUiState({
      ...first.summary,
      expectedRevision: firstUi.record.revision,
      state: { route: 'file' },
    });

    expect(registry.getWorkbenchSnapshot().workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      second.summary.workspaceId,
      first.summary.workspaceId,
    ]);
    expect(secondUi).toMatchObject({ outcome: 'applied', record: { revision: 2, state: { route: 'file' } } });
    expect(registry.getWorkbenchSnapshot().workspaceUiState[first.summary.workspaceId]).toEqual(secondUi.record);
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(['workspace/orderChanged', 'workspace/uiStateChanged']));
    expect(registry.saveWorkspaceUiState({ ...first.summary, expectedRevision: 1, state: {} })).toMatchObject({
      outcome: 'stale',
      record: { revision: 2, state: { route: 'file' } },
    });
    expect(() =>
      registry.saveWorkspaceUiState({ ...first.summary, workspaceGeneration: 'stale-generation', expectedRevision: 2, state: {} }),
    ).toThrow('generation is stale');
  });
});

class FakeCoreClient extends EventEmitter {
  isRunning = true;
  disposed = false;
  readonly responses = new Map<string, unknown | Promise<unknown>>();
  openRepositoryResponse?: Promise<unknown>;

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'openRepository') {
      if (this.openRepositoryResponse) return (await this.openRepositoryResponse) as T;
      const root = String(params.path);
      return { root, head: `head:${root}` } as T;
    }
    return (await this.responses.get(method)) as T;
  }

  dispose(error = new Error('disposed')): void {
    this.disposed = true;
    this.isRunning = false;
    this.emit('disposed', error);
  }

  emitCoreEvent(event: Omit<CoreEvent, 'jsonrpc'>): void {
    this.emit('event', event);
  }
}

function createRegistry(
  clients: FakeCoreClient[],
  events: WorkbenchEvent[],
  canonicalizeRoot: (root: string) => Promise<string> = async (root) => root,
): LegacyWorkspaceRegistry {
  let id = 0;
  return new LegacyWorkspaceRegistry({
    createClient: () => {
      const client = new FakeCoreClient();
      clients.push(client);
      return client;
    },
    canonicalizeRoot,
    createId: () => `id-${++id}`,
    onEvent: (event) => events.push(event),
  });
}

function context(snapshot: { summary: { workspaceId: string; workspaceGeneration: string } }, requestId: string): WorkspaceRequestContext {
  return { ...snapshot.summary, requestId };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
