// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import WorkspaceRail from './WorkspaceRail.vue';

describe('WorkspaceRail', () => {
  const workspaces = [
    { workspaceId: 'a', workspaceGeneration: 'ga', root: '/repo/a', displayName: 'alpha', state: 'ready' as const },
    { workspaceId: 'b', workspaceGeneration: 'gb', root: '/repo/b', displayName: 'beta', state: 'ready' as const },
  ];

  it('uses a vertical tablist with roving keyboard focus', async () => {
    const wrapper = mount(WorkspaceRail, {
      attachTo: document.body,
      props: { workspaces, activeWorkspaceId: 'a', overviewSelected: false },
    });
    const tabs = wrapper.findAll('[role="tab"]');
    expect(wrapper.get('[role="tablist"]').attributes('aria-orientation')).toBe('vertical');
    expect(tabs).toHaveLength(3);
    expect(tabs[1].attributes('tabindex')).toBe('0');

    (tabs[1].element as HTMLButtonElement).focus();
    await tabs[1].trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tabs[2].element);
    await tabs[2].trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')?.at(-1)).toEqual(['b']);
    wrapper.unmount();
  });
});
