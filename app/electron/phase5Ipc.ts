import {
  isInputResponse,
  isCloseWorkspaceRequest,
  isWorkspaceReference,
  isWorkspaceRequestContext,
  isSaveWorkspaceUiStateRequest,
  type AnswerInputRequest,
  type AttentionCasRequest,
  type InputCasRequest,
  type WorkspaceOrderResult,
  type WorkspaceReference,
  type SaveWorkspaceUiStateRequest,
  type CloseWorkspaceRequest,
} from '../src/lib/workbenchContract';

export function parseWorkspaceCloseRequest(value: unknown): CloseWorkspaceRequest {
  if (!isCloseWorkspaceRequest(value)) throw new Error('Invalid workspace close request');
  return value;
}

export function parseDismissRestoreFailureRequest(value: unknown): string {
  if (!isRecord(value) || !isNonEmptyString(value.workspaceId)) throw new Error('Invalid restore failure dismissal request');
  return value.workspaceId;
}

export function parseWorkspaceSnapshotRequest(value: unknown): WorkspaceReference {
  if (!isWorkspaceReference(value)) throw new Error('Invalid workspace reference');
  return value;
}

export function parseWorkspaceOrderRequest(value: unknown): WorkspaceOrderResult {
  if (!isRecord(value) || !isUniqueStringArray(value.workspaceIds)) throw new Error('Invalid workspace order request');
  return { workspaceIds: value.workspaceIds };
}

export function parseWorkspaceUiStateRequest(value: unknown): SaveWorkspaceUiStateRequest {
  if (!isSaveWorkspaceUiStateRequest(value)) throw new Error('Invalid workspace UI state request');
  return value;
}

export function parseAttentionAcknowledgeRequest(value: unknown): AttentionCasRequest {
  if (
    !isRecord(value) ||
    !isWorkspaceRequestContext(value.context) ||
    !isNonEmptyString(value.attentionId) ||
    !isPositiveSafeInteger(value.revision)
  ) {
    throw new Error('Invalid attention acknowledgement request');
  }
  return {
    workspaceId: value.context.workspaceId,
    workspaceGeneration: value.context.workspaceGeneration,
    attentionId: value.attentionId,
    expectedRevision: value.revision,
  };
}

export function parseInputAnswerRequest(value: unknown): AnswerInputRequest {
  const request = parseInputRequest(value, 'answer');
  if (!isRecord(value) || !isInputResponse(value.response)) throw new Error('Invalid input answer request');
  return { ...request, response: value.response, redactResponse: value.response.secret === true };
}

export function parseInputCancelRequest(value: unknown): InputCasRequest {
  return parseInputRequest(value, 'cancellation');
}

function parseInputRequest(value: unknown, operation: 'answer' | 'cancellation'): InputCasRequest {
  if (
    !isRecord(value) ||
    !isWorkspaceRequestContext(value.context) ||
    !isNonEmptyString(value.inputRequestId) ||
    !isPositiveSafeInteger(value.revision)
  ) {
    throw new Error(`Invalid input ${operation} request`);
  }
  return {
    workspaceId: value.context.workspaceId,
    workspaceGeneration: value.context.workspaceGeneration,
    inputRequestId: value.inputRequestId,
    expectedRevision: value.revision,
  };
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
