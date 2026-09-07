import { describe, expect, it, vi } from 'vitest';
import { LegacyCoreBackend } from './legacyCoreBackend';
import { LegacyWorkspaceRegistry } from './legacyWorkspaceRegistry';

describe('LegacyCoreBackend Phase 5 compatibility', () => {
  it('rejects attention and input mutations with a stable RPC-mode code', async () => {
    const backend = new LegacyCoreBackend(new LegacyWorkspaceRegistry({ createClient: vi.fn() }));
    const reference = { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' };

    await expect(
      backend.createAttention({
        ...reference,
        sourceId: 'review-run:run-1',
        kind: 'completion',
        revision: 1,
        target: { kind: 'review', reviewSessionId: 'session-1' },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_IN_RPC_MODE' });
    await expect(backend.cancelInputRequest({ ...reference, inputRequestId: 'input-1', expectedRevision: 1 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_IN_RPC_MODE',
    });
    await expect(backend.health()).resolves.toMatchObject({ status: 'degraded', errorCode: 'UNSUPPORTED_IN_RPC_MODE' });
  });
});
