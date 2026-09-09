// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AgentInputForm from './AgentInputForm.vue';
describe('ACP request-specific form', () => {
  it('renders multi-selects and titled alternatives without flattening their values to text', async () => {
    const wrapper = mount(AgentInputForm, {
      props: {
        disabled: false,
        schema: {
          type: 'object',
          properties: {
            strategy: { type: 'string', oneOf: [{ const: 'safe', title: 'Safe strategy' }] },
            files: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1 },
          },
          required: ['strategy', 'files'],
        },
      },
    });
    expect(wrapper.text()).toContain('Safe strategy');
    await wrapper.get('select:not([multiple])').setValue('safe');
    await wrapper.get('select[multiple]').setValue(['a', 'b']);
    expect(JSON.parse(String(wrapper.emitted('response')?.at(-1)?.[0]))).toEqual({
      action: 'accept',
      content: { strategy: 'safe', files: ['a', 'b'] },
    });
    await wrapper.get('select[multiple]').setValue([]);
    expect(wrapper.emitted('response')?.at(-1)).toEqual(['']);
    wrapper.unmount();
  });
  it('encodes typed values into an action/content response', async () => {
    const wrapper = mount(AgentInputForm, {
      props: {
        disabled: false,
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, count: { type: 'integer' }, approved: { type: 'boolean' } },
          required: ['name', 'count'],
        },
      },
    });
    expect(wrapper.emitted('response')?.at(-1)).toEqual(['']);
    await wrapper.get('input[type="text"]').setValue('Review');
    await wrapper.get('input[type="number"]').setValue('3');
    await wrapper.get('input[type="checkbox"]').setValue(true);
    expect(JSON.parse(String(wrapper.emitted('response')?.at(-1)?.[0]))).toEqual({
      action: 'accept',
      content: { name: 'Review', count: 3, approved: true },
    });
    wrapper.unmount();
  });
  it('fails closed for unsupported and secret schemas and clears values on revision changes', async () => {
    const wrapper = mount(AgentInputForm, {
      props: { disabled: false, schema: { type: 'object', properties: { token: { type: 'string', format: 'password' } } } },
    });
    expect(wrapper.text()).toContain('not supported');
    expect(wrapper.find('input').exists()).toBe(false);
    await wrapper.setProps({
      schema: { type: 'object', properties: { answer: { type: 'string', enum: ['one', 'two'] } }, required: ['answer'] },
    });
    await wrapper.get('select').setValue('two');
    expect(wrapper.emitted('response')?.at(-1)).toEqual(['{"action":"accept","content":{"answer":"two"}}']);
    await wrapper.setProps({ schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } });
    expect(wrapper.emitted('response')?.at(-1)).toEqual(['']);
    wrapper.unmount();
  });
});
