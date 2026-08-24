import type { WorkspaceReference } from '../src/lib/workbenchContract';

type LegacyReviewAgentOwner = {
  context: WorkspaceReference;
  runner: {
    stop(): Promise<unknown>;
    dispose(): void;
  };
};

export async function closeWorkspaceWithLegacyReviewAgent<T>(
  reference: WorkspaceReference,
  owner: LegacyReviewAgentOwner | null,
  closeWorkspace: (reference: WorkspaceReference) => Promise<T>,
): Promise<T> {
  if (owner && matchesReference(owner.context, reference)) {
    try {
      await owner.runner.stop();
    } finally {
      owner.runner.dispose();
    }
  }
  return await closeWorkspace(reference);
}

function matchesReference(first: WorkspaceReference, second: WorkspaceReference): boolean {
  return first.workspaceId === second.workspaceId && first.workspaceGeneration === second.workspaceGeneration;
}
