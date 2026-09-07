// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import type { AttentionItem, InputRequest, WorkspaceSummary } from '../../lib/workbenchContract';
import { createMockDesktopBridge } from '../../test/mockDesktopBridge';
import { useWorkbenchStore } from '../../stores/workbench';
import WorkspaceInputDrawer from './WorkspaceInputDrawer.vue';

describe('WorkspaceInputDrawer', () => {
  it('acknowledges only the exact attention revision and waits for authoritative submit status', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const bridge = createMockDesktopBridge();
    const summary = workspaceSummary();
    const request = inputRequest();
    const attention = attentionItem();
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [summary],
      activeWorkspaceId: 'workspace-a',
      activeWorkspace: { summary, repository: { root: '/repo/a', head: 'head' } },
      aggregateAttention: summary.attention,
      attentionItems: [attention],
      inputRequests: [request],
      workspaceUiState: {},
      legacyReviewImports: [],
      sequence: 0,
    });
    bridge.acknowledgeAttention.mockResolvedValue({
      outcome: 'applied',
      item: { ...attention, status: 'acknowledged' },
      summary: summary.attention,
    });
    bridge.answerInputRequest.mockResolvedValue({
      outcome: 'applied',
      input: { ...request, revision: 2, status: 'response-submitted' },
      attention: { ...attention, revision: 2 },
      summary: summary.attention,
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/w/:workspaceId/input/:inputRequestId', component: WorkspaceInputDrawer }],
    });
    await router.push('/w/workspace-a/input/input-1');
    await router.isReady();

    const wrapper = mount(WorkspaceInputDrawer, { attachTo: document.body, global: { plugins: [pinia, router] } });
    await vi.waitFor(() => expect(bridge.acknowledgeAttention).toHaveBeenCalledOnce());
    expect(bridge.acknowledgeAttention).toHaveBeenCalledWith({
      context: expect.objectContaining({ workspaceId: 'workspace-a', workspaceGeneration: 'generation-a' }),
      attentionId: 'attention-1',
      revision: 4,
    });

    await wrapper.get('input[value="Allow"]').setValue(true);
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => expect(bridge.answerInputRequest).toHaveBeenCalledOnce());
    expect(bridge.answerInputRequest).toHaveBeenCalledWith({
      context: expect.objectContaining({ workspaceId: 'workspace-a', workspaceGeneration: 'generation-a' }),
      inputRequestId: 'input-1',
      revision: 2,
      response: { value: 'Allow', secret: undefined },
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain('Waiting for the provider to accept it'));
    expect(store.inputRequests['input-1'].status).toBe('response-submitted');
    wrapper.unmount();
  });

  it('renders every terminal status distinctly', async () => {
    const statuses: InputRequest['status'][] = ['accepted', 'rejected', 'expired', 'cancelled', 'superseded'];
    const descriptions = ['accepted', 'rejected', 'expired', 'cancelled', 'superseded'];

    for (const [index, status] of statuses.entries()) {
      const pinia = createPinia();
      setActivePinia(pinia);
      window.diffuse = createMockDesktopBridge();
      const store = useWorkbenchStore();
      store.$patch({ inputRequests: { 'input-1': { ...inputRequest(), status } } });
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/w/:workspaceId/input/:inputRequestId', component: WorkspaceInputDrawer }],
      });
      await router.push('/w/workspace-a/input/input-1');
      const wrapper = mount(WorkspaceInputDrawer, { global: { plugins: [pinia, router] } });

      expect(wrapper.text().toLocaleLowerCase()).toContain(descriptions[index]);
      wrapper.unmount();
    }
  });

  it('does not acknowledge programmatic focus while the document is hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const pinia = createPinia();
    setActivePinia(pinia);
    const bridge = createMockDesktopBridge();
    const summary = workspaceSummary();
    const request = inputRequest();
    const attention = attentionItem();
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [summary],
      activeWorkspaceId: summary.workspaceId,
      activeWorkspace: { summary, repository: { root: summary.root, head: 'head' } },
      aggregateAttention: summary.attention,
      attentionItems: [attention],
      inputRequests: [request],
      workspaceUiState: {},
      legacyReviewImports: [],
      sequence: 0,
    });
    bridge.acknowledgeAttention.mockResolvedValue({
      outcome: 'applied',
      item: { ...attention, status: 'acknowledged' },
      summary: summary.attention,
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/w/:workspaceId/input/:inputRequestId', component: WorkspaceInputDrawer }],
    });
    await router.push('/w/workspace-a/input/input-1');
    const wrapper = mount(WorkspaceInputDrawer, { attachTo: document.body, global: { plugins: [pinia, router] } });

    await Promise.resolve();
    expect(bridge.acknowledgeAttention).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(bridge.acknowledgeAttention).toHaveBeenCalledOnce());
    wrapper.unmount();
    visibility.mockRestore();
  });

  it('erases an authentication draft when its surface unmounts', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const bridge = createMockDesktopBridge();
    const summary = workspaceSummary();
    const request = { ...inputRequest(), kind: 'authentication' as const, choices: [] };
    bridge.getWorkbenchSnapshot.mockResolvedValue({
      workspaces: [summary],
      activeWorkspaceId: summary.workspaceId,
      activeWorkspace: { summary, repository: { root: summary.root, head: 'head' } },
      aggregateAttention: summary.attention,
      attentionItems: [],
      inputRequests: [request],
      workspaceUiState: {},
      legacyReviewImports: [],
      sequence: 0,
    });
    window.diffuse = bridge;
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/w/:workspaceId/input/:inputRequestId', component: WorkspaceInputDrawer }],
    });
    await router.push('/w/workspace-a/input/input-1');
    const wrapper = mount(WorkspaceInputDrawer, { attachTo: document.body, global: { plugins: [pinia, router] } });

    const passwordInput = wrapper.get('input[type="password"]');
    await passwordInput.setValue('top-secret');
    expect(store.inputDraft(request)).toBe('');
    expect((passwordInput.element as HTMLInputElement).value).toBe('top-secret');
    wrapper.unmount();

    expect(store.inputDraft(request)).toBe('');
    expect((passwordInput.element as HTMLInputElement).value).toBe('');
    expect(window.localStorage.getItem('diffuse.workbench.ui.v1')).not.toContain('top-secret');
  });
});

function workspaceSummary(): WorkspaceSummary {
  return {
    workspaceId: 'workspace-a',
    workspaceGeneration: 'generation-a',
    root: '/repo/a',
    displayName: 'alpha',
    state: 'ready',
    attention: { state: 'input-required', inputRequired: 1, errors: 0, unread: 0, running: 0, total: 1 },
  };
}

function inputRequest(): InputRequest {
  return {
    id: 'input-1',
    workspaceId: 'workspace-a',
    revision: 2,
    kind: 'permission',
    status: 'pending',
    prompt: 'Allow command?',
    choices: ['Allow', 'Deny'],
    cancellationSupported: true,
    attentionId: 'attention-1',
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:01:00.000Z',
  };
}

function attentionItem(): AttentionItem {
  return {
    id: 'attention-1',
    workspaceId: 'workspace-a',
    sourceId: 'agent-1',
    kind: 'input',
    revision: 4,
    status: 'unread',
    target: { kind: 'input', inputRequestId: 'input-1' },
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:01:00.000Z',
  };
}
