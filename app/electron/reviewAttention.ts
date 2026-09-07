import type { CoreBackend } from './coreBackend';
import type { ReviewRunTerminalEvent } from './reviewAgentRunner';
import type { WorkspaceRequestContext } from '../src/lib/workbenchContract';

const retryDelaysMs = [0, 250, 1_000];
const permanentErrorCodes = new Set([
  'INVALID_ARGUMENT',
  'NATIVE_PROTOCOL_ERROR',
  'InvalidParams',
  'SerializationError',
  'AppCoreShuttingDown',
  'BACKEND_SHUT_DOWN',
  'StaleWorkspaceGeneration',
  'WorkspaceNotFound',
  'UNSUPPORTED_IN_RPC_MODE',
]);

export async function createReviewAttentionWithRetry(
  getBackend: () => Promise<Pick<CoreBackend, 'createAttention'>>,
  context: WorkspaceRequestContext,
  terminal: ReviewRunTerminalEvent,
  sleep: (delayMs: number) => Promise<void> = delay,
): Promise<void> {
  const sourceId = `review-run:${terminal.runId}`;
  for (const [index, delayMs] of retryDelaysMs.entries()) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      const backend = await getBackend();
      const result = await backend.createAttention({
        id: sourceId,
        workspaceId: context.workspaceId,
        workspaceGeneration: context.workspaceGeneration,
        sourceId,
        kind: terminal.status === 'completed' ? 'completion' : 'error',
        revision: 1,
        target: { kind: 'review', reviewSessionId: terminal.sessionId },
      });
      if (result.outcome === 'invalid') throw Object.assign(new Error('Core rejected review attention'), { code: 'INVALID_ARGUMENT' });
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (permanentErrorCodes.has(code) || index === retryDelaysMs.length - 1) throw error;
    }
  }
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
