import type { CoreEventMap, CoreEventName, CoreMethod, CoreMethods, CoreRequestArgs } from './coreContract';
import { isCoreEvent } from './coreContract';
import type { OpenRepositoryResult } from './protocol';

export type WorkspaceId = string;
export type WorkspaceGeneration = string;
export type RequestId = string;

export type WorkspaceReference = {
  workspaceId: WorkspaceId;
  workspaceGeneration: WorkspaceGeneration;
};

export type WorkspaceRequestContext = WorkspaceReference & {
  requestId: RequestId;
};

export type WorkspaceLoadState = 'opening' | 'ready' | 'closing' | 'closed';

export type WorkspaceSummary = WorkspaceReference & {
  root: string;
  displayName: string;
  state: WorkspaceLoadState;
};

export type WorkspaceSnapshot = {
  summary: WorkspaceSummary;
  repository: OpenRepositoryResult;
};

export type WorkbenchSnapshot = {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: WorkspaceId | null;
  activeWorkspace: WorkspaceSnapshot | null;
  sequence: number;
};

export type WorkspaceCoreMethod = Exclude<CoreMethod, 'getVersion' | 'openRepository'>;

export type WorkspaceResponse<T> = {
  context: WorkspaceRequestContext;
  result: T;
};

export type WorkspaceRequest = <M extends WorkspaceCoreMethod>(
  context: WorkspaceRequestContext,
  method: M,
  ...args: CoreRequestArgs<CoreMethods[M]['params']>
) => Promise<WorkspaceResponse<CoreMethods[M]['result']>>;

export type WorkspaceLifecycleEventMap = {
  'workspace/added': WorkspaceSummary;
  'workspace/activated': WorkspaceSnapshot;
  'workspace/removed': WorkspaceSummary;
};

export type WorkbenchEventKind = keyof WorkspaceLifecycleEventMap | CoreEventName;

type WorkbenchEventBase<K extends WorkbenchEventKind, T> = WorkspaceReference & {
  sequence: number;
  eventId: string;
  kind: K;
  payload: T;
};

export type WorkbenchEvent =
  | {
      [K in keyof WorkspaceLifecycleEventMap]: WorkbenchEventBase<K, WorkspaceLifecycleEventMap[K]>;
    }[keyof WorkspaceLifecycleEventMap]
  | {
      [K in CoreEventName]: WorkbenchEventBase<K, CoreEventMap[K]>;
    }[CoreEventName];

export function isWorkspaceReference(value: unknown): value is WorkspaceReference {
  return (
    isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    value.workspaceId.length > 0 &&
    typeof value.workspaceGeneration === 'string' &&
    value.workspaceGeneration.length > 0
  );
}

export function isWorkspaceRequestContext(value: unknown): value is WorkspaceRequestContext {
  if (!isRecord(value) || !isWorkspaceReference(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return typeof record.requestId === 'string' && record.requestId.length > 0;
}

export function isWorkbenchEvent(value: unknown): value is WorkbenchEvent {
  if (!isRecord(value) || !isWorkspaceReference(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) < 1 || typeof record.eventId !== 'string' || !record.eventId)
    return false;
  if (typeof record.kind !== 'string') return false;

  if (record.kind === 'workspace/added' || record.kind === 'workspace/removed') return isWorkspaceSummary(record.payload);
  if (record.kind === 'workspace/activated') return isWorkspaceSnapshot(record.payload);
  return isCoreEvent({ jsonrpc: '2.0', method: record.kind, params: record.payload });
}

function isWorkspaceSummary(value: unknown): value is WorkspaceSummary {
  if (!isRecord(value) || !isWorkspaceReference(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return (
    typeof record.root === 'string' &&
    typeof record.displayName === 'string' &&
    (record.state === 'opening' || record.state === 'ready' || record.state === 'closing' || record.state === 'closed')
  );
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  return (
    isRecord(value) &&
    isWorkspaceSummary(value.summary) &&
    isRecord(value.repository) &&
    typeof value.repository.root === 'string' &&
    typeof value.repository.head === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
