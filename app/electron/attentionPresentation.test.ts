import { describe, expect, it, vi } from 'vitest';
import type { AttentionItem, AttentionMutationResult, WorkspaceSummary } from '../src/lib/workbenchContract';
import { attentionNotificationContent, claimAttentionNotification, shouldNotify, trayAttentionState } from './attentionPresentation';

describe('attention presentation', () => {
  it('aggregates tray text and marks actionable input or errors', () => {
    const first = workspace('alpha', { inputRequired: 1, errors: 0, unread: 2, running: 1 });
    const second = workspace('beta', { inputRequired: 0, errors: 2, unread: 0, running: 1 });

    expect(trayAttentionState([first, second])).toEqual({
      icon: 'attention',
      text: 'Diffuse: 1 input required, 2 errors, 2 unread items, 2 running tasks',
    });
    expect(trayAttentionState([])).toEqual({ icon: 'idle', text: 'Diffuse: no pending workspace activity' });
  });

  it('only presents unread input and error attention with workspace context', () => {
    const summary = workspace('alpha');
    expect(attentionNotificationContent(summary, attention('input'))).toMatchObject({
      title: 'Input required: alpha',
      body: 'Input is required in alpha.',
      workspaceId: summary.workspaceId,
      attentionId: 'attention-1',
      revision: 3,
    });
    expect(attentionNotificationContent(summary, attention('completion'))).toBeUndefined();
    expect(attentionNotificationContent(summary, { ...attention('error'), status: 'acknowledged' })).toBeUndefined();
  });

  it('does not consume notification claims when desktop notifications are unavailable or the window is focused', () => {
    expect(shouldNotify(false, false)).toBe(false);
    expect(shouldNotify(true, true)).toBe(false);
    expect(shouldNotify(true, false)).toBe(true);
  });

  it('uses the durable claim outcome for notification dedupe', async () => {
    const summary = workspace('alpha');
    const item = attention('error');
    const claim = vi.fn().mockResolvedValueOnce(mutation(item, 'applied')).mockResolvedValueOnce(mutation(item, 'unchanged'));

    await expect(claimAttentionNotification({ claimAttentionNotification: claim }, summary, item)).resolves.toBe(true);
    await expect(claimAttentionNotification({ claimAttentionNotification: claim }, summary, item)).resolves.toBe(false);
    expect(claim).toHaveBeenCalledWith({
      workspaceId: summary.workspaceId,
      workspaceGeneration: summary.workspaceGeneration,
      attentionId: item.id,
      expectedRevision: item.revision,
    });
  });
});

function workspace(
  displayName: string,
  counts: Pick<WorkspaceSummary['attention'], 'inputRequired' | 'errors' | 'unread' | 'running'> = {
    inputRequired: 0,
    errors: 0,
    unread: 0,
    running: 0,
  },
): WorkspaceSummary {
  const total = counts.inputRequired + counts.errors + counts.unread + counts.running;
  const state =
    counts.inputRequired > 0
      ? 'input-required'
      : counts.errors > 0
        ? 'error'
        : counts.unread > 0
          ? 'unread'
          : counts.running > 0
            ? 'running'
            : 'idle';
  return {
    workspaceId: `workspace-${displayName}`,
    workspaceGeneration: `generation-${displayName}`,
    root: `/repo/${displayName}`,
    displayName,
    state: 'ready',
    attention: { ...counts, total, state },
  };
}

function attention(kind: AttentionItem['kind']): AttentionItem {
  return {
    id: 'attention-1',
    workspaceId: 'workspace-alpha',
    sourceId: 'source-1',
    kind,
    revision: 3,
    status: 'unread',
    target: { kind: 'review', reviewSessionId: 'review-1' },
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:01:00.000Z',
  };
}

function mutation(item: AttentionItem, outcome: AttentionMutationResult['outcome']): AttentionMutationResult {
  return { outcome, item, summary: workspace('alpha').attention };
}
