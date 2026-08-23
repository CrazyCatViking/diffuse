// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { diffSurfaceId, useCursorStore, type DiffSurface } from './cursor';

describe('cursor workspace restoration', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
  });

  it('isolates identical file surface IDs across workspaces', () => {
    const cursor = useCursorStore();
    cursor.restoreRestorationState('workspace-a');
    const first = cursor.registerSurface(diffSurface('src/main.ts', 12), mount(diffSurfaceId('src/main.ts', 'new')));
    first.value.position.line = 42;
    const firstState = cursor.captureRestorationState();

    cursor.restoreRestorationState('workspace-b');
    const second = cursor.registerSurface(diffSurface('src/main.ts', 3), mount(diffSurfaceId('src/main.ts', 'new')));
    expect(second.value.position.line).toBe(3);

    cursor.restoreRestorationState('workspace-a', firstState);
    const restored = cursor.registerSurface(diffSurface('src/main.ts', 1), mount(diffSurfaceId('src/main.ts', 'new')));
    expect(restored.value.position.line).toBe(42);
  });
});

function diffSurface(fileId: string, line: number): DiffSurface {
  return {
    id: diffSurfaceId(fileId, 'new'),
    type: 'diff',
    position: { fileId, pane: 'inline', side: 'new', line, column: 0, rowIndex: 0, displayIndex: 0, target: 'code' },
  };
}

function mount(id: string) {
  return { id, getRect: () => new DOMRect(0, 0, 100, 100), isEligible: () => true };
}
