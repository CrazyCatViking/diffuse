import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRouteState } from './workspaceRoutes';
import { restoreReviewSessionRoute } from './reviewSessionRestoration';

describe('persisted review session restoration', () => {
  it('selects an exact session before restoring its route', async () => {
    const order: string[] = [];
    const dependencies = createDependencies(order);
    const route = reviewRoute({ reviewSessionId: 'session-2', threadId: 'thread-1' });

    const result = await restoreReviewSessionRoute(route, dependencies);

    expect(order).toEqual(['select:session-2', 'navigate']);
    expect(dependencies.ensureSession).not.toHaveBeenCalled();
    expect(result).toEqual({ route, current: true });
  });

  it('loads the portable active session when no exact session is persisted', async () => {
    const order: string[] = [];
    const dependencies = createDependencies(order);
    const route = reviewRoute({ threadId: 'thread-1' });

    await restoreReviewSessionRoute(route, dependencies);

    expect(order).toEqual(['ensure', 'navigate']);
    expect(dependencies.selectSession).not.toHaveBeenCalled();
  });

  it('falls back and removes only an inaccessible session query before routing', async () => {
    const order: string[] = [];
    const dependencies = createDependencies(order);
    dependencies.selectSession.mockImplementation(async (sessionId) => {
      order.push(`select:${sessionId}`);
      throw new Error('missing');
    });
    const route = reviewRoute({ reviewSessionId: 'deleted', threadId: 'thread-1' });

    const result = await restoreReviewSessionRoute(route, dependencies);

    expect(order).toEqual(['select:deleted', 'ensure', 'navigate']);
    expect(result.route?.query).toEqual({ threadId: 'thread-1' });
    expect(dependencies.navigate).toHaveBeenCalledWith(expect.objectContaining({ query: { threadId: 'thread-1' } }));
  });

  it('does not fallback or route after exact selection is superseded', async () => {
    let current = true;
    const dependencies = createDependencies([]);
    dependencies.isCurrent = () => current;
    dependencies.selectSession.mockImplementation(async () => {
      current = false;
      throw new Error('missing');
    });

    const result = await restoreReviewSessionRoute(reviewRoute({ reviewSessionId: 'session-2' }), dependencies);

    expect(result.current).toBe(false);
    expect(dependencies.ensureSession).not.toHaveBeenCalled();
    expect(dependencies.navigate).not.toHaveBeenCalled();
  });
});

function createDependencies(order: string[]) {
  return {
    selectSession: vi.fn(async (sessionId: string) => {
      order.push(`select:${sessionId}`);
    }),
    ensureSession: vi.fn(async () => {
      order.push('ensure');
    }),
    navigate: vi.fn(async () => {
      order.push('navigate');
    }),
    isCurrent: () => true,
  };
}

function reviewRoute(query: Record<string, string>): WorkspaceRouteState {
  return { name: 'workspace-file', params: { workspaceId: 'workspace-1', fileId: 'src/main.ts' }, query };
}
