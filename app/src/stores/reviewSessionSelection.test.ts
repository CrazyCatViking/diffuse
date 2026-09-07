// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewSession, ReviewThread } from '../lib/protocol';
import { setActiveWorkspace } from '../lib/useClient';
import { createMockDesktopBridge } from '../test/mockDesktopBridge';
import { useRepoStore } from './repo';
import { useReviewStore } from './review';

describe('review session selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setActiveWorkspace({ workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' });
  });

  afterEach(() => setActiveWorkspace(undefined));

  it('loads every requested-session surface without changing portable ownership', async () => {
    const bridge = createMockDesktopBridge();
    const selected = session('session-2');
    bridge.workspaceRequest.mockImplementation(async (context, method) => ({
      context,
      result:
        method === 'listReviewSessions'
          ? [session('session-1'), selected]
          : method === 'getReviewProgress'
            ? null
            : method === 'getReviewedFiles'
              ? { files: {} }
              : [],
    })) as never;
    window.diffuse = bridge;
    useRepoStore().$patch({
      workspace: { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' },
      repository: { root: '/repo', head: 'head' },
    });
    const review = useReviewStore();

    await review.selectSession(selected.id);

    expect(review.session).toEqual(selected);
    expect(bridge.workspaceRequest.mock.calls.map((call) => call[1])).toEqual([
      'listReviewSessions',
      'getReviewProgress',
      'getReviewedFiles',
      'getReviewRuns',
      'getReviewAgentStates',
      'getReviewChatMessages',
      'getReviewThreads',
    ]);
    expect(bridge.workspaceRequest).not.toHaveBeenCalledWith(expect.anything(), 'getActiveReviewSession');
    expect(bridge.workspaceRequest).not.toHaveBeenCalledWith(expect.anything(), 'createReviewSession', expect.anything());
  });

  it('throws and retains the current local session when the requested session is missing', async () => {
    const bridge = createMockDesktopBridge();
    bridge.workspaceRequest.mockImplementation(async (context, method) => ({
      context,
      result: method === 'listReviewSessions' ? [session('session-1')] : [],
    })) as never;
    window.diffuse = bridge;
    useRepoStore().$patch({
      workspace: { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' },
      repository: { root: '/repo', head: 'head' },
    });
    const review = useReviewStore();
    review.$patch({ session: session('session-current') });

    await expect(review.selectSession('missing')).rejects.toThrow('Review session not found: missing');
    expect(review.session?.id).toBe('session-current');
  });

  it('invalidates an older in-flight review load when selecting another session', async () => {
    const bridge = createMockDesktopBridge();
    const oldThreads = deferred<ReviewThread[]>();
    const selected = session('session-2');
    const selectedThread = thread('thread-new', selected.id);
    bridge.workspaceRequest.mockImplementation(async (context, method, params) => {
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
      if (method === 'getReviewThreads' && sessionId === 'session-old') {
        return { context, result: await oldThreads.promise } as never;
      }
      return {
        context,
        result:
          method === 'listReviewSessions'
            ? [selected]
            : method === 'getReviewProgress'
              ? null
              : method === 'getReviewedFiles'
                ? { files: {} }
                : method === 'getReviewThreads'
                  ? [selectedThread]
                  : [],
      } as never;
    });
    window.diffuse = bridge;
    useRepoStore().$patch({
      workspace: { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' },
      repository: { root: '/repo', head: 'head' },
    });
    const review = useReviewStore();
    review.$patch({ session: session('session-old') });

    const oldLoad = review.loadThreads();
    await vi.waitFor(() =>
      expect(bridge.workspaceRequest).toHaveBeenCalledWith(
        expect.anything(),
        'getReviewThreads',
        expect.objectContaining({ sessionId: 'session-old' }),
      ),
    );
    await review.selectSession(selected.id);
    oldThreads.resolve([thread('thread-old', 'session-old')]);
    await oldLoad;

    expect(review.session?.id).toBe(selected.id);
    expect(review.threads).toEqual([selectedThread]);
  });
});

function session(id: string): ReviewSession {
  return {
    id,
    repositoryRoot: '/repo',
    target: { includeStaged: true, includeUnstaged: true },
    headAtCreation: 'head',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    title: id,
    status: 'active',
    participants: [],
  };
}

function thread(id: string, sessionId: string): ReviewThread {
  return {
    id,
    sessionId,
    fileId: 'src/main.ts',
    anchor: { side: 'new', startLine: 1, endLine: 1, diffTargetFingerprint: 'target' },
    status: 'open',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    messages: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
