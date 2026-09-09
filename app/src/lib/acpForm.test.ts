import { describe, expect, it } from 'vitest';
import { acpFormFields, acpFormResponse } from './acpForm';
describe('restricted ACP forms', () => {
  it('supports titled choices, multi-select arrays, and string/numeric bounds', () => {
    const fields = acpFormFields({
      type: 'object',
      properties: {
        strategy: { type: 'string', oneOf: [{ const: 'safe', title: 'Safe strategy' }] },
        files: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 2 },
        count: { type: 'integer', minimum: 1, maximum: 4 },
        name: { type: 'string', minLength: 2, maxLength: 5 },
      },
      required: ['strategy', 'files', 'count', 'name'],
    });
    expect(fields?.[0].options).toEqual([{ value: 'safe', title: 'Safe strategy' }]);
    const values = { strategy: 'safe', files: ['a', 'b'], count: '3', name: 'test' };
    expect(JSON.parse(acpFormResponse(fields, values)).content).toEqual({ ...values, count: 3 });
    for (const invalid of [
      { files: [] },
      { files: ['foreign'] },
      { count: 5 },
      { count: 1.5 },
      { name: 'x' },
      { name: 'too long' },
      { strategy: 'foreign' },
    ])
      expect(acpFormResponse(fields, { ...values, ...invalid })).toBe('');
  });
  it('fails closed for nested schemas and safely handles hostile property names', () => {
    expect(acpFormFields({ type: 'object', properties: { nested: { type: 'object' } } })).toBeUndefined();
    expect(acpFormFields({ type: 'object', properties: { secret: { type: 'string', format: 'password' } } })).toBeUndefined();
    const fields = acpFormFields(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}'));
    const value = JSON.parse('{"__proto__":"literal"}');
    expect(acpFormResponse(fields, value)).toBe('{"action":"accept","content":{"__proto__":"literal"}}');
  });
});
