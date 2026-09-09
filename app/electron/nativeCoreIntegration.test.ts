import { realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AcpEventBatch } from '../src/lib/acpContract';
import type { WorkbenchEvent, WorkspaceRequestContext } from '../src/lib/workbenchContract';
import { createRepositoryFixture } from '../src/test/repositoryFixture';
import { loadNativeAddonFactory } from './nativeCoreAddon';
import { NativeCoreBackend } from './nativeCoreBackend';
import { createPinia, setActivePinia } from 'pinia';
import { useReviewAcpStore } from '../src/stores/reviewAcp';
import { useWorkbenchStore } from '../src/stores/workbench';
import { useAcpStore } from '../src/stores/acp';
import { createMockDesktopBridge } from '../src/test/mockDesktopBridge';
import { acpMethodNames, record } from '../src/lib/acpContract';
import { acpContentText } from '../src/lib/acpPresentation';
import { AcpReviewWaves } from './acpReviewWaves';

const target = { base: 'HEAD', includeStaged: true, includeUnstaged: true };

describe('native core addon integration', () => {
  it.skipIf(process.platform === 'win32')(
    'executes oversized review targets as native enforced waves without a renderer',
    async () => {
      const fixture = createRepositoryFixture();
      mkdirSync(resolve(fixture.root, 'waves'));
      for (let i = 0; i < 1030; i++) writeFileSync(resolve(fixture.root, `waves/file-${String(i).padStart(4, '0')}.txt`), 'fixture\n');
      execFileSync('git', ['-C', fixture.root, 'add', 'waves']);
      const backend = new NativeCoreBackend(loadNativeAddonFactory({ cwd: resolve('.') }), { databasePath: ':memory:' });
      const scheduler = new AcpReviewWaves(backend);
      vi.spyOn(scheduler, 'startPolling').mockImplementation(() => undefined);
      try {
        const workspace = await backend.openWorkspace(fixture.root);
        const c = context(workspace.summary, 'waves');
        await backend.saveAcpAdapter({
          id: 'waves',
          executable: resolve('../target/debug/diffuse-acp-fixture'),
          args: ['mcp'],
          environmentKeys: [],
          authenticationProfile: null,
          multiplex: false,
        });
        await backend.request(c, 'saveReviewConfig', {
          config: { provider: 'opencode', maxParallelAgents: 1, promptInstructions: 'Review this target' },
        });
        await backend.request(c, 'createReviewSession', {
          session: {
            id: 'waves-review',
            repositoryRoot: workspace.summary.root,
            headAtCreation: workspace.repository.head,
            target,
            title: 'Waves',
            status: 'active',
            participants: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        });
        const run = await scheduler.start({ context: c, reviewSessionId: 'waves-review', adapterId: 'waves' });
        expect(run.shards.length).toBe(2);
        expect(run.shards.flatMap((shard) => shard.fileIds)).toHaveLength(1034);
        expect(run.prompt.length).toBeLessThan(2048);
        await vi.waitFor(
          async () => {
            await scheduler.pump();
            const snapshot = await backend.getAcpSnapshot(c);
            expect(snapshot.sessions.filter((s) => ['ready', 'starting', 'running'].includes(s.state)).length).toBeLessThanOrEqual(1);
            expect((await scheduler.list(c))[0].status).toBe('completed');
          },
          { timeout: 30000, interval: 50 },
        );
        const snapshot = await backend.getAcpSnapshot(c);
        expect(snapshot.sessions).toHaveLength(2);
        expect(snapshot.sessions.every((s) => s.reviewFileIds && s.reviewFileIds.length <= 1024 && s.state === 'closed')).toBe(true);
        scheduler.dispose();
        const restored = new AcpReviewWaves(backend);
        expect((await restored.list(c))[0].status).toBe('completed');
        restored.dispose();
      } finally {
        scheduler.dispose();
        await backend.shutdown();
        fixture.dispose();
      }
    },
    40000,
  );

  it.skipIf(process.platform === 'win32')(
    'runs the actual reviewAcp store through native creation, sharded review, inline chat, and saved reconnect',
    async () => {
      const fixture = createRepositoryFixture();
      const backend = new NativeCoreBackend(loadNativeAddonFactory({ cwd: resolve('.') }), { databasePath: ':memory:' });
      const storage = new Map<string, string>();
      const bridge = createMockDesktopBridge();
      Object.assign(
        bridge,
        Object.fromEntries(
          acpMethodNames.map((method) => [
            method,
            (request: unknown) => (backend[method] as (request: unknown) => Promise<unknown>)(request),
          ]),
        ),
      );
      bridge.workspaceRequest.mockImplementation((context, method, ...args) => backend.request(context, method, args[0]));
      bridge.saveWorkspaceUiState.mockImplementation((reference, expectedRevision, state) =>
        backend.saveWorkspaceUiState({ ...reference, expectedRevision, state }),
      );
      vi.stubGlobal('window', {
        diffuse: bridge,
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      });
      setActivePinia(createPinia());
      try {
        const opened = await backend.openWorkspace(fixture.root);
        const c = context(opened.summary, 'review-store');
        await backend.saveAcpAdapter({
          id: 'store-fixture',
          executable: resolve('../target/debug/diffuse-acp-fixture'),
          args: ['mcp'],
          environmentKeys: [],
          authenticationProfile: null,
          multiplex: false,
        });
        await backend.request(c, 'saveReviewConfig', {
          config: { provider: 'opencode', maxParallelAgents: 2, promptInstructions: 'Check tests' },
        });
        const review = (
          await backend.request(c, 'createReviewSession', {
            session: {
              id: 'store-review',
              repositoryRoot: opened.summary.root,
              headAtCreation: opened.repository.head,
              target,
              title: 'Store review',
              status: 'active',
              participants: [],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          })
        ).result;
        const workbench = useWorkbenchStore();
        workbench.workspaces = [opened.summary];
        workbench.activeWorkspaceId = opened.summary.workspaceId;
        const store = useReviewAcpStore();
        await store.activate(opened.summary, review.id);
        await expect(
          backend.openAcpSession({
            context: c,
            adapterId: 'store-fixture',
            reviewSessionId: review.id,
            interactive: false,
            sessionId: crypto.randomUUID(),
          }),
        ).rejects.toThrow();
        const open = vi.spyOn(backend, 'openAcpSession');
        await store.queue(opened.summary, review, 'store-fixture');
        expect(open).toHaveBeenCalledTimes(2);
        expect(
          open.mock.calls.every(
            ([request]) => request.sessionId === undefined && request.reviewSessionId === review.id && request.interactive === false,
          ),
        ).toBe(true);
        expect(store.runGroups[0]).toMatchObject({ total: 2, fileCount: 4 });
        const thread = {
          id: 'native-thread',
          sessionId: review.id,
          fileId: 'src/main.ts',
          anchor: { side: 'new' as const, startLine: 1, endLine: 1, diffTargetFingerprint: 'target' },
          status: 'open' as const,
          createdAt: review.createdAt,
          updatedAt: review.updatedAt,
          messages: [],
        };
        await store.queue(opened.summary, review, 'store-fixture', 'Explain this selection', thread);
        await vi.waitFor(
          async () => {
            await useAcpStore().refresh(c.workspaceId);
            await store.refreshHistory();
            expect(store.messages.some((m) => m.role === 'assistant' && m.body === 'hello')).toBe(true);
          },
          { timeout: 10000 },
        );
        const chat = store.bindings.find((b) => b.kind === 'chat')!;
        expect(chat.sessionId).toBe((await backend.getAcpSnapshot(c)).sessions.find((s) => s.id === chat.sessionId)?.id);
        await store.stop(chat.sessionId);
        await vi.waitFor(async () =>
          expect((await backend.getAcpSnapshot(c)).sessions.find((s) => s.id === chat.sessionId)?.state).toBe('closed'),
        );
        await store.queue(opened.summary, review, 'store-fixture', 'Follow up', thread);
        expect(open.mock.calls.at(-1)?.[0].sessionId).toBe(chat.sessionId);
        expect(open.mock.calls.slice(0, 3).every(([request]) => request.sessionId === undefined)).toBe(true);
        const shard = store.runs[0];
        const scoped = (await backend.getAcpSnapshot(c)).sessions.find((session) => session.id === shard.sessionId)!;
        expect(scoped.reviewFileIds).toEqual([...shard.fileIds!].sort());
        const files = (await backend.request(c, 'listChangedFiles', { target })).result;
        const outside = files.find((file) => !scoped.reviewFileIds!.includes(file.id) && file.newPath)!;
        const toolCalls = [
          { name: 'listChangedFiles', arguments: {}, denied: false },
          { name: 'readDiff', arguments: { fileId: outside.id }, denied: true },
          {
            name: 'addFinding',
            arguments: { filePath: outside.newPath, side: 'new', startLine: 1, endLine: 1, body: 'Out-of-shard finding must be rejected' },
            denied: true,
          },
          {
            name: 'updateReviewedFiles',
            arguments: {
              files: {
                [outside.id]: { fileId: outside.id, signature: outside.signature, reviewedAt: '2026-01-01T00:00:00Z', reviewedBy: 'agent' },
              },
            },
            denied: true,
          },
        ];
        for (const tool of toolCalls) {
          const turn = await backend.queueAcpPrompt({
            context: { ...c, requestId: crypto.randomUUID() },
            sessionId: shard.sessionId,
            text: `mcp:${JSON.stringify({ name: tool.name, arguments: tool.arguments })}`,
          });
          await vi.waitFor(async () =>
            expect((await backend.getAcpSnapshot(c)).turnsBySession[shard.sessionId].find((t) => t.id === turn.id)?.state).toBe(
              'completed',
            ),
          );
          const entry = (await backend.getAcpHistory({ context: c, sessionId: shard.sessionId })).find(
            (h) => h.turnId === turn.id && h.kind === 'agent-message',
          )!;
          const response = JSON.parse(acpContentText(record(entry.content) ? (entry.content.content ?? entry.content) : entry.content));
          expect(response.result.isError).toBe(tool.denied);
          if (!tool.denied)
            expect(
              JSON.parse(response.result.content[0].text)
                .map((file: { id: string }) => file.id)
                .sort(),
            ).toEqual(scoped.reviewFileIds);
        }
        expect((await backend.request(c, 'getReviewThreads', { sessionId: review.id })).result).toEqual([]);
        let completedFiles = 0;
        for (const binding of store.runs) {
          const ids = binding.fileIds!;
          const turn = await backend.queueAcpPrompt({
            context: { ...c, requestId: crypto.randomUUID() },
            sessionId: binding.sessionId,
            text: `mcp:${JSON.stringify({ name: 'updateProgress', arguments: { status: 'completed', totalFiles: ids.length, reviewedFiles: ids.length, activeFiles: [], pendingFiles: [], completedFiles: ids } })}`,
          });
          await vi.waitFor(async () =>
            expect((await backend.getAcpSnapshot(c)).turnsBySession[binding.sessionId].find((t) => t.id === turn.id)?.state).toBe(
              'completed',
            ),
          );
          completedFiles += ids.length;
          const progress = (await backend.request(c, 'getReviewProgress', { sessionId: review.id })).result;
          expect(progress?.totalFiles).toBe(4);
          expect(progress?.reviewedFiles).toBe(completedFiles);
        }
        expect((await backend.request(c, 'getReviewProgress', { sessionId: review.id })).result?.status).toBe('completed');
        await expect(
          backend.openAcpSession({
            context: c,
            adapterId: 'store-fixture',
            sessionId: shard.sessionId,
            reviewSessionId: review.id,
            reviewFileIds: [outside.id],
          }),
        ).rejects.toThrow('reviewFileIds');
        await backend.closeAcpSession({ context: c, sessionId: shard.sessionId });
        await vi.waitFor(async () =>
          expect((await backend.getAcpSnapshot(c)).sessions.find((s) => s.id === shard.sessionId)?.state).toBe('closed'),
        );
        await backend.openAcpSession({ context: c, adapterId: 'store-fixture', sessionId: shard.sessionId, reviewSessionId: review.id });
        await vi.waitFor(async () =>
          expect((await backend.getAcpSnapshot(c)).sessions.find((s) => s.id === shard.sessionId)?.state).toBe('ready'),
        );
        expect((await backend.getAcpSnapshot(c)).sessions.find((s) => s.id === shard.sessionId)?.reviewFileIds).toEqual(
          scoped.reviewFileIds,
        );
        await store.stopReviews();
        await vi.waitFor(() =>
          expect(JSON.stringify(workbench.workspaceUiRecords[c.workspaceId]?.state.reviewAcpBindings)).toBe(
            JSON.stringify(workbench.uiState(c.workspaceId).reviewAcpBindings),
          ),
        );
      } finally {
        await backend.shutdown();
        fixture.dispose();
        vi.unstubAllGlobals();
      }
    },
    30000,
  );

  it.skipIf(process.platform === 'win32')(
    'validates real ACP JSON and concurrent workspace sessions through the desktop backend',
    async () => {
      const first = createRepositoryFixture();
      const second = createRepositoryFixture();
      const backend = new NativeCoreBackend(loadNativeAddonFactory({ cwd: resolve('.') }), { databasePath: ':memory:' });
      const batches: AcpEventBatch[] = [];
      backend.onAcpEventBatch((batch) => batches.push(batch));
      try {
        await backend.saveAcpAdapter({
          id: 'fixture',
          executable: resolve('../target/debug/diffuse-acp-fixture'),
          args: ['modes'],
          environmentKeys: [],
          authenticationProfile: null,
          multiplex: true,
        });
        expect(await backend.discoverAcpAdapters()).toEqual([expect.objectContaining({ available: true, platformSupported: true })]);
        await backend.saveAcpAdapter({
          id: 'fixture-mcp',
          executable: resolve('../target/debug/diffuse-acp-fixture'),
          args: ['mcp'],
          environmentKeys: [],
          authenticationProfile: null,
          multiplex: false,
        });
        const opened = await Promise.all([backend.openWorkspace(first.root), backend.openWorkspace(second.root)]);
        const contexts = opened.map((w) => context(w.summary, 'same-request-id'));
        for (const id of ['acp-review', 'other-review'])
          await backend.request(contexts[0], 'createReviewSession', {
            session: {
              id,
              repositoryRoot: opened[0].summary.root,
              headAtCreation: opened[0].repository.head,
              target,
              title: id,
              status: 'active',
              participants: [],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          });
        const sessions = await Promise.all(
          contexts.map((context, index) =>
            backend.openAcpSession({
              context,
              adapterId: index === 0 ? 'fixture-mcp' : 'fixture',
              interactive: index === 1,
              reviewSessionId: index === 0 ? 'acp-review' : undefined,
            }),
          ),
        );
        await vi.waitFor(
          async () => {
            for (const [index, c] of contexts.entries())
              expect((await backend.getAcpSnapshot(c)).sessions.find((s) => s.id === sessions[index].sessionId)?.state).toBe('ready');
          },
          { timeout: 10000 },
        );
        await backend.setAcpMode({ context: contexts[1], sessionId: sessions[1].sessionId, modeId: 'review' });
        const turns = await Promise.all(
          contexts.map((context, index) => backend.queueAcpPrompt({ context, sessionId: sessions[index].sessionId, text: 'hello' })),
        );
        expect(turns[0].id).not.toBe(turns[1].id);
        await vi.waitFor(
          async () => {
            for (const [index, c] of contexts.entries())
              expect(
                (await backend.getAcpSnapshot(c)).turnsBySession[sessions[index].sessionId].find((t) => t.id === turns[index].id)?.state,
              ).toBe('completed');
          },
          { timeout: 10000 },
        );
        for (const [index, c] of contexts.entries()) {
          const sessionId = sessions[index].sessionId;
          expect(await backend.queueAcpPrompt({ context: c, sessionId, text: 'hello' })).toMatchObject({ id: turns[index].id });
          expect(await backend.getAcpHistory({ context: c, sessionId })).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: 'agent-message', sessionId })]),
          );
          expect(await backend.getAcpActivity({ context: c, sessionId })).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: 'turn-ended', sessionId })]),
          );
        }
        expect((await backend.readAcpEvents({ afterSequence: 0 })).events.length).toBeGreaterThan(0);
        const file = (await backend.request(contexts[0], 'listChangedFiles', { target })).result.find(
          (file) => file.newPath === 'src/main.ts',
        )!;
        const tools = [
          { name: 'addFinding', arguments: { filePath: 'src/main.ts', side: 'new', startLine: 1, endLine: 1, body: 'Native ACP finding' } },
          { name: 'updateProgress', arguments: { status: 'completed', totalFiles: 4, reviewedFiles: 1, message: 'Native ACP progress' } },
          {
            name: 'updateReviewedFiles',
            arguments: {
              files: { [file.id]: { fileId: file.id, signature: file.signature, reviewedAt: '2026-01-01T00:00:00Z', reviewedBy: 'agent' } },
            },
          },
        ];
        for (const [index, tool] of tools.entries()) {
          const turn = await backend.queueAcpPrompt({
            context: { ...contexts[0], requestId: `mcp-${index}` },
            sessionId: sessions[0].sessionId,
            text: `mcp:${JSON.stringify(tool)}`,
          });
          await vi.waitFor(async () =>
            expect(
              (await backend.getAcpSnapshot(contexts[0])).turnsBySession[sessions[0].sessionId].find((t) => t.id === turn.id)?.state,
            ).toBe('completed'),
          );
        }
        expect((await backend.request(contexts[0], 'getReviewThreads', { sessionId: 'acp-review' })).result[0].messages[0].body).toBe(
          'Native ACP finding',
        );
        expect((await backend.request(contexts[0], 'getReviewThreads', { sessionId: 'other-review' })).result).toEqual([]);
        expect((await backend.request(contexts[0], 'getReviewProgress', { sessionId: 'acp-review' })).result?.message).toBe(
          'Native ACP progress',
        );
        expect((await backend.request(contexts[0], 'getReviewedFiles', { sessionId: 'acp-review' })).result.files[file.id].signature).toBe(
          file.signature,
        );
        const denied = await backend.queueAcpPrompt({
          context: { ...contexts[0], requestId: 'deny-permission' },
          sessionId: sessions[0].sessionId,
          text: 'permission',
        });
        await vi.waitFor(async () =>
          expect(
            (await backend.getAcpSnapshot(contexts[0])).turnsBySession[sessions[0].sessionId].find((t) => t.id === denied.id)?.state,
          ).toBe('completed'),
        );
        expect((await backend.getAcpSnapshot(contexts[0])).inputs).toEqual([]);
        await backend.queueAcpPrompt({
          context: { ...contexts[1], requestId: 'question' },
          sessionId: sessions[1].sessionId,
          text: 'question',
        });
        await vi.waitFor(async () => expect((await backend.getAcpSnapshot(contexts[1])).inputs).toHaveLength(1));
        const input = (await backend.getAcpSnapshot(contexts[1])).inputs[0];
        expect(input).toMatchObject({
          sessionId: sessions[1].sessionId,
          method: 'elicitation/create',
          params: { requestedSchema: { type: 'object' } },
        });
        await backend.answerInputRequest({
          workspaceId: contexts[1].workspaceId,
          workspaceGeneration: contexts[1].workspaceGeneration,
          inputRequestId: input.input.id,
          expectedRevision: input.input.revision,
          response: { value: JSON.stringify({ action: 'accept', content: { strategy: 'safe' } }) },
        });
        await vi.waitFor(async () =>
          expect((await backend.getWorkbenchSnapshot()).inputRequests.find((i) => i.id === input.input.id)?.status).toBe('accepted'),
        );
        await vi.waitFor(async () => expect((await backend.getAcpSnapshot(contexts[1])).sessions[0].state).toBe('ready'));
        await vi.waitFor(() => expect(batches.flatMap((b) => b.events).some((e) => e.kind === 'agent/turnChanged')).toBe(true));
        await backend.closeAcpSession({ context: contexts[0], sessionId: sessions[0].sessionId });
        expect((await backend.getAcpSnapshot(contexts[1])).sessions[0].state).toBe('ready');
      } finally {
        await backend.shutdown();
        first.dispose();
        second.dispose();
      }
    },
    30000,
  );

  it('runs multi-workspace lifecycle, dispatch, events, and shutdown in one addon', async () => {
    const firstFixture = createRepositoryFixture();
    const secondFixture = createRepositoryFixture();
    const factory = loadNativeAddonFactory({
      cwd: resolve('.'),
      env: { ...process.env, DIFFUSE_NATIVE_ADDON: resolve('build/native/diffuse_core.node') },
    });
    const backend = new NativeCoreBackend(factory, { databasePath: ':memory:' });
    const batches: WorkbenchEvent[][] = [];
    backend.onEvents((events) => batches.push([...events]));

    try {
      const first = await backend.openWorkspace(firstFixture.root);
      const second = await backend.openWorkspace(secondFixture.root);
      expect(first.summary.workspaceId).not.toBe(second.summary.workspaceId);
      expect(realpathSync(first.repository.root)).toBe(realpathSync(firstFixture.root));
      expect(realpathSync(second.repository.root)).toBe(realpathSync(secondFixture.root));

      const firstContext = context(first.summary, 'changed-first');
      const secondContext = context(second.summary, 'changed-second');
      const [firstFiles, secondFiles] = await Promise.all([
        backend.request(firstContext, 'listChangedFiles', { target }),
        backend.request(secondContext, 'listChangedFiles', { target }),
      ]);
      expect(firstFiles.context).toEqual(firstContext);
      expect(secondFiles.context).toEqual(secondContext);
      expect(firstFiles.result).toHaveLength(4);
      expect(secondFiles.result).toHaveLength(4);

      await backend.activateWorkspace(first.summary);
      const rehydrated = await backend.getWorkbenchSnapshot();
      expect(rehydrated.workspaces).toHaveLength(2);
      expect(rehydrated.activeWorkspace?.summary).toMatchObject(first.summary);

      await backend.request(context(first.summary, 'search-first'), 'startSearch', {
        searchId: 'native-search',
        sessionId: '',
        query: 'answer',
        mode: 'content',
        filters: [],
        target,
      });
      await waitForEvent(batches, (event) => event.kind === 'search/done' && event.payload.searchId === 'native-search');
      const searchEvents = batches.flat().filter((event) => 'searchId' in event.payload && event.payload.searchId === 'native-search');
      expect(searchEvents.map((event) => event.kind)).toEqual(
        expect.arrayContaining(['search/started', 'search/results', 'search/progress', 'search/done']),
      );
      expect(batches.some((batch) => batch.length > 0)).toBe(true);

      const stale = first.summary;
      await backend.closeWorkspace({ ...stale, force: false });
      const reopened = await backend.openWorkspace(firstFixture.root);
      expect(reopened.summary.workspaceId).toBe(stale.workspaceId);
      expect(reopened.summary.workspaceGeneration).not.toBe(stale.workspaceGeneration);
      await expect(backend.getWorkspaceSnapshot(stale)).rejects.toMatchObject({ code: 'StaleWorkspaceGeneration' });

      await expect(backend.health()).resolves.toMatchObject({ status: 'healthy' });
      const shutdown = backend.shutdown();
      expect(backend.shutdown()).toBe(shutdown);
      await shutdown;
      await expect(backend.health()).resolves.toEqual({ status: 'stopped' });
    } finally {
      await backend.shutdown().catch(() => undefined);
      firstFixture.dispose();
      secondFixture.dispose();
    }
  }, 30_000);
});

function context(reference: { workspaceId: string; workspaceGeneration: string }, requestId: string): WorkspaceRequestContext {
  return { workspaceId: reference.workspaceId, workspaceGeneration: reference.workspaceGeneration, requestId };
}

async function waitForEvent(batches: WorkbenchEvent[][], predicate: (event: WorkbenchEvent) => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (batches.some((batch) => batch.some(predicate))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error('Timed out waiting for native addon event batch.');
}
