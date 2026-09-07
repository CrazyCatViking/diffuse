import type { Router } from 'vue-router';
import type { WorkspaceNavigationTarget } from './workbenchContract';
import { diffRoute, inputRoute, overviewRoute } from './workspaceRoutes';

export const openWorkspaceSettingsEvent = 'diffuse:open-workspace-settings';

export type WorkspaceNavigationDispatcher = {
  activateWorkspace(workspaceId: string): Promise<void>;
  router: Pick<Router, 'push'>;
  openSettings?: (section?: string) => void;
  selectReviewSession?: (sessionId: string) => Promise<void>;
};

export async function dispatchWorkspaceNavigation(
  workspaceId: string,
  target: WorkspaceNavigationTarget,
  dispatcher: WorkspaceNavigationDispatcher,
): Promise<void> {
  await dispatcher.activateWorkspace(workspaceId);
  if (target.kind === 'workspace') return;
  if (target.kind === 'input') {
    await dispatcher.router.push(inputRoute(workspaceId, target.inputRequestId));
    return;
  }
  if (target.kind === 'review') {
    if (target.reviewSessionId) {
      if (!dispatcher.selectReviewSession) throw new Error('Review session selection is unavailable');
      await dispatcher.selectReviewSession(target.reviewSessionId);
    }
    if (target.fileId) {
      await dispatcher.router.push(
        diffRoute(workspaceId, target.fileId, {
          threadId: target.threadId,
          reviewSessionId: target.reviewSessionId,
        }),
      );
    } else {
      await dispatcher.router.push({
        ...overviewRoute(workspaceId),
        query: target.reviewSessionId ? { reviewSessionId: target.reviewSessionId } : undefined,
      });
    }
    return;
  }
  if (target.kind === 'settings') {
    if (dispatcher.openSettings) dispatcher.openSettings(target.section);
    else window.dispatchEvent(new CustomEvent(openWorkspaceSettingsEvent, { detail: { section: target.section } }));
    return;
  }
  await dispatcher.router.push({
    ...overviewRoute(workspaceId),
    query: { agentSessionId: target.agentSessionId },
  });
}
