import { describe, expect, it } from 'vitest';
import { windowCloseDisposition } from './windowLifecycle';

describe('window lifecycle', () => {
  it('hides a normal close when tray recovery is available', () => {
    expect(windowCloseDisposition(false, true)).toBe('hide');
  });

  it('allows explicit quit and falls back to quit without a tray', () => {
    expect(windowCloseDisposition(true, true)).toBe('close');
    expect(windowCloseDisposition(false, false)).toBe('quit');
  });
});
