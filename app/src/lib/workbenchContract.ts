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

export type CloseWorkspaceRequest = WorkspaceReference & {
  force: boolean;
};

export type WorkspaceRequestContext = WorkspaceReference & {
  requestId: RequestId;
};

export type WorkspaceLoadState = 'opening' | 'ready' | 'degraded' | 'closing' | 'closed';
export type WorkspaceAttentionState = 'input-required' | 'error' | 'unread' | 'running' | 'idle';

export type WorkspaceAttentionSummary = {
  state: WorkspaceAttentionState;
  inputRequired: number;
  errors: number;
  unread: number;
  running: number;
  total: number;
};

export type WorkspaceServiceStatus = 'running' | 'stopped' | 'failed';

export type WorkspaceServiceHealth = {
  repositoryWatcher: WorkspaceServiceStatus;
};

export type WorkspaceSummary = WorkspaceReference & {
  root: string;
  displayName: string;
  state: WorkspaceLoadState;
  attention: WorkspaceAttentionSummary;
  serviceHealth?: WorkspaceServiceHealth;
};

export type WorkspaceSnapshot = {
  summary: WorkspaceSummary;
  repository: OpenRepositoryResult;
};

export type WorkspaceNavigationTarget =
  | { kind: 'input'; inputRequestId: string }
  | { kind: 'review'; fileId?: string; threadId?: string; reviewSessionId?: string }
  | { kind: 'settings'; section?: string }
  | { kind: 'workspace' }
  | { kind: 'agent'; agentSessionId: string };

export type AttentionItem = {
  id: string;
  workspaceId: WorkspaceId;
  sourceId: string;
  kind: 'input' | 'error' | 'completion';
  revision: number;
  status: 'unread' | 'acknowledged' | 'resolved' | 'expired' | 'superseded';
  target: WorkspaceNavigationTarget;
  createdAt: string;
  updatedAt: string;
};

export type InputResponse = {
  value: string;
  secret?: boolean;
};

export type InputRequest = {
  id: string;
  workspaceId: WorkspaceId;
  revision: number;
  kind: 'permission' | 'question' | 'authentication' | 'conflict';
  status: 'pending' | 'response-submitted' | 'accepted' | 'rejected' | 'expired' | 'cancelled' | 'superseded';
  prompt: string;
  choices: string[];
  cancellationSupported: boolean;
  response?: InputResponse;
  attentionId: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceUiStateRecord = {
  revision: number;
  state: Record<string, unknown>;
  updatedAt: string;
};

export type SaveWorkspaceUiStateRequest = WorkspaceReference & {
  expectedRevision: number;
  state: Record<string, unknown>;
};

export type LegacyReviewImportReport = {
  workspaceId: WorkspaceId;
  imported: number;
  alreadyImported: number;
  diagnostics: number;
};

export type RestoreDiagnostic = {
  workspaceId: WorkspaceId;
  root: string;
  displayName: string;
  message: string;
};

export type DismissRestoreFailureResult = {
  workspaceId: WorkspaceId;
  dismissed: boolean;
};

export type MutationOutcome = 'applied' | 'unchanged' | 'stale' | 'invalid';

export type AttentionMutationResult = {
  outcome: MutationOutcome;
  item: AttentionItem;
  summary: WorkspaceAttentionSummary;
};

export type InputMutationResult = {
  outcome: MutationOutcome;
  input: InputRequest;
  attention?: AttentionItem;
  summary: WorkspaceAttentionSummary;
};

export type WorkspaceUiStateMutationResult = {
  outcome: MutationOutcome;
  record: WorkspaceUiStateRecord;
};

export type WorkspaceOrderResult = {
  workspaceIds: WorkspaceId[];
};

export type CreateAttentionRequest = WorkspaceReference & {
  id?: string;
  sourceId: string;
  kind: AttentionItem['kind'];
  revision: number;
  status?: AttentionItem['status'];
  target: WorkspaceNavigationTarget;
};

export type AttentionCasRequest = WorkspaceReference & {
  attentionId: string;
  expectedRevision: number;
};

export type CreateInputRequest = WorkspaceReference & {
  id?: string;
  revision: number;
  kind: InputRequest['kind'];
  prompt: string;
  choices?: string[];
  cancellationSupported?: boolean;
  attentionId?: string;
  target?: WorkspaceNavigationTarget;
};

export type AnswerInputRequest = WorkspaceReference & {
  inputRequestId: string;
  expectedRevision: number;
  response: InputResponse;
  redactResponse?: boolean;
};

export type InputCasRequest = WorkspaceReference & {
  inputRequestId: string;
  expectedRevision: number;
};

export type WorkbenchSnapshot = {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: WorkspaceId | null;
  activeWorkspace: WorkspaceSnapshot | null;
  aggregateAttention: WorkspaceAttentionSummary;
  attentionItems: AttentionItem[];
  inputRequests: InputRequest[];
  workspaceUiState: Record<WorkspaceId, WorkspaceUiStateRecord>;
  legacyReviewImports: LegacyReviewImportReport[];
  restoreDiagnostics?: RestoreDiagnostic[];
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
  'workspace/summaryChanged': WorkspaceSummary;
  'workspace/attentionChanged': { item: AttentionItem; summary: WorkspaceSummary };
  'input/requested': InputRequest;
  'input/responseSubmitted': InputRequest;
  'input/resolved': InputRequest;
  'workspace/uiStateChanged': { workspaceId: WorkspaceId; record: WorkspaceUiStateRecord };
};

export type WorkbenchEventKind = keyof WorkspaceLifecycleEventMap | 'workspace/orderChanged' | CoreEventName;

type WorkbenchEventBase<K extends WorkbenchEventKind, T> = {
  sequence: number;
  eventId: string;
  kind: K;
  payload: T;
};

type WorkspaceWorkbenchEventBase<K extends WorkbenchEventKind, T> = WorkbenchEventBase<K, T> & WorkspaceReference;

export type WorkbenchEvent =
  | {
      [K in keyof WorkspaceLifecycleEventMap]: WorkspaceWorkbenchEventBase<K, WorkspaceLifecycleEventMap[K]>;
    }[keyof WorkspaceLifecycleEventMap]
  | {
      [K in CoreEventName]: WorkspaceWorkbenchEventBase<K, CoreEventMap[K]>;
    }[CoreEventName]
  | WorkbenchEventBase<'workspace/orderChanged', { workspaceIds: WorkspaceId[] }>;

export function isWorkspaceReference(value: unknown): value is WorkspaceReference {
  return isRecord(value) && isNonEmptyString(value.workspaceId) && isNonEmptyString(value.workspaceGeneration);
}

export function isCloseWorkspaceRequest(value: unknown): value is CloseWorkspaceRequest {
  return isWorkspaceReference(value) && typeof (value as Record<string, unknown>).force === 'boolean';
}

export function isDismissRestoreFailureResult(value: unknown): value is DismissRestoreFailureResult {
  return isRecord(value) && isNonEmptyString(value.workspaceId) && typeof value.dismissed === 'boolean';
}

export function isWorkspaceRequestContext(value: unknown): value is WorkspaceRequestContext {
  if (!isRecord(value) || !isWorkspaceReference(value)) return false;
  return isNonEmptyString((value as unknown as Record<string, unknown>).requestId);
}

export function isWorkspaceAttentionSummary(value: unknown): value is WorkspaceAttentionSummary {
  if (!isRecord(value)) return false;
  const counts = [value.inputRequired, value.errors, value.unread, value.running, value.total];
  if (!counts.every(isNonNegativeInteger)) return false;
  const expectedTotal = Number(value.inputRequired) + Number(value.errors) + Number(value.unread) + Number(value.running);
  if (value.total !== expectedTotal) return false;
  return value.state === attentionStateForCounts(value as WorkspaceAttentionSummary);
}

export function isWorkspaceNavigationTarget(value: unknown): value is WorkspaceNavigationTarget {
  if (!isRecord(value)) return false;
  if (value.kind === 'input') return isNonEmptyString(value.inputRequestId);
  if (value.kind === 'review') {
    return optionalString(value.fileId) && optionalString(value.threadId) && optionalString(value.reviewSessionId);
  }
  if (value.kind === 'settings') return optionalString(value.section);
  if (value.kind === 'workspace') return true;
  return value.kind === 'agent' && isNonEmptyString(value.agentSessionId);
}

export function isAttentionItem(value: unknown): value is AttentionItem {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.workspaceId) &&
    isNonEmptyString(value.sourceId) &&
    (value.kind === 'input' || value.kind === 'error' || value.kind === 'completion') &&
    isRevision(value.revision) &&
    (value.status === 'unread' ||
      value.status === 'acknowledged' ||
      value.status === 'resolved' ||
      value.status === 'expired' ||
      value.status === 'superseded') &&
    isWorkspaceNavigationTarget(value.target) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

export function isInputResponse(value: unknown): value is InputResponse {
  return isRecord(value) && typeof value.value === 'string' && (value.secret === undefined || typeof value.secret === 'boolean');
}

export function isInputRequest(value: unknown): value is InputRequest {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.workspaceId) &&
    isRevision(value.revision) &&
    (value.kind === 'permission' || value.kind === 'question' || value.kind === 'authentication' || value.kind === 'conflict') &&
    (value.status === 'pending' ||
      value.status === 'response-submitted' ||
      value.status === 'accepted' ||
      value.status === 'rejected' ||
      value.status === 'expired' ||
      value.status === 'cancelled' ||
      value.status === 'superseded') &&
    typeof value.prompt === 'string' &&
    Array.isArray(value.choices) &&
    value.choices.every((choice) => typeof choice === 'string') &&
    typeof value.cancellationSupported === 'boolean' &&
    (value.response === undefined || isInputResponse(value.response)) &&
    isNonEmptyString(value.attentionId) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

export function isWorkspaceUiStateRecord(value: unknown): value is WorkspaceUiStateRecord {
  return isRecord(value) && isNonNegativeInteger(value.revision) && isRecord(value.state) && isTimestamp(value.updatedAt);
}

export function isSaveWorkspaceUiStateRequest(value: unknown): value is SaveWorkspaceUiStateRequest {
  if (!isRecord(value) || !isWorkspaceReference(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return isNonNegativeInteger(record.expectedRevision) && isRecord(record.state);
}

export function isAttentionMutationResult(value: unknown): value is AttentionMutationResult {
  return isRecord(value) && isMutationOutcome(value.outcome) && isAttentionItem(value.item) && isWorkspaceAttentionSummary(value.summary);
}

export function isInputMutationResult(value: unknown): value is InputMutationResult {
  return (
    isRecord(value) &&
    isMutationOutcome(value.outcome) &&
    isInputRequest(value.input) &&
    (value.attention === undefined || isAttentionItem(value.attention)) &&
    isWorkspaceAttentionSummary(value.summary)
  );
}

export function isWorkspaceUiStateMutationResult(value: unknown): value is WorkspaceUiStateMutationResult {
  return isRecord(value) && isMutationOutcome(value.outcome) && isWorkspaceUiStateRecord(value.record);
}

export function isWorkspaceOrderResult(value: unknown): value is WorkspaceOrderResult {
  return isRecord(value) && isUniqueStringArray(value.workspaceIds);
}

export function isWorkbenchEvent(value: unknown): value is WorkbenchEvent {
  if (!isRecord(value) || !isEventBase(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'workspace/orderChanged') {
    return (
      isRecord(value.payload) &&
      isUniqueStringArray(value.payload.workspaceIds) &&
      value.workspaceId === undefined &&
      value.workspaceGeneration === undefined
    );
  }
  if (!isWorkspaceReference(value)) return false;
  const record = value as unknown as Record<string, unknown>;

  if (record.kind === 'workspace/added' || record.kind === 'workspace/removed' || record.kind === 'workspace/summaryChanged') {
    return isWorkspaceSummary(record.payload) && matchesReference(value, record.payload);
  }
  if (record.kind === 'workspace/activated') {
    return isWorkspaceSnapshot(record.payload) && matchesReference(value, record.payload.summary);
  }
  if (record.kind === 'workspace/attentionChanged') {
    return (
      isRecord(record.payload) &&
      isAttentionItem(record.payload.item) &&
      isWorkspaceSummary(record.payload.summary) &&
      record.payload.item.workspaceId === value.workspaceId &&
      matchesReference(value, record.payload.summary)
    );
  }
  if (record.kind === 'input/requested' || record.kind === 'input/responseSubmitted' || record.kind === 'input/resolved') {
    return isInputRequest(record.payload) && record.payload.workspaceId === value.workspaceId;
  }
  if (record.kind === 'workspace/uiStateChanged') {
    return isRecord(record.payload) && record.payload.workspaceId === value.workspaceId && isWorkspaceUiStateRecord(record.payload.record);
  }
  return isCoreEvent({ jsonrpc: '2.0', method: record.kind, params: record.payload });
}

export function isWorkbenchSnapshot(value: unknown): value is WorkbenchSnapshot {
  if (!isRecord(value) || !Array.isArray(value.workspaces) || !value.workspaces.every(isWorkspaceSummary)) return false;
  if (!isNonNegativeInteger(value.sequence) || !isWorkspaceAttentionSummary(value.aggregateAttention)) return false;
  if (!Array.isArray(value.attentionItems) || !value.attentionItems.every(isAttentionItem)) return false;
  if (!Array.isArray(value.inputRequests) || !value.inputRequests.every(isInputRequest)) return false;
  if (!isRecord(value.workspaceUiState) || !Object.values(value.workspaceUiState).every(isWorkspaceUiStateRecord)) return false;
  if (!Array.isArray(value.legacyReviewImports) || !value.legacyReviewImports.every(isLegacyReviewImportReport)) return false;
  if (value.restoreDiagnostics !== undefined) {
    if (!Array.isArray(value.restoreDiagnostics) || !value.restoreDiagnostics.every(isRestoreDiagnostic)) return false;
  }
  if (
    !hasUniqueIds(value.workspaces, 'workspaceId') ||
    !hasUniqueIds(value.attentionItems, 'id') ||
    !hasUniqueIds(value.inputRequests, 'id')
  ) {
    return false;
  }
  const workspaceIds = new Set(value.workspaces.map((workspace) => workspace.workspaceId));
  if (!value.attentionItems.every((item) => workspaceIds.has(item.workspaceId))) return false;
  if (!value.inputRequests.every((request) => workspaceIds.has(request.workspaceId))) return false;
  if (!Object.keys(value.workspaceUiState).every((workspaceId) => workspaceIds.has(workspaceId))) return false;
  if (
    !value.legacyReviewImports.every((report) => workspaceIds.has(report.workspaceId)) ||
    new Set(value.legacyReviewImports.map((report) => report.workspaceId)).size !== value.legacyReviewImports.length
  ) {
    return false;
  }
  if (!sameAttentionSummary(value.aggregateAttention, aggregateAttention(value.workspaces))) return false;
  if (value.activeWorkspaceId === null && value.activeWorkspace === null) return true;
  const activeWorkspace = value.activeWorkspace;
  if (!isNonEmptyString(value.activeWorkspaceId) || !isWorkspaceSnapshot(activeWorkspace)) return false;
  return (
    activeWorkspace.summary.workspaceId === value.activeWorkspaceId &&
    value.workspaces.some((workspace) => matchesReference(workspace, activeWorkspace.summary))
  );
}

function isLegacyReviewImportReport(value: unknown): value is LegacyReviewImportReport {
  return (
    isRecord(value) &&
    isNonEmptyString(value.workspaceId) &&
    isNonNegativeInteger(value.imported) &&
    isNonNegativeInteger(value.alreadyImported) &&
    isNonNegativeInteger(value.diagnostics)
  );
}

function isRestoreDiagnostic(value: unknown): value is RestoreDiagnostic {
  return (
    isRecord(value) &&
    isNonEmptyString(value.workspaceId) &&
    isNonEmptyString(value.root) &&
    isNonEmptyString(value.displayName) &&
    isNonEmptyString(value.message)
  );
}

export function isWorkspaceSummary(value: unknown): value is WorkspaceSummary {
  if (!isRecord(value) || !isWorkspaceReference(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  const hasValidServiceHealth =
    record.serviceHealth === undefined ||
    (isRecord(record.serviceHealth) &&
      (record.serviceHealth.repositoryWatcher === 'running' ||
        record.serviceHealth.repositoryWatcher === 'stopped' ||
        record.serviceHealth.repositoryWatcher === 'failed'));
  return (
    typeof record.root === 'string' &&
    typeof record.displayName === 'string' &&
    (record.state === 'opening' ||
      record.state === 'ready' ||
      record.state === 'degraded' ||
      record.state === 'closing' ||
      record.state === 'closed') &&
    isWorkspaceAttentionSummary(record.attention) &&
    hasValidServiceHealth
  );
}

export function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  return (
    isRecord(value) &&
    isWorkspaceSummary(value.summary) &&
    isRecord(value.repository) &&
    typeof value.repository.root === 'string' &&
    typeof value.repository.head === 'string'
  );
}

export function aggregateAttention(workspaces: WorkspaceSummary[]): WorkspaceAttentionSummary {
  const summary = workspaces.reduce(
    (result, workspace) => ({
      inputRequired: result.inputRequired + workspace.attention.inputRequired,
      errors: result.errors + workspace.attention.errors,
      unread: result.unread + workspace.attention.unread,
      running: result.running + workspace.attention.running,
    }),
    { inputRequired: 0, errors: 0, unread: 0, running: 0 },
  );
  return {
    ...summary,
    total: summary.inputRequired + summary.errors + summary.unread + summary.running,
    state: attentionStateForCounts(summary),
  };
}

function attentionStateForCounts(value: Pick<WorkspaceAttentionSummary, 'inputRequired' | 'errors' | 'unread' | 'running'>) {
  if (value.inputRequired > 0) return 'input-required';
  if (value.errors > 0) return 'error';
  if (value.unread > 0) return 'unread';
  if (value.running > 0) return 'running';
  return 'idle';
}

function sameAttentionSummary(first: WorkspaceAttentionSummary, second: WorkspaceAttentionSummary): boolean {
  return (
    first.state === second.state &&
    first.inputRequired === second.inputRequired &&
    first.errors === second.errors &&
    first.unread === second.unread &&
    first.running === second.running &&
    first.total === second.total
  );
}

function isEventBase(value: Record<string, unknown>): boolean {
  return isRevision(value.sequence) && isNonEmptyString(value.eventId);
}

function matchesReference(first: WorkspaceReference, second: WorkspaceReference): boolean {
  return first.workspaceId === second.workspaceId && first.workspaceGeneration === second.workspaceGeneration;
}

function hasUniqueIds<T extends Record<K, string>, K extends keyof T>(values: T[], key: K): boolean {
  return new Set(values.map((value) => value[key])).size === values.length;
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length;
}

function optionalString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isRevision(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isMutationOutcome(value: unknown): value is MutationOutcome {
  return value === 'applied' || value === 'unchanged' || value === 'stale' || value === 'invalid';
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
