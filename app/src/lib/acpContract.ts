import {
  isWorkspaceRequestContext,
  isWorkspaceSummary,
  isInputRequest,
  type WorkspaceRequestContext,
  type WorkspaceSummary,
  type InputRequest,
} from './workbenchContract';

export type AcpAdapter = {
  id: string;
  executable: string;
  args: string[];
  environmentKeys: string[];
  authenticationProfile: string | null;
  multiplex: boolean;
};
export type AcpDiscovery = { adapter: AcpAdapter; available: boolean; platformSupported: boolean };
export type AcpSession = {
  id: string;
  hostId: string;
  workspaceId: string;
  workspaceGeneration: string;
  adapterId: string;
  remoteSessionId: string | null;
  capabilities: unknown;
  state: 'starting' | 'ready' | 'running' | 'failed' | 'closed';
  turnId: string | null;
  permissionPolicy: string;
  reviewSessionId: string | null;
  reviewFileIds?: string[];
  modes: unknown;
  authenticationProfile: string | null;
  historyRevision: number;
  continuity: 'unknown' | 'new' | 'resumed' | 'loaded' | 'reset';
};
export type AcpTurn = {
  id: string;
  sessionId: string;
  requestId: string;
  text: string;
  state: 'queued' | 'admitted' | 'running' | 'completed' | 'cancelled' | 'failed';
  stopReason: string | null;
};
export type AcpHistory = { sequence: number; sessionId: string; turnId: string | null; kind: string; content: unknown };
export type AcpActivity = { sequence: number; sessionId: string; turnId: string | null; kind: string; payload: unknown };
export type AcpInput = { input: InputRequest; sessionId: string; method: string; params: Record<string, unknown> };
export type AcpSnapshot = {
  workspaceId: string;
  workspaceGeneration: string;
  sessions: AcpSession[];
  turnsBySession: Record<string, AcpTurn[]>;
  inputs: AcpInput[];
  summary: WorkspaceSummary;
  sequence: number;
  workbenchSequence: number;
};
export type AcpEvent = {
  sequence: number;
  eventId: string;
  workspaceId: string;
  workspaceGeneration: string;
  kind: string;
  payload: unknown;
};
export type AcpEventBatch = { events: AcpEvent[]; requiresSnapshot: boolean; sequence?: number };
export type AcpSessionRequest = { context: WorkspaceRequestContext; sessionId: string };
export type AcpMethods = {
  saveAcpAdapter: { params: AcpAdapter; result: null };
  discoverAcpAdapters: { params: undefined; result: AcpDiscovery[] };
  openAcpSession: {
    params: {
      context: WorkspaceRequestContext;
      adapterId: string;
      sessionId?: string;
      reviewSessionId?: string;
      reviewFileIds?: string[];
      interactive?: boolean;
    };
    result: { sessionId: string };
  };
  queueAcpPrompt: { params: AcpSessionRequest & { text: string }; result: AcpTurn };
  cancelAcpTurn: { params: AcpSessionRequest & { turnId: string }; result: { cancelled: boolean } };
  cancelAcpSession: { params: AcpSessionRequest; result: null };
  closeAcpSession: { params: AcpSessionRequest; result: null };
  setAcpMode: { params: AcpSessionRequest & { modeId: string }; result: { modeId: string } };
  getAcpSnapshot: { params: WorkspaceRequestContext; result: AcpSnapshot };
  getAcpHistory: { params: AcpSessionRequest & { after?: number }; result: AcpHistory[] };
  getAcpActivity: { params: AcpSessionRequest & { after?: number }; result: AcpActivity[] };
  readAcpEvents: { params: { afterSequence: number }; result: AcpEventBatch };
};
export const acpMethodNames = [
  'saveAcpAdapter',
  'discoverAcpAdapters',
  'openAcpSession',
  'queueAcpPrompt',
  'cancelAcpTurn',
  'cancelAcpSession',
  'closeAcpSession',
  'setAcpMode',
  'getAcpSnapshot',
  'getAcpHistory',
  'getAcpActivity',
  'readAcpEvents',
] as const satisfies readonly (keyof AcpMethods)[];
export type AcpMethod = keyof AcpMethods;
export type AcpApi = {
  [M in AcpMethod]: (
    ...args: undefined extends AcpMethods[M]['params'] ? [request?: AcpMethods[M]['params']] : [request: AcpMethods[M]['params']]
  ) => Promise<AcpMethods[M]['result']>;
};
export type AcpBridge = AcpApi & { onAcpEventBatch(listener: (batch: AcpEventBatch) => void): () => void };
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes('\0');
const nullableText = (v: unknown) => v === null || typeof v === 'string';
const sequence = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
export const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
export const maxAcpPromptBytes = 32 * 1024;
export function isReviewFileIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.every((id) => text(id) && utf8Bytes(id) <= 4096) &&
    new Set(value).size === value.length &&
    value.reduce((bytes, id) => bytes + utf8Bytes(id), 0) <= 128 * 1024
  );
}
export function sameReviewFileIds(first?: string[], second?: string[]) {
  if (first === undefined || second === undefined) return first === second;
  const sorted = [...second].sort();
  return first.length === second.length && [...first].sort().every((id, index) => id === sorted[index]);
}
export function requireBoundedAcpPrompt(text: string) {
  if (!text.trim() || utf8Bytes(text) > maxAcpPromptBytes)
    throw new Error(
      'ACP prompt exceeds 32 KiB or is empty. Shorten repository promptInstructions or the question/discussion before starting the agent.',
    );
}
export function isAcpAdapter(v: unknown): v is AcpAdapter {
  return (
    record(v) &&
    keys(v, ['id', 'executable', 'args', 'environmentKeys', 'authenticationProfile', 'multiplex']) &&
    text(v.id) &&
    v.id.length <= 256 &&
    text(v.executable) &&
    /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(v.executable) &&
    Array.isArray(v.args) &&
    v.args.length <= 128 &&
    v.args.every(
      (s) =>
        typeof s === 'string' &&
        s.length <= 4096 &&
        !s.includes('\0') &&
        !/^--?(?:api[-_]?key|access[-_]?token|token|password|secret|authorization)(?:=|$)/i.test(s) &&
        !/^(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=/.test(s),
    ) &&
    Array.isArray(v.environmentKeys) &&
    v.environmentKeys.length <= 128 &&
    v.environmentKeys.every((s) => text(s) && s.length <= 256 && !s.includes('=')) &&
    (v.authenticationProfile === null || (text(v.authenticationProfile) && v.authenticationProfile.length <= 256)) &&
    typeof v.multiplex === 'boolean'
  );
}
export function isAcpSession(v: unknown): v is AcpSession {
  return (
    record(v) &&
    ['id', 'hostId', 'workspaceId', 'workspaceGeneration', 'adapterId', 'permissionPolicy'].every((k) => text(v[k])) &&
    ['starting', 'ready', 'running', 'failed', 'closed'].includes(String(v.state)) &&
    ['unknown', 'new', 'resumed', 'loaded', 'reset'].includes(String(v.continuity)) &&
    sequence(v.historyRevision) &&
    (v.reviewFileIds === undefined || (text(v.reviewSessionId) && isReviewFileIds(v.reviewFileIds))) &&
    ['remoteSessionId', 'turnId', 'reviewSessionId', 'authenticationProfile'].every((k) => nullableText(v[k]))
  );
}
export function isAcpTurn(v: unknown): v is AcpTurn {
  return (
    record(v) &&
    ['id', 'sessionId', 'requestId'].every((k) => text(v[k])) &&
    typeof v.text === 'string' &&
    nullableText(v.stopReason) &&
    ['queued', 'admitted', 'running', 'completed', 'cancelled', 'failed'].includes(String(v.state))
  );
}
export function isAcpSnapshot(v: unknown): v is AcpSnapshot {
  return (
    record(v) &&
    text(v.workspaceId) &&
    text(v.workspaceGeneration) &&
    sequence(v.sequence) &&
    sequence(v.workbenchSequence) &&
    isWorkspaceSummary(v.summary) &&
    v.summary.workspaceId === v.workspaceId &&
    v.summary.workspaceGeneration === v.workspaceGeneration &&
    Array.isArray(v.sessions) &&
    v.sessions.every((s) => isAcpSession(s) && s.workspaceId === v.workspaceId) &&
    record(v.turnsBySession) &&
    Object.entries(v.turnsBySession).every(
      ([id, turns]) => Array.isArray(turns) && turns.every((t) => isAcpTurn(t) && t.sessionId === id),
    ) &&
    Array.isArray(v.inputs) &&
    v.inputs.every(
      (i) =>
        record(i) &&
        isInputRequest(i.input) &&
        i.input.workspaceId === v.workspaceId &&
        text(i.sessionId) &&
        text(i.method) &&
        record(i.params),
    )
  );
}
export function isAcpEventBatch(v: unknown): v is AcpEventBatch {
  if (
    !record(v) ||
    typeof v.requiresSnapshot !== 'boolean' ||
    (v.sequence !== undefined && !sequence(v.sequence)) ||
    !Array.isArray(v.events)
  )
    return false;
  let previous = -1;
  return v.events.every((e) => {
    if (
      !record(e) ||
      !sequence(e.sequence) ||
      e.sequence <= previous ||
      !['eventId', 'workspaceId', 'workspaceGeneration', 'kind'].every((k) => text(e[k])) ||
      !('payload' in e)
    )
      return false;
    previous = e.sequence;
    return true;
  });
}
export function isAcpRequest(method: AcpMethod, v: unknown): boolean {
  if (method === 'discoverAcpAdapters') return v === undefined;
  if (!record(v)) return false;
  try {
    if (new TextEncoder().encode(JSON.stringify(v)).length > 256 * 1024) return false;
  } catch {
    return false;
  }
  if (method === 'saveAcpAdapter') return isAcpAdapter(v);
  if (method === 'readAcpEvents') return keys(v, ['afterSequence']) && sequence(v.afterSequence);
  if (method === 'getAcpSnapshot') return keys(v, ['workspaceId', 'workspaceGeneration', 'requestId']) && isWorkspaceRequestContext(v);
  if (!isWorkspaceRequestContext(v.context) || !keys(v.context, ['workspaceId', 'workspaceGeneration', 'requestId'])) return false;
  if (method === 'openAcpSession')
    return (
      keys(v, ['context', 'adapterId', 'sessionId', 'reviewSessionId', 'reviewFileIds', 'interactive']) &&
      text(v.adapterId) &&
      (v.sessionId === undefined || text(v.sessionId)) &&
      (v.reviewSessionId === undefined || text(v.reviewSessionId)) &&
      (v.reviewFileIds === undefined || (text(v.reviewSessionId) && isReviewFileIds(v.reviewFileIds))) &&
      (v.interactive === undefined || typeof v.interactive === 'boolean') &&
      !(v.reviewSessionId && v.interactive)
    );
  if (!text(v.sessionId)) return false;
  if (method === 'queueAcpPrompt' && (!text(v.text) || utf8Bytes(v.text) > maxAcpPromptBytes)) return false;
  const extra =
    method === 'queueAcpPrompt'
      ? 'text'
      : method === 'cancelAcpTurn'
        ? 'turnId'
        : method === 'setAcpMode'
          ? 'modeId'
          : ['getAcpHistory', 'getAcpActivity'].includes(method)
            ? 'after'
            : '';
  return (
    keys(v, ['context', 'sessionId', extra]) &&
    (!extra || (extra === 'after' ? v.after === undefined || sequence(v.after) : text(v[extra])))
  );
}
export function isAcpResult(method: AcpMethod, v: unknown, request: unknown): boolean {
  const r = record(request) ? request : {};
  if (['saveAcpAdapter', 'cancelAcpSession', 'closeAcpSession'].includes(method)) return v === null;
  if (method === 'discoverAcpAdapters')
    return (
      Array.isArray(v) &&
      v.every((d) => record(d) && isAcpAdapter(d.adapter) && typeof d.available === 'boolean' && typeof d.platformSupported === 'boolean')
    );
  if (method === 'openAcpSession') return record(v) && text(v.sessionId) && (r.sessionId === undefined || r.sessionId === v.sessionId);
  if (method === 'queueAcpPrompt')
    return isAcpTurn(v) && v.sessionId === r.sessionId && record(r.context) && v.requestId === r.context.requestId;
  if (method === 'cancelAcpTurn') return record(v) && typeof v.cancelled === 'boolean';
  if (method === 'getAcpSnapshot')
    return isAcpSnapshot(v) && v.workspaceId === r.workspaceId && v.workspaceGeneration === r.workspaceGeneration;
  if (method === 'readAcpEvents') return isAcpEventBatch(v);
  if (method === 'setAcpMode') return record(v) && text(v.modeId) && v.modeId === r.modeId;
  let previous = Number(r.after ?? 0);
  return (
    Array.isArray(v) &&
    v.length <= 100 &&
    v.every((entry) => {
      if (
        !record(entry) ||
        !sequence(entry.sequence) ||
        entry.sequence <= previous ||
        entry.sessionId !== r.sessionId ||
        !nullableText(entry.turnId) ||
        !text(entry.kind) ||
        !(method === 'getAcpHistory' ? 'content' in entry : 'payload' in entry)
      )
        return false;
      previous = entry.sequence;
      return true;
    })
  );
}
export function createAcpApi(invoke: (method: AcpMethod, request: unknown) => Promise<unknown>): AcpApi {
  return Object.fromEntries(
    acpMethodNames.map((method) => [
      method,
      async (request: unknown) => {
        if (!isAcpRequest(method, request)) throw new Error(`Invalid ACP request: ${method}`);
        const result = await invoke(method, request);
        if (!isAcpResult(method, result, request)) throw new Error(`Invalid ACP response: ${method}`);
        return result;
      },
    ]),
  ) as AcpApi;
}
