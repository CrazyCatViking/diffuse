import { record } from './acpContract';
export type AcpFormDraft = Record<string, string | number | boolean | string[]>;
export function sanitizeAcpFormDraft(schema: unknown, value: unknown): AcpFormDraft {
  const result: AcpFormDraft = Object.create(null);
  const fields = acpFormFields(schema);
  if (!fields || !record(value)) return result;
  for (const field of fields) {
    if (!Object.hasOwn(value, field.name)) continue;
    const entry = value[field.name];
    if (field.type === 'array' && Array.isArray(entry) && entry.every((v) => typeof v === 'string')) result[field.name] = [...entry];
    else if (field.type === 'boolean' && typeof entry === 'boolean') result[field.name] = entry;
    else if (
      ['string', 'number', 'integer'].includes(field.type) &&
      (typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry)))
    )
      result[field.name] = entry;
  }
  return result;
}
type Scalar = string | number | boolean;
export type AcpFormField = {
  name: string;
  title: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  required: boolean;
  options?: { value: Scalar; title: string }[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
};
export function acpFormFields(schema: unknown): AcpFormField[] | undefined {
  if (!record(schema) || schema.type !== 'object' || !record(schema.properties)) return;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some((name) => typeof name !== 'string' || !Object.hasOwn(schema.properties as object, name)))
    return;
  const fields: AcpFormField[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    if (
      !record(property) ||
      !['string', 'number', 'integer', 'boolean', 'array'].includes(String(property.type)) ||
      property.writeOnly === true
    )
      return;
    const type = property.type as AcpFormField['type'];
    const field: AcpFormField = {
      name,
      title: typeof property.title === 'string' ? property.title : name,
      description: typeof property.description === 'string' ? property.description : undefined,
      type,
      required: required.includes(name),
    };
    if (property.format !== undefined) {
      if (typeof property.format !== 'string' || !['email', 'uri', 'date', 'date-time'].includes(property.format)) return;
      field.format = property.format;
    }
    for (const key of [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ] as const) {
      const value = property[key];
      if (value === undefined) continue;
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (!['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(key) && (!Number.isSafeInteger(value) || value < 0))
      )
        return;
      field[key] = value;
    }
    const optionsSchema = type === 'array' ? property.items : property;
    if (!record(optionsSchema) || (type === 'array' && optionsSchema.type !== undefined && optionsSchema.type !== 'string')) return;
    const choices = optionsSchema.oneOf ?? optionsSchema.anyOf;
    const validScalar = (value: unknown): value is Scalar =>
      type === 'array' || type === 'string'
        ? typeof value === 'string'
        : type === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isSafeInteger(value));
    if (choices !== undefined) {
      if (
        optionsSchema.enum !== undefined ||
        !Array.isArray(choices) ||
        !choices.length ||
        choices.length > 256 ||
        choices.some(
          (choice) =>
            !record(choice) ||
            !validScalar(choice.const) ||
            typeof choice.title !== 'string' ||
            Object.keys(choice).some((key) => !['const', 'title', 'description'].includes(key)),
        )
      )
        return;
      if (optionsSchema.oneOf && new Set(choices.map((choice) => choice.const)).size !== choices.length) return;
      field.options = choices.map((choice) => ({ value: choice.const, title: choice.title }));
    } else if (optionsSchema.enum !== undefined) {
      if (
        !Array.isArray(optionsSchema.enum) ||
        !optionsSchema.enum.length ||
        optionsSchema.enum.length > 256 ||
        !optionsSchema.enum.every(validScalar)
      )
        return;
      const names = optionsSchema.enumNames;
      if (
        names !== undefined &&
        (!Array.isArray(names) || names.length !== optionsSchema.enum.length || !names.every((n) => typeof n === 'string'))
      )
        return;
      field.options = optionsSchema.enum.map((value, index) => ({ value, title: Array.isArray(names) ? names[index] : String(value) }));
    } else if (type === 'array') return;
    // Never silently ignore schema constructs whose validation the UI cannot reproduce.
    if (property.pattern !== undefined || property.allOf !== undefined || property.not !== undefined || property.$ref !== undefined) return;
    fields.push(field);
  }
  return fields;
}
export function acpFormResponse(fields: AcpFormField[] | undefined, values: Record<string, unknown>): string {
  if (!fields) return '';
  const content: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    let value = values[field.name];
    if (field.type === 'boolean' && value === undefined) value = false;
    if (field.type === 'array' && value === undefined && field.required) value = [];
    if (value === undefined || (value === '' && (field.type !== 'string' || field.options))) {
      if (field.required) return '';
      continue;
    }
    if (field.type === 'string') {
      if (typeof value !== 'string' || [...value].length < (field.minLength ?? 0) || [...value].length > (field.maxLength ?? Infinity))
        return '';
      if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return '';
      if (field.format === 'uri') {
        try {
          new URL(value);
        } catch {
          return '';
        }
      }
      if ((field.format === 'date' || field.format === 'date-time') && !Number.isFinite(Date.parse(value))) return '';
    } else if (field.type === 'array') {
      if (Array.isArray(value) && !value.length && !field.required) continue;
      if (
        !Array.isArray(value) ||
        value.length < (field.minItems ?? 0) ||
        value.length > (field.maxItems ?? Infinity) ||
        new Set(value).size !== value.length ||
        value.some((v) => !field.options?.some((option) => option.value === v))
      )
        return '';
    } else if (field.type === 'number' || field.type === 'integer') {
      value = Number(value);
      if (
        !Number.isFinite(value) ||
        (field.type === 'integer' && !Number.isSafeInteger(value)) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
        Number(value) < (field.minimum ?? -Infinity) ||
        Number(value) > (field.maximum ?? Infinity) ||
        Number(value) <= (field.exclusiveMinimum ?? -Infinity) ||
        Number(value) >= (field.exclusiveMaximum ?? Infinity)
      )
        return '';
    } else if (typeof value !== 'boolean') return '';
    if (field.type !== 'array' && field.options && !field.options.some((option) => option.value === value)) return '';
    content[field.name] = value;
  }
  return JSON.stringify({ action: 'accept', content });
}
