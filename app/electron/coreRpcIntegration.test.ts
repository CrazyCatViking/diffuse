import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreEvent } from '../src/lib/coreContract';
import type { WorkbenchEvent } from '../src/lib/workbenchContract';
import type {
  ChangedFile,
  DiffRenderModel,
  DiffTargetDefaults,
  OpenRepositoryResult,
  ReviewProgress,
  ReviewSession,
} from '../src/lib/protocol';
import { createRepositoryFixture, type RepositoryFixture } from '../src/test/repositoryFixture';
import { CoreRpcClient, CoreRpcError } from './coreRpcClient';
import { LegacyWorkspaceRegistry } from './legacyWorkspaceRegistry';

const executable = process.env.DIFFUSE_CORE_EXECUTABLE
  ? resolve(process.env.DIFFUSE_CORE_EXECUTABLE)
  : resolve('../core/zig-out/bin', platform() === 'win32' ? 'diffuse.exe' : 'diffuse');

describe('core RPC baseline', () => {
  let fixture: RepositoryFixture;
  let child: ChildProcessWithoutNullStreams;
  let client: CoreRpcClient;

  beforeAll(() => {
    if (!existsSync(executable)) throw new Error(`Build the core before running integration tests: ${executable}`);
    fixture = createRepositoryFixture();
    child = spawn(executable, ['rpc'], { stdio: 'pipe' });
    client = new CoreRpcClient(child);
  });

  afterAll(() => {
    client?.dispose();
    fixture?.dispose();
  });

  it('reports stable method and parameter errors', async () => {
    await expect(client.request('unknownMethod')).rejects.toMatchObject({ code: -32601 } satisfies Partial<CoreRpcError>);
    await expect(client.request('openRepository')).rejects.toMatchObject({ code: -32602 } satisfies Partial<CoreRpcError>);
  });

  it('opens a deterministic repository and exposes target defaults', async () => {
    const opened = await client.request<OpenRepositoryResult>('openRepository', { path: fixture.root });
    const defaults = await client.request<DiffTargetDefaults>('getDiffTargetDefaults');

    expect(opened.root).toBe(fixture.root);
    expect(opened.head).toMatch(/^[0-9a-f]+$/);
    expect(defaults).toMatchObject({ includeStaged: true, includeUnstaged: true, dirty: true });
  });

  it('lists and renders deterministic working-tree changes', async () => {
    const target = { includeStaged: true, includeUnstaged: true };
    const files = await client.request<ChangedFile[]>('listChangedFiles', { target });
    const paths = files.map((file) => file.newPath ?? file.oldPath).sort();
    const model = await client.request<DiffRenderModel>('getDiffRenderModel', {
      fileId: 'src/main.ts',
      options: { mode: 'inline', context: 'diff' },
      target,
    });

    expect(paths).toEqual(['docs/removed.md', 'src/main.ts', 'src/new.ts', 'src/renamed.ts']);
    expect(model).toMatchObject({ fileId: 'src/main.ts', mode: 'inline', context: 'diff' });
    expect(JSON.stringify(model.rows)).toContain('answer = 41');
    expect(JSON.stringify(model.rows)).toContain('answer = 42');
  });

  it('round-trips review persistence and emits review events', async () => {
    const events: CoreEvent[] = [];
    const listener = (event: CoreEvent) => events.push(event);
    client.on('event', listener);
    const session: ReviewSession = {
      id: 'review-fixture',
      repositoryRoot: fixture.root,
      target: { includeStaged: true, includeUnstaged: true },
      headAtCreation: 'fixture-head',
      createdAt: '2024-01-02T03:04:05.000Z',
      updatedAt: '2024-01-02T03:04:05.000Z',
      status: 'active',
      participants: [],
    };
    const progress: ReviewProgress = { status: 'running', totalFiles: 4, reviewedFiles: 1, message: 'fixture progress' };

    await expect(client.request('createReviewSession', { session })).resolves.toEqual(session);
    await expect(client.request('saveReviewProgress', { sessionId: session.id, progress })).resolves.toEqual(progress);
    await expect(client.request('getReviewProgress', { sessionId: session.id })).resolves.toEqual(progress);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'review/changed', params: expect.objectContaining({ sessionId: session.id }) }),
      ]),
    );
    client.off('event', listener);
  });

  it('streams search lifecycle events under an explicit deterministic id', async () => {
    const events: CoreEvent[] = [];
    const done = new Promise<void>((resolveDone, reject) => {
      const listener = (event: CoreEvent) => {
        if (!('searchId' in event.params) || event.params.searchId !== 'search-fixture') return;
        events.push(event);
        if (event.method === 'search/error') reject(new Error(event.params.message));
        if (event.method === 'search/done') {
          client.off('event', listener);
          resolveDone();
        }
      };
      client.on('event', listener);
    });

    await client.request('startSearch', {
      searchId: 'search-fixture',
      sessionId: 'review-fixture',
      query: 'answer',
      mode: 'content',
      filters: [],
      target: { includeStaged: true, includeUnstaged: true },
    });
    await done;

    expect(events.map((event) => event.method)).toEqual(
      expect.arrayContaining(['search/started', 'search/results', 'search/progress', 'search/done']),
    );
  });

  it('addresses two repositories independently through the workspace facade', async () => {
    const secondFixture = createRepositoryFixture();
    const events: WorkbenchEvent[] = [];
    const registry = new LegacyWorkspaceRegistry({
      createClient: () => new CoreRpcClient(spawn(executable, ['rpc'], { stdio: 'pipe' })),
      onEvent: (event) => events.push(event),
    });

    try {
      const first = await registry.openWorkspace(fixture.root);
      const second = await registry.openWorkspace(secondFixture.root);
      const target = { includeStaged: true, includeUnstaged: true };
      const [firstFiles, secondFiles] = await Promise.all([
        registry.request({ ...first.summary, requestId: 'request-first' }, 'listChangedFiles', { target }),
        registry.request({ ...second.summary, requestId: 'request-second' }, 'listChangedFiles', { target }),
      ]);

      expect(first.summary.workspaceId).not.toBe(second.summary.workspaceId);
      expect(first.repository.root).toBe(fixture.root);
      expect(second.repository.root).toBe(secondFixture.root);
      expect(firstFiles.context.requestId).toBe('request-first');
      expect(secondFiles.context.requestId).toBe('request-second');
      expect(firstFiles.result).toHaveLength(4);
      expect(secondFiles.result).toHaveLength(4);
      expect(events.filter((event) => event.kind === 'workspace/added')).toHaveLength(2);
    } finally {
      registry.dispose();
      secondFixture.dispose();
    }
  });
});
