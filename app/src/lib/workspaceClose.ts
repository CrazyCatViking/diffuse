export async function closeWorkspaceWithPolicy(
  initialForce: boolean,
  close: (force: boolean) => Promise<void>,
  confirmInitialForce: () => boolean,
  confirmPendingInputRace: () => boolean,
): Promise<boolean> {
  if (initialForce && !confirmInitialForce()) return false;
  try {
    await close(initialForce);
    return true;
  } catch (error) {
    if (initialForce || !isRacedWorkspaceCloseError(error)) throw error;
    if (!confirmPendingInputRace()) return false;
    await close(true);
    return true;
  }
}

export function isRacedWorkspaceCloseError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === 'WorkspaceHasPendingInput' ||
    code === 'WorkspaceHasActiveReview' ||
    message.includes('WorkspaceHasPendingInput') ||
    message.includes('WorkspaceHasActiveReview')
  );
}
