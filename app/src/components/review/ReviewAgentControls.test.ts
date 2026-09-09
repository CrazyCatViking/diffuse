// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import ReviewAgentControls from './ReviewAgentControls.vue';
import InlineReviewBox from '../diff/InlineReviewBox.vue';
import { useReviewStore } from '../../stores/review';
import { useRepoStore } from '../../stores/repo';
import { useWorkbenchStore } from '../../stores/workbench';
import { useAcpStore } from '../../stores/acp';
import { acpSnapshot, adapter } from '../../test/acpFixture';
import { createMockDesktopBridge } from '../../test/mockDesktopBridge';
import { setActiveWorkspace } from '../../lib/useClient';

async function setup() {
  const pinia = createPinia();
  setActivePinia(pinia);
  window.localStorage.clear();
  const bridge = createMockDesktopBridge();
  window.diffuse = bridge;
  const snapshot = acpSnapshot();
  snapshot.sessions[0].reviewSessionId = 'review';
  bridge.getAcpSnapshot.mockResolvedValue(snapshot);
  bridge.getAcpHistory.mockResolvedValue([]);
  bridge.getAcpActivity.mockResolvedValue([]);
  bridge.discoverAcpAdapters.mockResolvedValue([{ adapter, available: true, platformSupported: true }]);
  const workbench = useWorkbenchStore();
  workbench.workspaces = [snapshot.summary];
  workbench.activeWorkspaceId = snapshot.workspaceId;
  setActiveWorkspace(snapshot.summary);
  const review = useReviewStore();
  review.session = {
    id: 'review',
    repositoryRoot: '/repo',
    headAtCreation: 'head',
    title: 'Review',
    target: { base: 'HEAD', includeStaged: true, includeUnstaged: true },
    status: 'active',
    participants: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
  useRepoStore().changedFiles = [{ id: 'file', status: 'modified', signature: 's', additions: 1, deletions: 1 }];
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ name: 'workspace-agents', path: '/w/:workspaceId/agents/:agentSessionId', component: { template: '<div />' } }],
  });
  await router.push('/w/workspace-a/agents/session');
  await flushPromises();
  return { pinia, router, review, snapshot, bridge };
}
describe('review agent controls and inline chat', () => {
  it('keeps legacy runs as read-only history without offering legacy execution', async () => {
    const { pinia, router, review } = await setup();
    review.runs = [
      { id: 'archive', sessionId: 'review', provider: 'opencode', status: 'running', startedAt: '2026-01-01', updatedAt: '2026-01-01' },
    ];
    const wrapper = mount(ReviewAgentControls, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Legacy review history (read-only)');
    expect(wrapper.text()).toContain('opencode');
    expect(wrapper.find('option[value="legacy"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('overrides are retained');
    expect(wrapper.findAll('button').some((button) => button.text().includes('legacy'))).toBe(false);
    wrapper.unmount();
    setActiveWorkspace(undefined);
  });
  it('does not select an arbitrary adapter and offers exact-session stop/history controls', async () => {
    const { pinia, router, review, snapshot } = await setup();
    snapshot.sessions[0].state = 'running';
    useAcpStore().snapshots[snapshot.workspaceId] = snapshot;
    const start = vi.spyOn(review, 'startAgentReview').mockResolvedValue(true);
    const stop = vi.spyOn(review, 'stopAgentReview').mockResolvedValue(undefined);
    const wrapper = mount(ReviewAgentControls, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(review.agentAdapter).toBe('');
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text() === 'Start ACP review')!
        .attributes('disabled'),
    ).toBeDefined();
    await wrapper.get('select').setValue('acp:fixture');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Start ACP review')!
      .trigger('click');
    expect(start).toHaveBeenCalledOnce();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Stop session and queued work')!
      .trigger('click');
    expect(stop).toHaveBeenCalledWith(snapshot.sessions[0].id);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Open history / reconnect')!
      .trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.params.agentSessionId).toBe(snapshot.sessions[0].id);
    wrapper.unmount();
    setActiveWorkspace(undefined);
  });
  it('supports selection-chat followups and retains the draft on failure', async () => {
    const { pinia, router, review } = await setup();
    review.agentAdapter = 'acp:fixture';
    const anchor = { side: 'new' as const, startLine: 3, endLine: 4, diffTargetFingerprint: 'target' };
    const ask = vi.spyOn(review, 'askAgentInThread').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const wrapper = mount(InlineReviewBox, {
      props: {
        entry: { kind: 'chat', key: 'chat:file:new:3:4::', chatThreadId: 'chat:file:new:3:4::', anchor },
        draftBody: '',
        chatMessages: [
          {
            id: 'user',
            sessionId: 'review',
            role: 'user',
            body: 'Earlier question',
            createdAt: 'now',
            context: { fileId: 'file', selection: anchor, threadIds: ['chat:file:new:3:4::'] },
          },
        ],
      },
      global: { plugins: [pinia, router] },
    });
    await wrapper.get('textarea').setValue('Follow up');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Ask agent')!
      .trigger('click');
    await flushPromises();
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'review', fileId: 'file', anchor }), 'Follow up');
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Follow up');
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    wrapper.unmount();
    setActiveWorkspace(undefined);
  });
});
