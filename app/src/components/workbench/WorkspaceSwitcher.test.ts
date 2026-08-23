// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import WorkspaceSwitcher from './WorkspaceSwitcher.vue';

describe('WorkspaceSwitcher', () => {
  it('exposes searchable listbox options and initial focus', async () => {
    const wrapper = mount(WorkspaceSwitcher, {
      attachTo: document.body,
      props: {
        workspaces: [{ workspaceId: 'a', workspaceGeneration: 'ga', root: '/repo/alpha', displayName: 'alpha', state: 'ready' as const }],
        recentRepositories: [{ path: '/repo/beta', name: 'beta', openedAt: 1 }],
      },
    });
    await nextTick();
    expect(wrapper.get('[role="listbox"]').attributes('aria-label')).toBe('Workspaces');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(2);
    expect(document.activeElement).toBe(wrapper.get('input[type="search"]').element);

    await wrapper.get('input[type="search"]').trigger('keydown', { key: 'ArrowDown' });
    await wrapper.get('input[type="search"]').setValue('beta');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
    expect(wrapper.get('input[type="search"]').attributes('aria-activedescendant')).toBe('workspace-option-0');
    wrapper.unmount();
  });
});
