// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AgentAdaptersSettings from './AgentAdaptersSettings.vue';
import { createMockDesktopBridge } from '../../test/mockDesktopBridge';
import { adapter } from '../../test/acpFixture';
describe('adapter settings', () => {
  it('edits invocation metadata without storing environment values', async () => {
    const bridge = createMockDesktopBridge();
    window.diffuse = bridge;
    bridge.discoverAcpAdapters.mockResolvedValue([{ adapter, available: true, platformSupported: true }]);
    bridge.saveAcpAdapter.mockResolvedValue(null);
    const wrapper = mount(AgentAdaptersSettings);
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === adapter.id)!
      .trigger('click');
    const areas = wrapper.findAll('textarea');
    await areas[0].setValue('--stdio\n--verbose');
    await areas[1].setValue('PATH\nPROVIDER_TOKEN');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(bridge.saveAcpAdapter).toHaveBeenCalledWith({
      ...adapter,
      args: ['--stdio', '--verbose'],
      environmentKeys: ['PATH', 'PROVIDER_TOKEN'],
    });
    await areas[1].setValue('TOKEN=secret');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(bridge.saveAcpAdapter).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('valid environment keys');
    wrapper.unmount();
  });
});
