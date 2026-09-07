import type { WorkspaceRouteState } from './workspaceRoutes';

export type ReviewSessionRestoration = {
  route?: WorkspaceRouteState;
  current: boolean;
};

export async function restoreReviewSessionRoute(
  route: WorkspaceRouteState | undefined,
  dependencies: {
    selectSession(sessionId: string): Promise<void>;
    ensureSession(): Promise<void>;
    navigate(route: WorkspaceRouteState | undefined): Promise<void>;
    isCurrent(): boolean;
  },
): Promise<ReviewSessionRestoration> {
  if (!dependencies.isCurrent()) return { route, current: false };
  const reviewSessionId = route?.query.reviewSessionId?.trim();
  let correctedRoute = route;
  if (reviewSessionId) {
    const persistedRoute = route as WorkspaceRouteState;
    try {
      await dependencies.selectSession(reviewSessionId);
    } catch (error) {
      if (!dependencies.isCurrent()) return { route, current: false };
      if (error instanceof Error && error.message.startsWith('Review session selection superseded:')) {
        return { route, current: false };
      }
      await dependencies.ensureSession();
      if (!dependencies.isCurrent()) return { route, current: false };
      correctedRoute = {
        ...persistedRoute,
        query: Object.fromEntries(Object.entries(persistedRoute.query).filter(([key]) => key !== 'reviewSessionId')),
      };
    }
  } else {
    await dependencies.ensureSession();
  }
  if (!dependencies.isCurrent()) return { route: correctedRoute, current: false };
  await dependencies.navigate(correctedRoute);
  return { route: correctedRoute, current: dependencies.isCurrent() };
}
