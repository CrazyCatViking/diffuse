import type { CloseWorkspaceRequest, WorkspaceReference } from '../src/lib/workbenchContract';
import { CoreBackendError } from './coreBackend';

type LegacyReviewAgentOwner = {
  context: WorkspaceReference;
  runner: {
    stop(): Promise<unknown>;
    dispose(): void;
    status(): { running: boolean };
  };
};

export function assertLegacyReviewAllowsClose(request: CloseWorkspaceRequest, owner: LegacyReviewAgentOwner | null): void {
  if (!request.force && owner && matchesReference(owner.context, request) && owner.runner.status().running) {
    throw new CoreBackendError('WorkspaceHasActiveReview', 'WorkspaceHasActiveReview');
  }
}

export async function closeWorkspaceWithLegacyReviewAgent<T>(
  request: CloseWorkspaceRequest,
  owner: LegacyReviewAgentOwner | null,
  closeWorkspace: (request: CloseWorkspaceRequest) => Promise<T>,
): Promise<T> {
  if (owner && matchesReference(owner.context, request)) {
    await owner.runner.stop();
    owner.runner.dispose();
  }
  return await closeWorkspace(request);
}

export async function stopLegacyReviewAgentForShutdown(owner: LegacyReviewAgentOwner | null): Promise<void> {
  if (!owner) return;
  try {
    await owner.runner.stop();
  } finally {
    owner.runner.dispose();
  }
}

function matchesReference(first: WorkspaceReference, second: WorkspaceReference): boolean {
  return first.workspaceId === second.workspaceId && first.workspaceGeneration === second.workspaceGeneration;
}
