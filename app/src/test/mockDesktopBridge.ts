import { vi, type Mocked } from 'vitest';
import { acpMethodNames, type AcpApi, type AcpEventBatch } from '../lib/acpContract';
import type { AttentionNavigationRequest, DesktopBridge } from '../lib/desktopBridge';
import type { WorkbenchEvent, WorkspaceRequest } from '../lib/workbenchContract';

export type MockDesktopBridge = Mocked<DesktopBridge> & {
  emitWorkbenchEvent(event: WorkbenchEvent): void;
  emitAttentionNavigation(request: AttentionNavigationRequest): void;
  emitAcpEventBatch(batch: AcpEventBatch): void;
};

export function createMockDesktopBridge(): MockDesktopBridge {
  const listeners = new Set<(event: WorkbenchEvent) => void>();
  const navigationListeners = new Set<(request: AttentionNavigationRequest) => void>();
  const workspaceRequest = vi.fn<WorkspaceRequest>();
  const acpListeners = new Set<(batch: AcpEventBatch) => void>();
  const acp = Object.fromEntries(acpMethodNames.map((method) => [method, vi.fn()])) as unknown as Mocked<AcpApi>;
  acp.getAcpSnapshot.mockRejectedValue(new Error('UNSUPPORTED_METHOD: ACP is not configured in this mock'));
  acp.discoverAcpAdapters.mockResolvedValue([]);
  acp.readAcpEvents.mockResolvedValue({ events: [], requiresSnapshot: false });

  return {
    startAcpReviewWaves: vi.fn<DesktopBridge['startAcpReviewWaves']>(),
    getAcpReviewWaves: vi.fn<DesktopBridge['getAcpReviewWaves']>().mockResolvedValue([]),
    cancelAcpReviewWaves: vi.fn<DesktopBridge['cancelAcpReviewWaves']>().mockResolvedValue(null),
    ...acp,
    onAcpEventBatch: vi.fn((listener) => {
      acpListeners.add(listener);
      return () => acpListeners.delete(listener);
    }),
    emitAcpEventBatch(batch) {
      for (const listener of acpListeners) listener(batch);
    },
    pickRepository: vi.fn<DesktopBridge['pickRepository']>().mockResolvedValue(null),
    openLspConfig: vi.fn<DesktopBridge['openLspConfig']>().mockResolvedValue(''),
    getVersion: vi.fn<DesktopBridge['getVersion']>().mockResolvedValue({ name: 'Diffuse', version: 'test' }),
    getWorkbenchSnapshot: vi.fn<DesktopBridge['getWorkbenchSnapshot']>().mockResolvedValue({
      workspaces: [],
      activeWorkspaceId: null,
      activeWorkspace: null,
      aggregateAttention: { state: 'idle', inputRequired: 0, errors: 0, unread: 0, running: 0, total: 0 },
      attentionItems: [],
      inputRequests: [],
      workspaceUiState: {},
      legacyReviewImports: [],
      sequence: 0,
    }),
    readyForWorkbenchNavigation: vi.fn<DesktopBridge['readyForWorkbenchNavigation']>().mockResolvedValue(undefined),
    getWorkspaceSnapshot: vi.fn<DesktopBridge['getWorkspaceSnapshot']>(),
    openWorkspace: vi.fn<DesktopBridge['openWorkspace']>(),
    activateWorkspace: vi.fn<DesktopBridge['activateWorkspace']>(),
    closeWorkspace: vi.fn<DesktopBridge['closeWorkspace']>(),
    dismissRestoreFailure: vi.fn<DesktopBridge['dismissRestoreFailure']>(),
    reorderWorkspaces: vi.fn<DesktopBridge['reorderWorkspaces']>((workspaceIds) => Promise.resolve({ workspaceIds })),
    saveWorkspaceUiState: vi.fn<DesktopBridge['saveWorkspaceUiState']>((_reference, expectedRevision, state) =>
      Promise.resolve({
        outcome: 'applied',
        record: { revision: expectedRevision + 1, state, updatedAt: new Date().toISOString() },
      }),
    ),
    acknowledgeAttention: vi.fn<DesktopBridge['acknowledgeAttention']>(),
    answerInputRequest: vi.fn<DesktopBridge['answerInputRequest']>(),
    cancelInputRequest: vi.fn<DesktopBridge['cancelInputRequest']>(),
    workspaceRequest,
    onWorkbenchEvent: vi.fn<DesktopBridge['onWorkbenchEvent']>((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    onAttentionNavigation: vi.fn<DesktopBridge['onAttentionNavigation']>((listener) => {
      navigationListeners.add(listener);
      return () => navigationListeners.delete(listener);
    }),
    emitWorkbenchEvent(event) {
      for (const listener of listeners) listener(event);
    },
    emitAttentionNavigation(request) {
      for (const listener of navigationListeners) listener(request);
    },
  };
}
