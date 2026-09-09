import { describe, expect, it, vi } from 'vitest';
import { acpMethodNames, createAcpApi, isAcpAdapter, isAcpEventBatch, isAcpRequest, isAcpResult, isAcpSnapshot } from './acpContract';
import { acpSnapshot, adapter, historyEntry } from '../test/acpFixture';
const context = { workspaceId: 'workspace-a', workspaceGeneration: 'generation-a', requestId: 'request' };
describe('ACP desktop boundary', () => {
  it('requires explicit workspace generations, exact fields, and safe cursors', () => {
    expect(isAcpRequest('queueAcpPrompt', { context, sessionId: 's', text: 'hello' })).toBe(true);
    expect(isAcpRequest('queueAcpPrompt', { context: { workspaceId: 'a' }, sessionId: 's', text: 'hello' })).toBe(false);
    expect(isAcpRequest('cancelAcpTurn', { context, sessionId: 's', turnId: 't', workspaceId: 'other' })).toBe(false);
    expect(isAcpRequest('readAcpEvents', { afterSequence: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(isAcpRequest('getAcpHistory', { context, sessionId: 's', after: -1 })).toBe(false);
    expect(isAcpRequest('openAcpSession', { context, adapterId: 'a', reviewSessionId: 'review', interactive: true })).toBe(false);
    expect(isAcpRequest('queueAcpPrompt', { context, sessionId: 's', text: 'x'.repeat(256 * 1024) })).toBe(false);
  });
  it('rejects persisted environment values and relative executables', () => {
    expect(isAcpAdapter(adapter)).toBe(true);
    expect(isAcpAdapter({ ...adapter, environment: { TOKEN: 'secret' } })).toBe(false);
    expect(isAcpAdapter({ ...adapter, environmentKeys: ['TOKEN=secret'] })).toBe(false);
    expect(isAcpAdapter({ ...adapter, executable: 'fixture' })).toBe(false);
    expect(isAcpAdapter({ ...adapter, args: ['--api-key=credential'] })).toBe(false);
    expect(isAcpAdapter({ ...adapter, args: ['--token', 'credential'] })).toBe(false);
    expect(isAcpAdapter({ ...adapter, args: ['PROVIDER_TOKEN=credential'] })).toBe(false);
    expect(isAcpAdapter({ ...adapter, args: ['--token-env', 'PROVIDER_TOKEN'] })).toBe(true);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(isAcpRequest('saveAcpAdapter', circular)).toBe(false);
    expect(isAcpRequest('queueAcpPrompt', { context, sessionId: 's', text: '\u6587'.repeat(100000) })).toBe(false);
  });
  it('validates native snapshot identities without mixing sequence domains', () => {
    const snapshot = acpSnapshot();
    expect(isAcpSnapshot(snapshot)).toBe(true);
    expect(isAcpResult('getAcpSnapshot', snapshot, context)).toBe(true);
    expect(isAcpResult('getAcpSnapshot', snapshot, { ...context, workspaceGeneration: 'old' })).toBe(false);
    expect(isAcpSnapshot({ ...snapshot, inputs: [{}] })).toBe(false);
    expect(isAcpResult('getAcpHistory', [historyEntry('other')], { context, sessionId: 's' })).toBe(false);
    expect(isAcpEventBatch({ events: [], requiresSnapshot: true, sequence: 42 })).toBe(true);
    expect(isAcpEventBatch({ events: [], requiresSnapshot: true, sequence: -1 })).toBe(false);
  });
  it('exports every named method and rejects invalid data before IPC', async () => {
    const invoke = vi.fn(async () => null);
    const api = createAcpApi(invoke);
    expect(Object.keys(api)).toEqual(acpMethodNames);
    await expect(api.saveAcpAdapter({ ...adapter, executable: 'relative' })).rejects.toThrow('Invalid ACP request');
    expect(invoke).not.toHaveBeenCalled();
    await api.saveAcpAdapter(adapter);
    expect(invoke).toHaveBeenCalledWith('saveAcpAdapter', adapter);
    await expect(api.openAcpSession({ context, adapterId: 'a' })).rejects.toThrow('Invalid ACP response');
  });
});
