// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { acpSnapshot } from '../../test/acpFixture';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import type { AttentionItem, InputRequest, WorkspaceSummary } from '../../lib/workbenchContract';
import { createMockDesktopBridge } from '../../test/mockDesktopBridge';
import { useWorkbenchStore } from '../../stores/workbench';
import WorkspaceInputDrawer from './WorkspaceInputDrawer.vue';

describe('WorkspaceInputDrawer', () => {
  it('restores incomplete nonsecret ACP form fields across remount and clears revision/terminal drafts', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const bridge = createMockDesktopBridge();
    window.diffuse = bridge;
    const snapshot = acpSnapshot();
    const input: InputRequest = { ...inputRequest(), revision: 1, kind: 'question', choices: [] };
    const schema = { type: 'object', properties: { title: { type: 'string' }, count: { type: 'integer' } }, required: ['title', 'count'] };
    snapshot.inputs = [{ input, sessionId: snapshot.sessions[0].id, method: 'elicitation/create', params: { requestedSchema: schema } }];
    bridge.getAcpSnapshot.mockImplementation(async () => structuredClone(snapshot));
    const state = {
      workspaces: [snapshot.summary],
      activeWorkspaceId: snapshot.workspaceId,
      activeWorkspace: null,
      aggregateAttention: snapshot.summary.attention,
      attentionItems: [],
      inputRequests: [input],
      workspaceUiState: {},
      legacyReviewImports: [],
      sequence: 0,
    };
    bridge.getWorkbenchSnapshot.mockImplementation(async () => structuredClone(state));
    const store = useWorkbenchStore();
    await store.initialize(vi.fn());
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/w/:workspaceId/input/:inputRequestId', component: WorkspaceInputDrawer }],
    });
    await router.push('/w/workspace-a/input/input-1');
    const options = { global: { plugins: [pinia, router] } };
    let wrapper = mount(WorkspaceInputDrawer, options);
    await flushPromises();
    await wrapper.get('input[type="text"]').setValue('Partial title');
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
    expect(store.inputFormDraft(input)).toEqual({ title: 'Partial title' });
    wrapper = mount(WorkspaceInputDrawer, options);
    await flushPromises();
    expect((wrapper.get('input[type="text"]').element as HTMLInputElement).value).toBe('Partial title');
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await wrapper.get('input[type="number"]').setValue('2');
    wrapper.unmount();
    wrapper = mount(WorkspaceInputDrawer, options);
    await flushPromises();
    expect((wrapper.get('input[type="number"]').element as HTMLInputElement).value).toBe('2');
    input.revision = 2;
    await store.refreshAgentAttention();
    await flushPromises();
    expect(store.uiState(input.workspaceId).inputFormDrafts).toBeUndefined();
    expect((wrapper.get('input[type="text"]').element as HTMLInputElement).value).toBe('');
    await wrapper.get('input[type="text"]').setValue('Next revision');
    input.status = 'cancelled';
    await store.refreshAgentAttention();
    await flushPromises();
    expect(store.uiState(input.workspaceId).inputFormDrafts).toBeUndefined();
    const secret = { ...input, revision: 3, kind: 'authentication' as const, status: 'pending' as const };
    store.saveInputFormDraft(secret, schema, { title: 'credential' });
    store.saveInputDraft(secret, 'credential');
    expect(JSON.stringify(store.uiState(input.workspaceId))).not.toContain('credential');
    wrapper.unmount();
  });

  it('restores ACP permission choices without retaining authentication input', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    window.diffuse = createMockDesktopBridge();
    const bridge = window.diffuse as ReturnType<typeof createMockDesktopBridge>;
    const snapshot = acpSnapshot();
    const input = inputRequest();
    snapshot.inputs = [
      {
        input,
        sessionId: snapshot.sessions[0].id,
        method: 'session/request_permission',
        params: { options: [{ optionId: 'Allow', name: 'Allow once' }] },
      },
    ];
    bridge.getAcpSnapshot.mockResolvedValue(snapshot);
    const store = useWorkbenchStore();
    store.workspaces = [snapshot.summary];
    store.inputRequests = { [input.id]: input };
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/w/:workspaceId/input/:inputRequestId', component: WorkspaceInputDrawer }],
    });
    await router.push('/w/workspace-a/input/input-1');
    let wrapper = mount(WorkspaceInputDrawer, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await wrapper.get('input[value="Allow"]').setValue(true);
    wrapper.unmount();
    wrapper = mount(WorkspaceInputDrawer, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect((wrapper.get('input[value="Allow"]').element as HTMLInputElement).checked).toBe(true);
    wrapper.unmount();
  });
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
