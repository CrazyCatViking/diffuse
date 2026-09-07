import { describe, expect, it } from 'vitest';
import {
  parseAttentionAcknowledgeRequest,
  parseInputAnswerRequest,
  parseInputCancelRequest,
  parseDismissRestoreFailureRequest,
  parseWorkspaceCloseRequest,
  parseWorkspaceOrderRequest,
  parseWorkspaceSnapshotRequest,
  parseWorkspaceUiStateRequest,
} from './phase5Ipc';

describe('Phase 5 IPC request parsing', () => {
  const reference = { workspaceId: 'workspace-1', workspaceGeneration: 'generation-1' };
  const context = { ...reference, requestId: 'request-1' };

  it('validates workspace snapshot, order, and generation-bound UI-state inputs', () => {
    expect(parseWorkspaceSnapshotRequest(reference)).toEqual(reference);
    expect(parseWorkspaceCloseRequest({ ...reference, force: true })).toEqual({ ...reference, force: true });
    expect(parseDismissRestoreFailureRequest({ workspaceId: 'workspace-failed' })).toBe('workspace-failed');
    expect(parseWorkspaceOrderRequest({ workspaceIds: ['workspace-2', 'workspace-1'] })).toEqual({
      workspaceIds: ['workspace-2', 'workspace-1'],
    });
    expect(parseWorkspaceUiStateRequest({ ...reference, expectedRevision: 0, state: { route: 'review' } })).toEqual({
      ...reference,
      expectedRevision: 0,
      state: { route: 'review' },
    });

    expect(() => parseWorkspaceOrderRequest({ workspaceIds: ['workspace-1', 'workspace-1'] })).toThrow();
    expect(() => parseWorkspaceCloseRequest(reference)).toThrow();
    expect(() => parseDismissRestoreFailureRequest({ workspaceId: '' })).toThrow();
    expect(() => parseWorkspaceUiStateRequest({ workspaceId: 'workspace-1', expectedRevision: 0, state: {} })).toThrow();
    expect(() => parseWorkspaceUiStateRequest({ ...reference, expectedRevision: -1, state: {} })).toThrow();
  });

  it('flattens renderer contexts to Rust aliases without forwarding request IDs', () => {
    expect(parseAttentionAcknowledgeRequest({ context, attentionId: 'attention-1', revision: 4 })).toEqual({
      ...reference,
      attentionId: 'attention-1',
      expectedRevision: 4,
    });
    expect(parseInputAnswerRequest({ context, inputRequestId: 'input-1', revision: 5, response: { value: 'Allow' } })).toEqual({
      ...reference,
      inputRequestId: 'input-1',
      expectedRevision: 5,
      response: { value: 'Allow' },
      redactResponse: false,
    });
    expect(parseInputCancelRequest({ context, inputRequestId: 'input-1', revision: 5 })).toEqual({
      ...reference,
      inputRequestId: 'input-1',
      expectedRevision: 5,
    });
    expect(
      parseInputAnswerRequest({ context, inputRequestId: 'input-1', revision: 5, response: { value: 'secret', secret: true } }),
    ).toMatchObject({
      redactResponse: true,
    });

    expect(() => parseInputAnswerRequest({ context, inputRequestId: 'input-1', revision: 5, response: { value: 1 } })).toThrow();
    expect(() => parseInputCancelRequest({ context, inputRequestId: '', revision: 5 })).toThrow();
  });
});
