// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { workbenchCommandForEvent } from './workbenchKeybindings';

describe('workbench keybindings', () => {
  it('keeps Ctrl+Tab distinct from Ctrl+I', () => {
    expect(workbenchCommandForEvent(keyEvent('Tab', { ctrlKey: true }))).toBe('nextWorkspace');
    expect(workbenchCommandForEvent(keyEvent('Tab', { ctrlKey: true, shiftKey: true }))).toBe('previousWorkspace');
    expect(workbenchCommandForEvent(keyEvent('i', { ctrlKey: true }))).toBeUndefined();
  });

  it('maps direct workspace slots and workbench commands', () => {
    expect(workbenchCommandForEvent(keyEvent('4', { ctrlKey: true }))).toBe('workspaceSlot4');
    expect(workbenchCommandForEvent(keyEvent('O', { ctrlKey: true, shiftKey: true }))).toBe('workbenchOverview');
    expect(workbenchCommandForEvent(keyEvent('k', { ctrlKey: true }))).toBe('switchWorkspace');
  });
});

function keyEvent(key: string, options: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, ...options });
}
