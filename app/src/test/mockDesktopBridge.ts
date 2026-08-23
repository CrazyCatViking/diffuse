import { vi, type Mocked } from 'vitest';
import type { DesktopBridge } from '../lib/desktopBridge';
import type { WorkbenchEvent, WorkspaceRequest } from '../lib/workbenchContract';

export type MockDesktopBridge = Mocked<DesktopBridge> & {
  emitWorkbenchEvent(event: WorkbenchEvent): void;
};

export function createMockDesktopBridge(): MockDesktopBridge {
  const listeners = new Set<(event: WorkbenchEvent) => void>();
  const workspaceRequest = vi.fn<WorkspaceRequest>();

  return {
    pickRepository: vi.fn<DesktopBridge['pickRepository']>().mockResolvedValue(null),
    openLspConfig: vi.fn<DesktopBridge['openLspConfig']>().mockResolvedValue(''),
    getVersion: vi.fn<DesktopBridge['getVersion']>().mockResolvedValue({ name: 'Diffuse', version: 'test' }),
    getWorkbenchSnapshot: vi.fn<DesktopBridge['getWorkbenchSnapshot']>().mockResolvedValue({
      workspaces: [],
      activeWorkspaceId: null,
      activeWorkspace: null,
      sequence: 0,
    }),
    openWorkspace: vi.fn<DesktopBridge['openWorkspace']>(),
    activateWorkspace: vi.fn<DesktopBridge['activateWorkspace']>(),
    closeWorkspace: vi.fn<DesktopBridge['closeWorkspace']>(),
    workspaceRequest,
    onWorkbenchEvent: vi.fn<DesktopBridge['onWorkbenchEvent']>((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    startReviewAgent: vi.fn<DesktopBridge['startReviewAgent']>().mockResolvedValue({ running: true }),
    stopReviewAgent: vi.fn<DesktopBridge['stopReviewAgent']>().mockResolvedValue({ running: false }),
    chatWithReviewAgent: vi.fn<DesktopBridge['chatWithReviewAgent']>(),
    emitWorkbenchEvent(event) {
      for (const listener of listeners) listener(event);
    },
  };
}
