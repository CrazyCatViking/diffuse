import { realpath } from 'node:fs/promises';
import { basename, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CoreEvent, CoreMethod, CoreMethods } from '../src/lib/coreContract';
import type {
  WorkbenchEvent,
  WorkbenchSnapshot,
  WorkspaceCoreMethod,
  WorkspaceReference,
  WorkspaceRequestContext,
  WorkspaceResponse,
  WorkspaceSnapshot,
  WorkspaceSummary,
} from '../src/lib/workbenchContract';
import type { OpenRepositoryResult } from '../src/lib/protocol';
import { CoreRequestTimeoutError } from './coreRpcClient';

type CoreClient = {
  readonly isRunning: boolean;
  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number, options?: { killOnTimeout?: boolean }): Promise<T>;
  dispose(error?: Error): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
};

type WorkspaceEntry = {
  workspaceId: string;
  workspaceGeneration: string;
  root: string;
  canonicalRoot: string;
  repository: OpenRepositoryResult;
  state: 'ready' | 'closing' | 'closed';
  client: CoreClient | null;
  restart: Promise<CoreClient> | null;
};

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace is not open: ${workspaceId}`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export class StaleWorkspaceError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace generation is stale: ${workspaceId}`);
    this.name = 'StaleWorkspaceError';
  }
}

export type LegacyWorkspaceRegistryOptions = {
  createClient: () => CoreClient;
  onEvent?: (event: WorkbenchEvent) => void;
  canonicalizeRoot?: (root: string) => Promise<string>;
  createId?: () => string;
};

export class LegacyWorkspaceRegistry {
  private readonly entries = new Map<string, WorkspaceEntry>();
  private readonly roots = new Map<string, WorkspaceEntry>();
  private activeWorkspaceId: string | null = null;
  private sequence = 0;
  private openQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: LegacyWorkspaceRegistryOptions) {}

  openWorkspace(path: string): Promise<WorkspaceSnapshot> {
    const operation = this.openQueue.then(() => this.openWorkspaceNow(path));
    this.openQueue = operation.catch(() => undefined);
    return operation;
  }

  async request<M extends WorkspaceCoreMethod>(
    context: WorkspaceRequestContext,
    method: M,
    params: CoreMethods[M]['params'],
  ): Promise<WorkspaceResponse<CoreMethods[M]['result']>> {
    const entry = this.requireEntry(context);
    let client = await this.ensureClient(entry, context.workspaceGeneration);

    try {
      const result = await this.requestClient<M>(client, method, params);
      this.requireEntry(context, client);
      return { context, result };
    } catch (error) {
      if (!(error instanceof CoreRequestTimeoutError) || !shouldKillCoreOnTimeout(method)) throw error;
      const current = this.requireEntry(context);
      if (current.client !== client && current.client !== null) throw new StaleWorkspaceError(context.workspaceId);
      client = await this.restartClient(entry, client, context.workspaceGeneration);
      const result = await this.requestClient<M>(client, method, params);
      this.requireEntry(context, client);
      return { context, result };
    }
  }

  activateWorkspace(reference: WorkspaceReference): WorkspaceSnapshot {
    const entry = this.requireEntry(reference);
    this.activeWorkspaceId = entry.workspaceId;
    const snapshot = this.snapshot(entry);
    this.publish('workspace/activated', snapshot, entry);
    return snapshot;
  }

  getWorkspaceSnapshot(reference: WorkspaceReference): WorkspaceSnapshot {
    return this.snapshot(this.requireEntry(reference));
  }

  getWorkbenchSnapshot(): WorkbenchSnapshot {
    const workspaces = [...this.entries.values()].filter((entry) => entry.state === 'ready').map((entry) => this.summary(entry));
    const active = this.activeWorkspaceId ? this.entries.get(this.activeWorkspaceId) : undefined;
    return {
      workspaces,
      activeWorkspaceId: active?.state === 'ready' ? active.workspaceId : null,
      activeWorkspace: active?.state === 'ready' ? this.snapshot(active) : null,
      sequence: this.sequence,
    };
  }

  closeWorkspace(reference: WorkspaceReference): WorkspaceSummary {
    const entry = this.requireEntry(reference);
    entry.state = 'closing';
    const client = entry.client;
    entry.client = null;
    client?.dispose(new StaleWorkspaceError(entry.workspaceId));
    entry.state = 'closed';
    if (this.activeWorkspaceId === entry.workspaceId) this.activeWorkspaceId = null;
    const summary = this.summary(entry);
    this.publish('workspace/removed', summary, entry);
    return summary;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.client?.dispose();
      entry.client = null;
      entry.state = 'closed';
    }
    this.activeWorkspaceId = null;
  }

  private async openWorkspaceNow(path: string): Promise<WorkspaceSnapshot> {
    if (!path.trim()) throw new Error('Workspace path is required');

    const candidate = this.options.createClient();
    let repository: OpenRepositoryResult;
    try {
      repository = await candidate.request<OpenRepositoryResult>('openRepository', { path }, requestTimeoutMs('openRepository'));
    } catch (error) {
      candidate.dispose();
      throw error;
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await (this.options.canonicalizeRoot ?? canonicalizeRoot)(repository.root);
    } catch (error) {
      candidate.dispose();
      throw error;
    }
    const known = this.roots.get(canonicalRoot);
    if (known?.state === 'ready') {
      candidate.dispose();
      return this.activateWorkspace(known);
    }

    const entry: WorkspaceEntry = known ?? {
      workspaceId: this.createId(),
      workspaceGeneration: '',
      root: repository.root,
      canonicalRoot,
      repository,
      state: 'closed',
      client: null,
      restart: null,
    };
    entry.workspaceGeneration = this.createId();
    entry.root = repository.root;
    entry.canonicalRoot = canonicalRoot;
    entry.repository = repository;
    entry.state = 'ready';
    entry.client = candidate;
    entry.restart = null;
    this.entries.set(entry.workspaceId, entry);
    this.roots.set(canonicalRoot, entry);
    this.bindClient(entry, candidate, entry.workspaceGeneration);
    this.activeWorkspaceId = entry.workspaceId;

    const snapshot = this.snapshot(entry);
    this.publish('workspace/added', snapshot.summary, entry);
    this.publish('workspace/activated', snapshot, entry);
    return snapshot;
  }

  private async ensureClient(entry: WorkspaceEntry, generation: string): Promise<CoreClient> {
    if (entry.client?.isRunning) return entry.client;
    return this.restartClient(entry, entry.client, generation);
  }

  private async restartClient(entry: WorkspaceEntry, previous: CoreClient | null, generation: string): Promise<CoreClient> {
    this.requireEntry({ workspaceId: entry.workspaceId, workspaceGeneration: generation });
    if (entry.restart) return entry.restart;
    if (previous && entry.client !== previous && entry.client !== null) throw new StaleWorkspaceError(entry.workspaceId);
    if (entry.client === previous) entry.client = null;

    const operation = this.startReplacementClient(entry, previous, generation);
    entry.restart = operation;
    try {
      return await operation;
    } finally {
      if (entry.restart === operation) entry.restart = null;
    }
  }

  private async startReplacementClient(entry: WorkspaceEntry, previous: CoreClient | null, generation: string): Promise<CoreClient> {
    const client = this.options.createClient();
    try {
      const repository = await client.request<OpenRepositoryResult>(
        'openRepository',
        { path: entry.root },
        requestTimeoutMs('openRepository'),
      );
      this.requireEntry({ workspaceId: entry.workspaceId, workspaceGeneration: generation });
      if (entry.client !== null) throw new StaleWorkspaceError(entry.workspaceId);
      entry.repository = repository;
      entry.root = repository.root;
      entry.client = client;
      this.bindClient(entry, client, generation);
      previous?.dispose();
      return client;
    } catch (error) {
      client.dispose();
      throw error;
    }
  }

  private requestClient<M extends WorkspaceCoreMethod>(
    client: CoreClient,
    method: M,
    params: CoreMethods[M]['params'],
  ): Promise<CoreMethods[M]['result']> {
    return client.request<CoreMethods[M]['result']>(method, (params ?? {}) as Record<string, unknown>, requestTimeoutMs(method), {
      killOnTimeout: shouldKillCoreOnTimeout(method),
    });
  }

  private bindClient(entry: WorkspaceEntry, client: CoreClient, generation: string): void {
    client.on('event', (event: CoreEvent) => {
      if (entry.state !== 'ready' || entry.client !== client || entry.workspaceGeneration !== generation) return;
      this.publish(event.method, event.params, entry);
    });
    client.on('rpcError', (error: Error) => console.error('Diffuse core reported a JSON-RPC error:', error));
    client.on('protocolError', (error: Error) => console.error('Invalid message from Diffuse core:', error));
    client.once('exit', () => {
      if (entry.client === client) entry.client = null;
    });
  }

  private requireEntry(reference: WorkspaceReference, client?: CoreClient): WorkspaceEntry {
    const entry = this.entries.get(reference.workspaceId);
    if (!entry) throw new WorkspaceNotFoundError(reference.workspaceId);
    if (entry.workspaceGeneration !== reference.workspaceGeneration) throw new StaleWorkspaceError(reference.workspaceId);
    if (entry.state !== 'ready') throw new StaleWorkspaceError(reference.workspaceId);
    if (client && entry.client !== client) throw new StaleWorkspaceError(reference.workspaceId);
    return entry;
  }

  private summary(entry: WorkspaceEntry): WorkspaceSummary {
    return {
      workspaceId: entry.workspaceId,
      workspaceGeneration: entry.workspaceGeneration,
      root: entry.root,
      displayName: basename(entry.root) || entry.root,
      state: entry.state,
    };
  }

  private snapshot(entry: WorkspaceEntry): WorkspaceSnapshot {
    return { summary: this.summary(entry), repository: entry.repository };
  }

  private publish(kind: WorkbenchEvent['kind'], payload: WorkbenchEvent['payload'], entry: WorkspaceEntry): void {
    this.sequence += 1;
    this.options.onEvent?.({
      sequence: this.sequence,
      eventId: this.createId(),
      kind,
      workspaceId: entry.workspaceId,
      workspaceGeneration: entry.workspaceGeneration,
      payload,
    } as WorkbenchEvent);
  }

  private createId(): string {
    return (this.options.createId ?? randomUUID)();
  }
}

export function requestTimeoutMs(method: CoreMethod): number {
  if (method === 'installTreeSitterGrammar') return 5 * 60_000;
  if (method === 'syncTreeSitterRegistry') return 2 * 60_000;
  if (method === 'getSyntaxSpans' || method === 'getLspHover' || method === 'getLspDiagnostics') return 10_000;
  return 30_000;
}

export function shouldKillCoreOnTimeout(method: CoreMethod): boolean {
  return method !== 'getSyntaxSpans' && method !== 'getLspHover' && method !== 'getLspDiagnostics';
}

async function canonicalizeRoot(root: string): Promise<string> {
  const resolved = normalize(await realpath(root));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}
