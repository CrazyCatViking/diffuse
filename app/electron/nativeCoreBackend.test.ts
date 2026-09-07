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
    await expect(backend.closeWorkspace({ ...reference, force: false })).resolves.toEqual(closedSummary);
    expect(addon.closeCalls).toEqual([
      {
        workspaceId: reference.workspaceId,
        workspaceGeneration: reference.workspaceGeneration,
        force: false,
      },
    ]);
    await expect(backend.dismissRestoreFailure('workspace-failed')).resolves.toEqual({
      workspaceId: 'workspace-failed',
      dismissed: true,
    });
    expect(addon.dismissCalls).toEqual(['workspace-failed']);
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

  it('validates every Phase 5 mutation envelope and native invocation shape', async () => {
    const { backend, addon } = createBackend();
    const reference = { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' };
    const item = attentionItem(1);
    const input = inputRequest(1);
    const attentionResult = { outcome: 'applied', item, summary: readySummary.attention } as const;
    const inputAttention = { ...item, sourceId: input.id };
    const inputResult = { outcome: 'applied', input, attention: inputAttention, summary: readySummary.attention } as const;

    expect(await backend.reorderWorkspaces(['workspace-1'])).toEqual({ workspaceIds: ['workspace-1'] });
    expect(await backend.saveWorkspaceUiState({ ...reference, expectedRevision: 0, state: { route: 'review' } })).toMatchObject({
      outcome: 'applied',
      record: { revision: 1 },
    });
    addon.phase5Result = attentionResult;
    await expect(
      backend.createAttention({
        ...reference,
        id: item.id,
        sourceId: item.sourceId,
        kind: item.kind,
        revision: 1,
        target: item.target,
      }),
    ).resolves.toEqual(attentionResult);
    addon.phase5Result = { ...attentionResult, item: { ...item, status: 'acknowledged' } };
    await expect(backend.acknowledgeAttention({ ...reference, attentionId: item.id, expectedRevision: 1 })).resolves.toEqual(
      addon.phase5Result,
    );
    addon.phase5Result = attentionResult;
    await expect(backend.claimAttentionNotification({ ...reference, attentionId: item.id, expectedRevision: 1 })).resolves.toEqual(
      attentionResult,
    );

    addon.phase5Result = inputResult;
    await expect(
      backend.createInputRequest({ ...reference, id: input.id, revision: 1, kind: input.kind, prompt: input.prompt }),
    ).resolves.toEqual(inputResult);
    const cas = { ...reference, inputRequestId: input.id, expectedRevision: 1 };
    addon.phase5Result = inputMutation(input, inputAttention, 'response-submitted');
    await expect(backend.answerInputRequest({ ...cas, response: { value: 'Allow' } })).resolves.toEqual(addon.phase5Result);
    addon.phase5Result = inputMutation(input, inputAttention, 'accepted');
    await expect(backend.acceptInputRequest(cas)).resolves.toEqual(addon.phase5Result);
    addon.phase5Result = inputMutation(input, inputAttention, 'rejected');
    await expect(backend.rejectInputRequest(cas)).resolves.toEqual(addon.phase5Result);
    addon.phase5Result = inputMutation(input, inputAttention, 'cancelled');
    await expect(backend.cancelInputRequest(cas)).resolves.toEqual(addon.phase5Result);
    addon.phase5Result = inputMutation(input, inputAttention, 'expired');
    await expect(backend.expireInputRequest(cas)).resolves.toEqual(addon.phase5Result);
    addon.phase5Result = inputMutation(input, inputAttention, 'superseded');
    await expect(backend.supersedeInputRequest(cas)).resolves.toEqual(addon.phase5Result);

    expect(addon.phase5Calls).toEqual(
      expect.arrayContaining([
        {
          operation: 'saveWorkspaceUiState',
          args: [{ ...reference, expectedRevision: 0, state: { route: 'review' } }],
        },
        { operation: 'answerInputRequest', args: [{ ...cas, response: { value: 'Allow' } }] },
      ]),
    );
  });

  it('rejects invalid Phase 5 result identities and revisions', async () => {
    const { backend, addon } = createBackend();
    addon.phase5Result = {
      outcome: 'applied',
      item: { ...attentionItem(2), workspaceId: 'workspace-other' },
      summary: readySummary.attention,
    };

    await expect(
      backend.acknowledgeAttention({
        workspaceId: 'workspace-1',
        workspaceGeneration: 'generation-1',
        attentionId: 'attention-1',
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PROTOCOL_ERROR' });

    await expect(
      backend.saveWorkspaceUiState({
        workspaceId: 'workspace-1',
        workspaceGeneration: '',
        expectedRevision: 0,
        state: {},
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    addon.uiStateResult = {
      outcome: 'applied',
      record: { revision: 4, state: {}, updatedAt: '2026-09-02T10:00:00.000Z' },
    };
    await expect(
      backend.saveWorkspaceUiState({
        workspaceId: 'workspace-1',
        workspaceGeneration: 'generation-1',
        expectedRevision: 1,
        state: {},
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PROTOCOL_ERROR' });

    addon.uiStateResult = {
      outcome: 'stale',
      record: { revision: 4, state: { logicalFocus: 'current' }, updatedAt: '2026-09-02T10:00:00.000Z' },
    };
    await expect(
      backend.saveWorkspaceUiState({
        workspaceId: 'workspace-1',
        workspaceGeneration: 'generation-1',
        expectedRevision: 1,
        state: { logicalFocus: 'local' },
      }),
    ).resolves.toEqual(addon.uiStateResult);

    addon.uiStateResult = {
      outcome: 'stale',
      record: { revision: 1, state: {}, updatedAt: '2026-09-02T10:00:00.000Z' },
    };
    await expect(
      backend.saveWorkspaceUiState({
        workspaceId: 'workspace-1',
        workspaceGeneration: 'generation-1',
        expectedRevision: 1,
        state: {},
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PROTOCOL_ERROR' });
  });

  it('accepts Rust-shaped applied input mutations that retain the CAS revision', async () => {
    const { backend, addon } = createBackend();
    const reference = { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' };
    const input = inputRequest(7);
    const attention = { ...attentionItem(7), sourceId: input.id };
    const cas = { ...reference, inputRequestId: input.id, expectedRevision: 7 };

    addon.phase5Result = { ...inputMutation(input, attention, 'response-submitted'), outcome: 'applied' };
    await expect(backend.answerInputRequest({ ...cas, response: { value: 'Allow' } })).resolves.toEqual(addon.phase5Result);
    addon.phase5Result = { ...inputMutation(input, attention, 'cancelled'), outcome: 'applied' };
    await expect(backend.cancelInputRequest(cas)).resolves.toEqual(addon.phase5Result);

    addon.phase5Result = {
      ...inputMutation({ ...input, revision: 8 }, { ...attention, revision: 8 }, 'cancelled'),
      outcome: 'applied',
    };
    await expect(backend.cancelInputRequest(cas)).rejects.toMatchObject({ code: 'NATIVE_PROTOCOL_ERROR' });
  });
});

const readySummary = {
  workspaceId: 'workspace-1',
  workspaceGeneration: 'generation-1',
  root: '/repo',
  displayName: 'repo',
  state: 'ready' as const,
  serviceHealth: { repositoryWatcher: 'running' as const },
  attention: { state: 'idle' as const, inputRequired: 0, errors: 0, unread: 0, running: 0, total: 0 },
};
const closedSummary = { ...readySummary, state: 'closed' as const };
const workspace = { summary: readySummary, repository: { root: '/repo', head: 'abc123' } };
const workbench = {
  workspaces: [readySummary],
  activeWorkspaceId: readySummary.workspaceId,
  activeWorkspace: workspace,
  aggregateAttention: readySummary.attention,
  attentionItems: [],
  inputRequests: [],
  workspaceUiState: {},
  legacyReviewImports: [],
  sequence: 0,
};

class FakeAddon implements NativeCoreAddon {
  openWorkspaceResult: unknown = workspace;
  requestResult: unknown;
  requestError: unknown;
  readonly requestCalls: unknown[] = [];
  readonly closeCalls: unknown[] = [];
  readonly dismissCalls: string[] = [];
  shutdownCalls = 0;
  shutdownError: unknown;
  shutdownResult: Promise<void> | undefined;
  healthResult: unknown = { status: 'healthy' };
  healthCalls = 0;
  phase5Result: unknown;
  uiStateResult: unknown;
  readonly phase5Calls: Array<{ operation: string; args: unknown[] }> = [];

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

  async closeWorkspace(request: unknown): Promise<unknown> {
    this.closeCalls.push(request);
    return closedSummary;
  }

  async dismissRestoreFailure(workspaceId: string): Promise<unknown> {
    this.dismissCalls.push(workspaceId);
    return { workspaceId, dismissed: true };
  }

  async reorderWorkspaces(workspaceIds: string[]): Promise<unknown> {
    this.phase5Calls.push({ operation: 'reorderWorkspaces', args: [workspaceIds] });
    return { workspaceIds };
  }

  async saveWorkspaceUiState(request: {
    workspaceId: string;
    workspaceGeneration: string;
    expectedRevision: number;
    state: Record<string, unknown>;
  }): Promise<unknown> {
    this.phase5Calls.push({ operation: 'saveWorkspaceUiState', args: [request] });
    return (
      this.uiStateResult ?? {
        outcome: 'applied',
        record: {
          revision: request.expectedRevision + 1,
          state: request.state,
          updatedAt: '2026-09-02T10:00:00.000Z',
        },
      }
    );
  }

  async createAttention(request: unknown): Promise<unknown> {
    return this.phase5('createAttention', request);
  }

  async acknowledgeAttention(request: unknown): Promise<unknown> {
    return this.phase5('acknowledgeAttention', request);
  }

  async claimAttentionNotification(request: unknown): Promise<unknown> {
    return this.phase5('claimAttentionNotification', request);
  }

  async createInputRequest(request: unknown): Promise<unknown> {
    return this.phase5('createInputRequest', request);
  }

  async answerInputRequest(request: unknown): Promise<unknown> {
    return this.phase5('answerInputRequest', request);
  }

  async acceptInputRequest(request: unknown): Promise<unknown> {
    return this.phase5('acceptInputRequest', request);
  }

  async rejectInputRequest(request: unknown): Promise<unknown> {
    return this.phase5('rejectInputRequest', request);
  }

  async cancelInputRequest(request: unknown): Promise<unknown> {
    return this.phase5('cancelInputRequest', request);
  }

  async expireInputRequest(request: unknown): Promise<unknown> {
    return this.phase5('expireInputRequest', request);
  }

  async supersedeInputRequest(request: unknown): Promise<unknown> {
    return this.phase5('supersedeInputRequest', request);
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

  private phase5(operation: string, ...args: unknown[]): unknown {
    this.phase5Calls.push({ operation, args });
    return this.phase5Result;
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

function attentionItem(revision: number) {
  return {
    id: 'attention-1',
    workspaceId: 'workspace-1',
    sourceId: 'source-1',
    kind: 'input' as const,
    revision,
    status: 'unread' as const,
    target: { kind: 'input' as const, inputRequestId: 'input-1' },
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:01:00.000Z',
  };
}

function inputRequest(revision: number) {
  return {
    id: 'input-1',
    workspaceId: 'workspace-1',
    revision,
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

function inputMutation(input: ReturnType<typeof inputRequest>, attention: ReturnType<typeof attentionItem>, status: string) {
  return {
    outcome: 'unchanged' as const,
    input: { ...input, status },
    attention,
    summary: readySummary.attention,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
