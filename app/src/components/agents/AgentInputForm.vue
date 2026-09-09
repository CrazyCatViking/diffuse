<template>
  <fieldset :disabled="disabled">
    <legend>Requested form</legend>

    <p>Do not enter credentials or secrets in agent forms.</p>

    <p v-if="!supported" role="alert">This form schema is not supported. Cancel this request rather than sending an invalid response.</p>

    <label v-for="field in fields" :key="field.name">
      <span>{{ field.title }}{{ field.required ? ' (required)' : '' }}</span>

      <span v-if="field.description">{{ field.description }}</span>

      <span v-if="field.type === 'array'">Choose {{ field.minItems ?? 0 }} to {{ field.maxItems ?? field.options?.length }} values.</span>

      <span v-if="field.minLength !== undefined || field.maxLength !== undefined"
        >Length: {{ field.minLength ?? 0 }} to {{ field.maxLength ?? 'unlimited' }} characters.</span
      >

      <span
        v-if="
          field.minimum !== undefined ||
          field.maximum !== undefined ||
          field.exclusiveMinimum !== undefined ||
          field.exclusiveMaximum !== undefined
        "
        >Range: {{ field.exclusiveMinimum !== undefined ? `greater than ${field.exclusiveMinimum}` : (field.minimum ?? 'unbounded') }} to
        {{ field.exclusiveMaximum !== undefined ? `less than ${field.exclusiveMaximum}` : (field.maximum ?? 'unbounded') }}.</span
      >

      <select
        v-if="field.options"
        v-model="values[field.name]"
        :multiple="field.type === 'array'"
        :required="field.required"
        @change="update"
      >
        <option v-if="field.type !== 'array'" value="">Choose a value</option>

        <option v-for="option in field.options" :key="String(option.value)" :value="option.value">{{ option.title }}</option>
      </select>

      <input v-else-if="field.type === 'boolean'" v-model="values[field.name]" type="checkbox" @change="update" />

      <input
        v-else
        v-model="values[field.name]"
        :type="field.type === 'string' ? 'text' : 'number'"
        :step="field.type === 'integer' ? 1 : 'any'"
        :required="field.required"
        :min="field.minimum"
        :max="field.maximum"
        :minlength="field.minLength"
        :maxlength="field.maxLength"
        autocomplete="off"
        @input="update"
      />
    </label>
  </fieldset>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { acpFormFields, acpFormResponse, sanitizeAcpFormDraft, type AcpFormDraft } from '../../lib/acpForm';
const props = defineProps<{ schema: unknown; disabled: boolean; initialValues?: AcpFormDraft }>();
const emit = defineEmits<{ response: [value: string]; draft: [value: AcpFormDraft] }>();
const values = ref<Record<string, unknown>>({});
const fields = computed(() => acpFormFields(props.schema));
const supported = computed(() => fields.value !== undefined);
function update() {
  emit('response', acpFormResponse(fields.value, values.value));
  emit('draft', sanitizeAcpFormDraft(props.schema, values.value));
}
watch(
  () => JSON.stringify(props.schema),
  () => {
    values.value = sanitizeAcpFormDraft(props.schema, props.initialValues);
    for (const field of fields.value ?? [])
      if (field.type === 'array' && values.value[field.name] === undefined) values.value[field.name] = [];
    emit('response', acpFormResponse(fields.value, values.value));
  },
  { immediate: true },
);
</script>

<style scoped lang="scss">
fieldset,
label {
  display: grid;
  gap: var(--space-4);
  border: 0;
  padding: 0;
}
input,
select {
  padding: var(--space-4);
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
}
:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}
</style>
