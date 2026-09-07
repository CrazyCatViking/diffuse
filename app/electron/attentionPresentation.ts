import type { CoreBackend } from './coreBackend';
import type { AttentionItem, WorkspaceNavigationTarget, WorkspaceSummary } from '../src/lib/workbenchContract';

export type TrayAttentionState = {
  icon: 'idle' | 'attention';
  text: string;
};

export type AttentionNavigationRequest = {
  workspaceId: string;
  target: WorkspaceNavigationTarget;
  attentionId: string;
  revision: number;
};

export type AttentionNotificationContent = AttentionNavigationRequest & {
  title: string;
  body: string;
};

export function shouldNotify(notificationSupported: boolean, primaryWindowFocused: boolean): boolean {
  return notificationSupported && !primaryWindowFocused;
}

export function trayAttentionState(workspaces: Iterable<WorkspaceSummary>): TrayAttentionState {
  let inputRequired = 0;
  let errors = 0;
  let unread = 0;
  let running = 0;
  for (const workspace of workspaces) {
    inputRequired += workspace.attention.inputRequired;
    errors += workspace.attention.errors;
    unread += workspace.attention.unread;
    running += workspace.attention.running;
  }
  const counts = [
    countLabel(inputRequired, 'input required'),
    countLabel(errors, 'error', 'errors'),
    countLabel(unread, 'unread item', 'unread items'),
    countLabel(running, 'running task', 'running tasks'),
  ].filter(Boolean);
  return {
    icon: inputRequired > 0 || errors > 0 ? 'attention' : 'idle',
    text: counts.length > 0 ? `Diffuse: ${counts.join(', ')}` : 'Diffuse: no pending workspace activity',
  };
}

export function attentionNotificationContent(workspace: WorkspaceSummary, item: AttentionItem): AttentionNotificationContent | undefined {
  if (item.workspaceId !== workspace.workspaceId || item.status !== 'unread') return undefined;
  if (item.kind === 'input') {
    return {
      workspaceId: workspace.workspaceId,
      target: item.target,
      attentionId: item.id,
      revision: item.revision,
      title: `Input required: ${workspace.displayName}`,
      body: `Input is required in ${workspace.displayName}.`,
    };
  }
  if (item.kind === 'error') {
    return {
      workspaceId: workspace.workspaceId,
      target: item.target,
      attentionId: item.id,
      revision: item.revision,
      title: `Error: ${workspace.displayName}`,
      body: `An error needs attention in ${workspace.displayName}.`,
    };
  }
  return undefined;
}

export async function claimAttentionNotification(
  backend: Pick<CoreBackend, 'claimAttentionNotification'>,
  workspace: WorkspaceSummary,
  item: AttentionItem,
): Promise<boolean> {
  if (!attentionNotificationContent(workspace, item)) return false;
  const result = await backend.claimAttentionNotification({
    workspaceId: workspace.workspaceId,
    workspaceGeneration: workspace.workspaceGeneration,
    attentionId: item.id,
    expectedRevision: item.revision,
  });
  return result.outcome === 'applied';
}

function countLabel(value: number, singular: string, plural = singular): string {
  return value === 0 ? '' : `${value} ${value === 1 ? singular : plural}`;
}
