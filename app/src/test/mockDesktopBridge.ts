import { vi, type Mocked } from 'vitest';
import type { CoreEvent, CoreRequest } from '../lib/coreContract';
import type { DesktopBridge } from '../lib/desktopBridge';

export type MockDesktopBridge = Mocked<DesktopBridge> & {
  emitCoreEvent(event: CoreEvent): void;
};

export function createMockDesktopBridge(): MockDesktopBridge {
  const listeners = new Set<(event: CoreEvent) => void>();
  const coreRequest = vi.fn<CoreRequest>();

  return {
    pickRepository: vi.fn<DesktopBridge['pickRepository']>().mockResolvedValue(null),
    getLaunchRepository: vi.fn<DesktopBridge['getLaunchRepository']>().mockResolvedValue(null),
    openLspConfig: vi.fn<DesktopBridge['openLspConfig']>().mockResolvedValue(''),
    coreRequest,
    onCoreEvent: vi.fn<DesktopBridge['onCoreEvent']>((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    startReviewAgent: vi.fn<DesktopBridge['startReviewAgent']>().mockResolvedValue({ running: true }),
    stopReviewAgent: vi.fn<DesktopBridge['stopReviewAgent']>().mockResolvedValue({ running: false }),
    chatWithReviewAgent: vi.fn<DesktopBridge['chatWithReviewAgent']>(),
    emitCoreEvent(event) {
      for (const listener of listeners) listener(event);
    },
  };
}
