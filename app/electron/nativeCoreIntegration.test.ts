import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkbenchEvent, WorkspaceRequestContext } from '../src/lib/workbenchContract';
import { createRepositoryFixture } from '../src/test/repositoryFixture';
import { loadNativeAddonFactory } from './nativeCoreAddon';
import { NativeCoreBackend } from './nativeCoreBackend';

const target = { base: 'HEAD', includeStaged: true, includeUnstaged: true };

describe('native core addon integration', () => {
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
      await backend.closeWorkspace(stale);
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
  return { ...reference, requestId };
}

async function waitForEvent(batches: WorkbenchEvent[][], predicate: (event: WorkbenchEvent) => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (batches.some((batch) => batch.some(predicate))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error('Timed out waiting for native addon event batch.');
}
