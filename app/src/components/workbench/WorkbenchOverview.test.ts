// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import type { AttentionItem, WorkspaceSummary } from '../../lib/workbenchContract';
import { workspaceRouteNames } from '../../lib/workspaceRoutes';
import { useWorkbenchStore } from '../../stores/workbench';
import { createMockDesktopBridge } from '../../test/mockDesktopBridge';
import WorkbenchOverview from './WorkbenchOverview.vue';

describe('WorkbenchOverview', () => {
  it('groups by priority and acknowledges exact attention only after navigation', async () => {
    const bridge = createMockDesktopBridge();
    window.diffuse = bridge;
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkbenchStore();
    const ready = workspace('ready', 'idle');
    const needsInput = workspace('input', 'input-required');
    const item: AttentionItem = {
      id: 'attention-1',
      workspaceId: needsInput.workspaceId,
      sourceId: 'agent-1',
      kind: 'input',
      revision: 1,
      status: 'unread',
      target: { kind: 'input', inputRequestId: 'input-1' },
      createdAt: '2026-09-02T10:00:00.000Z',
      updatedAt: '2026-09-02T10:01:00.000Z',
    };
    bridge.acknowledgeAttention.mockResolvedValue({
      outcome: 'applied',
      item: { ...item, status: 'acknowledged' },
      summary: needsInput.attention,
    });
    store.$patch({ workspaces: [ready, needsInput], attentionItems: { [item.id]: item } });
    const activate = vi.spyOn(store, 'activateWorkspace').mockResolvedValue(undefined);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/workbench', component: WorkbenchOverview },
        { path: '/w/:workspaceId/input/:inputRequestId', name: workspaceRouteNames.input, component: { template: '<div />' } },
      ],
    });
    await router.push('/workbench');
    await router.isReady();
    const wrapper = mount(WorkbenchOverview, { global: { plugins: [pinia, router] } });

    expect(
      wrapper
        .findAll('h2')
        .map((heading) => heading.text())
        .slice(0, 2),
    ).toEqual(['Needs Input', 'Ready']);
    await wrapper.get('.attention-actions button').trigger('click');

    expect(activate).toHaveBeenCalledWith('input');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe(workspaceRouteNames.input));
    await vi.waitFor(() => expect(bridge.acknowledgeAttention).toHaveBeenCalledOnce());
    expect(bridge.acknowledgeAttention).toHaveBeenCalledWith({
      context: expect.objectContaining({ workspaceId: 'input', workspaceGeneration: 'generation-input' }),
      attentionId: 'attention-1',
      revision: 1,
    });
    expect(store.workspaces.map((entry) => entry.workspaceId)).toEqual(['ready', 'input']);
  });

  it('offers retry and durable dismissal for restore failures', async () => {
    const bridge = createMockDesktopBridge();
    bridge.dismissRestoreFailure.mockResolvedValue({ workspaceId: 'failed-1', dismissed: true });
    window.diffuse = bridge;
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkbenchStore();
    store.$patch({
      restoreDiagnostics: [{ workspaceId: 'failed-1', root: '/repo/failed', displayName: 'failed', message: 'Repository missing' }],
    });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workbench', component: WorkbenchOverview }] });
    await router.push('/workbench');
    const wrapper = mount(WorkbenchOverview, { global: { plugins: [pinia, router] } });

    expect(wrapper.text()).toContain('Repository missing');
    await wrapper.get('.restore-actions button:last-child').trigger('click');

    await vi.waitFor(() => expect(bridge.dismissRestoreFailure).toHaveBeenCalledWith('failed-1'));
    expect(store.restoreDiagnostics).toEqual([]);
  });
});

function workspace(workspaceId: string, state: 'idle' | 'input-required'): WorkspaceSummary {
  const inputRequired = state === 'input-required' ? 1 : 0;
  return {
    workspaceId,
    workspaceGeneration: `generation-${workspaceId}`,
    root: `/repo/${workspaceId}`,
    displayName: workspaceId,
    state: 'ready',
    attention: { state, inputRequired, errors: 0, unread: 0, running: 0, total: inputRequired },
  };
}
