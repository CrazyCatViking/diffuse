// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import WorkspaceAttentionBadge from './WorkspaceAttentionBadge.vue';

describe('WorkspaceAttentionBadge', () => {
  it('shows priority, count, accessible category detail, and degraded health independently', () => {
    const wrapper = mount(WorkspaceAttentionBadge, {
      props: {
        state: 'degraded',
        attention: { state: 'input-required', inputRequired: 2, errors: 1, unread: 3, running: 4, total: 10 },
      },
    });

    expect(wrapper.text()).toContain('Needs input');
    expect(wrapper.text()).toContain('2');
    expect(wrapper.text()).toContain('Degraded');
    expect(wrapper.get('.workspace-status').attributes('aria-label')).toContain('1 errors, 3 unread, 4 running');
  });
});
