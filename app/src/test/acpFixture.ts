import type { AcpAdapter, AcpSnapshot, AcpSession, AcpHistory } from '../lib/acpContract';
export const adapter: AcpAdapter = {
  id: 'fixture',
  executable: '/usr/bin/fixture',
  args: [],
  environmentKeys: ['PATH'],
  authenticationProfile: null,
  multiplex: true,
};
export function acpSnapshot(workspaceId = 'workspace-a', workspaceGeneration = 'generation-a'): AcpSnapshot {
  const session: AcpSession = {
    id: `session-${workspaceId}`,
    hostId: 'host',
    workspaceId,
    workspaceGeneration,
    adapterId: adapter.id,
    remoteSessionId: 'remote',
    capabilities: {},
    state: 'ready',
    turnId: null,
    permissionPolicy: 'deny-all',
    reviewSessionId: null,
    modes: null,
    authenticationProfile: null,
    historyRevision: 0,
    continuity: 'new',
  };
  return {
    workspaceId,
    workspaceGeneration,
    sessions: [session],
    inputs: [],
    turnsBySession: { [session.id]: [] },
    sequence: 0,
    workbenchSequence: 900,
    summary: {
      workspaceId,
      workspaceGeneration,
      displayName: workspaceId,
      root: `/repo/${workspaceId}`,
      state: 'ready',
      attention: { state: 'idle', inputRequired: 0, errors: 0, unread: 0, running: 0, total: 0 },
    },
  };
}
export const historyEntry = (sessionId: string, sequence = 1, text = 'Hello'): AcpHistory => ({
  sessionId,
  sequence,
  turnId: 'turn',
  kind: 'agent-message',
  content: { messageId: 'message', content: { type: 'text', text } },
});
