// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import AgentSessionsView from './AgentSessionsView.vue';
import { useWorkbenchStore } from '../../stores/workbench';
import { useAcpStore } from '../../stores/acp';
import { createMockDesktopBridge } from '../../test/mockDesktopBridge';
import { acpSnapshot, adapter, historyEntry } from '../../test/acpFixture';
import { workspaceRouteNames } from '../../lib/workspaceRoutes';

async function setup() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const bridge = createMockDesktopBridge();
  window.diffuse = bridge;
  const snapshot = acpSnapshot();
  const session = snapshot.sessions[0];
  bridge.discoverAcpAdapters.mockResolvedValue([{ adapter, available: true, platformSupported: true }]);
  bridge.getAcpSnapshot.mockImplementation(async () => structuredClone(snapshot));
  bridge.getAcpHistory.mockImplementation(async ({ after }) => (after ? [] : [historyEntry(session.id)]));
  bridge.getAcpActivity.mockResolvedValue([]);
  bridge.cancelAcpTurn.mockResolvedValue({ cancelled: true });
  bridge.cancelAcpSession.mockResolvedValue(null);
  const workbench = useWorkbenchStore();
  workbench.workspaces = [snapshot.summary];
  workbench.activeWorkspaceId = snapshot.workspaceId;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/w/:workspaceId/agents/:agentSessionId?', name: workspaceRouteNames.agents, component: AgentSessionsView }],
  });
  await router.push(`/w/${snapshot.workspaceId}/agents/${session.id}`);
  const wrapper = mount(AgentSessionsView, { attachTo: document.body, global: { plugins: [pinia, router] } });
  await flushPromises();
  return { wrapper, bridge, workbench, snapshot, session };
}
describe('active workspace agent session', () => {
  it('renders rich content as literal text and safe placeholders, never remote media or HTML', async () => {
    const { wrapper, session } = await setup();
    useAcpStore().history = [
      {
        ...historyEntry(session.id),
        content: {
          messageId: 'rich',
          content: [
            { type: 'text', text: '<script>untrusted</script>' },
            { type: 'image', mimeType: 'image/png', data: 'do-not-render-base64' },
            { type: 'resource_link', name: 'Remote', uri: 'https://example.invalid/secret' },
          ],
        },
      },
    ];
    await flushPromises();
    expect(wrapper.text()).toContain('<script>untrusted</script>');
    expect(wrapper.text()).toContain('not fetched');
    expect(wrapper.find('script, img, audio, iframe').exists()).toBe(false);
    expect(wrapper.find('a[href="https://example.invalid/secret"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('do-not-render-base64');
    wrapper.unmount();
  });
  it('retains an idempotency key after an uncertain queue response', async () => {
    const { wrapper, bridge, workbench, snapshot, session } = await setup();
    bridge.queueAcpPrompt.mockRejectedValueOnce(new Error('Connection interrupted'));
    bridge.queueAcpPrompt.mockImplementationOnce(async (request) => ({
      id: 'turn',
      sessionId: request.sessionId,
      requestId: request.context.requestId,
      text: request.text,
      state: 'queued',
      stopReason: null,
    }));
    await wrapper.get('textarea').setValue('Retry safely');
    await wrapper.findAll('form').at(-1)!.trigger('submit');
    await flushPromises();
    const first = bridge.queueAcpPrompt.mock.calls[0][0];
    expect(workbench.uiState(snapshot.workspaceId).agentPromptRequests?.[session.id]?.requestId).toBe(first.context.requestId);
    await wrapper.findAll('form').at(-1)!.trigger('submit');
    await flushPromises();
    expect(bridge.queueAcpPrompt.mock.calls[1][0].context.requestId).toBe(first.context.requestId);
    expect(workbench.uiState(snapshot.workspaceId).agentPromptRequests?.[session.id]).toBeUndefined();
    wrapper.unmount();
  });

  it('queues scoped prompts and distinguishes queued cancellation from active cancellation', async () => {
    const { wrapper, bridge, snapshot, session } = await setup();
    session.state = 'running';
    snapshot.turnsBySession[session.id] = [
      { id: 'queued', sessionId: session.id, requestId: 'q', text: 'Next', state: 'queued', stopReason: null },
    ];
    bridge.queueAcpPrompt.mockImplementation(async (request) => ({
      id: 'turn',
      sessionId: request.sessionId,
      requestId: request.context.requestId,
      text: request.text,
      state: 'queued',
      stopReason: null,
    }));
    await wrapper.get('textarea').setValue('Please review');
    await wrapper.findAll('form').at(-1)!.trigger('submit');
    await flushPromises();
    expect(bridge.queueAcpPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ workspaceId: snapshot.workspaceId, workspaceGeneration: snapshot.workspaceGeneration }),
        sessionId: session.id,
        text: 'Please review',
      }),
    );
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Cancel queued prompt')!
      .trigger('click');
    await flushPromises();
    expect(bridge.cancelAcpTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id, turnId: 'queued' }));
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Cancel active turn')!
      .trigger('click');
    await flushPromises();
    expect(bridge.cancelAcpSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id }));
    wrapper.unmount();
  });
  it('requires document focus before acknowledging exact session attention', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { wrapper, workbench, bridge, session, snapshot } = await setup();
    const attention = {
      id: 'attention',
      workspaceId: snapshot.workspaceId,
      sourceId: session.id,
      kind: 'completion' as const,
      revision: 3,
      status: 'unread' as const,
      target: { kind: 'agent' as const, agentSessionId: session.id },
      createdAt: 'now',
      updatedAt: 'now',
    };
    workbench.attentionItems = { attention };
    bridge.acknowledgeAttention.mockResolvedValue({
      outcome: 'applied',
      item: { ...attention, status: 'acknowledged' },
      summary: snapshot.summary.attention,
    });
    await wrapper.get('textarea').trigger('focusin');
    await flushPromises();
    expect(bridge.acknowledgeAttention).not.toHaveBeenCalled();
    focus.mockReturnValue(true);
    (wrapper.get('textarea').element as HTMLTextAreaElement).focus();
    await wrapper.get('textarea').trigger('focusin');
    await flushPromises();
    expect(bridge.acknowledgeAttention).toHaveBeenCalledWith(expect.objectContaining({ attentionId: 'attention', revision: 3 }));
    wrapper.unmount();
    focus.mockRestore();
  });
});
