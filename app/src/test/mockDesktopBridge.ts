import { vi, type Mocked } from 'vitest';
import type { AttentionNavigationRequest, DesktopBridge } from '../lib/desktopBridge';
import type { WorkbenchEvent, WorkspaceRequest } from '../lib/workbenchContract';

export type MockDesktopBridge = Mocked<DesktopBridge> & {
  emitWorkbenchEvent(event: WorkbenchEvent): void;
  emitAttentionNavigation(request: AttentionNavigationRequest): void;
};

export function createMockDesktopBridge(): MockDesktopBridge {
  const listeners = new Set<(event: WorkbenchEvent) => void>();
  const navigationListeners = new Set<(request: AttentionNavigationRequest) => void>();
  const workspaceRequest = vi.fn<WorkspaceRequest>();

  return {
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
    startReviewAgent: vi.fn<DesktopBridge['startReviewAgent']>().mockResolvedValue({ running: true }),
    stopReviewAgent: vi.fn<DesktopBridge['stopReviewAgent']>().mockResolvedValue({ running: false }),
    chatWithReviewAgent: vi.fn<DesktopBridge['chatWithReviewAgent']>(),
    emitWorkbenchEvent(event) {
      for (const listener of listeners) listener(event);
    },
    emitAttentionNavigation(request) {
      for (const listener of navigationListeners) listener(request);
    },
  };
}
