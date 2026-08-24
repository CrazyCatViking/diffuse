import { describe, expect, it } from 'vitest';
import type { NativeCoreAddon, NativeCoreAddonCreateOptions, NativeCoreAddonFactory } from './nativeCoreAddon';
import { NativeCoreBackend } from './nativeCoreBackend';

describe('NativeCoreBackend', () => {
  it('validates lifecycle values and preserves request context', async () => {
    const { backend, addon } = createBackend();
    const reference = workspace.summary;
    const context = { ...reference, requestId: 'request-1' };
    addon.requestResult = [{ name: 'main', current: true }];

    await expect(backend.getVersion()).resolves.toEqual({ name: 'diffuse', version: '1.0.0' });
    await expect(backend.getWorkbenchSnapshot()).resolves.toEqual(workbench);
    await expect(backend.openWorkspace('/repo')).resolves.toEqual(workspace);
    await expect(backend.activateWorkspace(reference)).resolves.toEqual(workspace);
    await expect(backend.activateWorkspace(null)).resolves.toBeNull();
    await expect(backend.getWorkspaceSnapshot(reference)).resolves.toEqual(workspace);
    await expect(backend.closeWorkspace(reference)).resolves.toEqual(closedSummary);
    await expect(backend.request(context, 'listBranches', undefined)).resolves.toEqual({
      context,
      result: [{ name: 'main', current: true }],
    });
    expect(addon.requestCalls).toEqual([{ context, method: 'listBranches', params: undefined }]);

    addon.openWorkspaceResult = { summary: {}, repository: {} };
    await expect(backend.openWorkspace('/invalid')).rejects.toMatchObject({ code: 'NATIVE_PROTOCOL_ERROR' });
  });

  it('forwards valid event batches in order and degrades health on invalid ordering', async () => {
    const { backend, addon } = createBackend();
    const batches: unknown[] = [];
    backend.onEvents((events) => batches.push(events));
    const first = event(1, 'search-1');
    const second = event(2, 'search-2');

    addon.emit([first, second]);
    expect(batches).toEqual([[first, second]]);

    addon.emit([second]);
    expect(batches).toHaveLength(1);
    await expect(backend.health()).resolves.toMatchObject({
      status: 'degraded',
      errorCode: 'NATIVE_PROTOCOL_ERROR',
    });
  });

  it('surfaces native error codes with a stable operation message', async () => {
    const { backend, addon } = createBackend();
    addon.requestError = { code: 'WorkspaceNotFound', message: 'workspace disappeared' };

    await expect(backend.request({ ...workspace.summary, requestId: 'request-2' }, 'listBranches', undefined)).rejects.toMatchObject({
      name: 'NativeCoreBackendError',
      code: 'WorkspaceNotFound',
      message: 'Native core request:listBranches failed: workspace disappeared',
    });
  });

  it('shuts the addon down once and rejects later operations', async () => {
    const { backend, addon } = createBackend();

    const first = backend.shutdown();
    const second = backend.shutdown();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(addon.shutdownCalls).toBe(1);
    await expect(backend.health()).resolves.toEqual({ status: 'stopped' });
    await expect(backend.getVersion()).rejects.toMatchObject({ code: 'BACKEND_SHUT_DOWN' });
  });

  it('remains stopping after shutdown rejects and continues reporting native health', async () => {
    const { backend, addon } = createBackend();
    addon.shutdownError = new Error('shutdown failed');
    addon.healthResult = { status: 'unhealthy', message: 'native core is still reachable' };

    await expect(backend.shutdown()).rejects.toMatchObject({ message: 'Native core shutdown failed: shutdown failed' });
    await expect(backend.health()).resolves.toEqual(addon.healthResult);
    expect(addon.healthCalls).toBe(1);
    await expect(backend.getVersion()).rejects.toMatchObject({ code: 'BACKEND_SHUT_DOWN' });
  });

  it('observes native health while shutdown is still pending', async () => {
    const { backend, addon } = createBackend();
    const pending = deferred<void>();
    addon.shutdownResult = pending.promise;
    addon.healthResult = { status: 'stopping' };

    const shutdown = backend.shutdown();
    await expect(backend.health()).resolves.toEqual({ status: 'stopping' });
    addon.healthResult = { status: 'stopped' };
    await expect(backend.health()).resolves.toEqual({ status: 'stopped' });

    pending.resolve();
    await shutdown;
    await expect(backend.health()).resolves.toEqual({ status: 'stopped' });
  });
});

const readySummary = {
  workspaceId: 'workspace-1',
  workspaceGeneration: 'generation-1',
  root: '/repo',
  displayName: 'repo',
  state: 'ready' as const,
  serviceHealth: { repositoryWatcher: 'running' as const },
};
const closedSummary = { ...readySummary, state: 'closed' as const };
const workspace = { summary: readySummary, repository: { root: '/repo', head: 'abc123' } };
const workbench = {
  workspaces: [readySummary],
  activeWorkspaceId: readySummary.workspaceId,
  activeWorkspace: workspace,
  sequence: 0,
};

class FakeAddon implements NativeCoreAddon {
  openWorkspaceResult: unknown = workspace;
  requestResult: unknown;
  requestError: unknown;
  readonly requestCalls: unknown[] = [];
  shutdownCalls = 0;
  shutdownError: unknown;
  shutdownResult: Promise<void> | undefined;
  healthResult: unknown = { status: 'healthy' };
  healthCalls = 0;

  constructor(private readonly onEventBatch: (events: unknown) => void) {}

  async getVersion(): Promise<unknown> {
    return { name: 'diffuse', version: '1.0.0' };
  }

  async getWorkbenchSnapshot(): Promise<unknown> {
    return workbench;
  }

  async openWorkspace(): Promise<unknown> {
    return this.openWorkspaceResult;
  }

  async activateWorkspace(reference: unknown): Promise<unknown> {
    return reference === null ? null : workspace;
  }

  async getWorkspaceSnapshot(): Promise<unknown> {
    return workspace;
  }

  async closeWorkspace(): Promise<unknown> {
    return closedSummary;
  }

  async request(context: unknown, method: unknown, params: unknown): Promise<unknown> {
    this.requestCalls.push({ context, method, params });
    if (this.requestError) throw this.requestError;
    return this.requestResult;
  }

  async health(): Promise<unknown> {
    this.healthCalls += 1;
    return this.healthResult;
  }

  async shutdown(): Promise<unknown> {
    this.shutdownCalls += 1;
    if (this.shutdownError) throw this.shutdownError;
    if (this.shutdownResult) await this.shutdownResult;
    return undefined;
  }

  emit(events: unknown): void {
    this.onEventBatch(events);
  }
}

function createBackend(): { backend: NativeCoreBackend; addon: FakeAddon } {
  let addon!: FakeAddon;
  const factory: NativeCoreAddonFactory = (options: NativeCoreAddonCreateOptions) => {
    addon = new FakeAddon(options.onEventBatch);
    return addon;
  };
  return { backend: new NativeCoreBackend(factory), addon };
}

function event(sequence: number, searchId: string) {
  return {
    sequence,
    eventId: `event-${sequence}`,
    workspaceId: readySummary.workspaceId,
    workspaceGeneration: readySummary.workspaceGeneration,
    kind: 'search/started',
    payload: { searchId },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
