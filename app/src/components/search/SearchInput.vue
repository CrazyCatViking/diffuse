<template>
  <label class="search-input" :class="{ compact }">
    <span class="search-icon" aria-hidden="true">⌕</span>

    <input
      ref="inputRef"
      :value="modelValue"
      type="text"
      role="searchbox"
      :placeholder="placeholder"
      :aria-label="label"
      autocomplete="off"
      spellcheck="false"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />

    <button v-if="modelValue" class="clear-button" type="button" aria-label="Clear search" @click="emit('update:modelValue', '')">×</button>
  </label>
</template>

<script setup lang="ts">
import { ref } from 'vue';

withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    label?: string;
    compact?: boolean;
  }>(),
  {
    placeholder: 'Search changed files...',
    label: 'Search',
    compact: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const inputRef = ref<HTMLInputElement | null>(null);

defineExpose({
  focus: () => inputRef.value?.focus(),
  select: () => inputRef.value?.select(),
  blur: () => inputRef.value?.blur(),
});
</script>

<style scoped lang="scss">
.search-input {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: center;
  width: 100%;
  min-height: 38px;
  padding: 0 var(--space-5);
  color: var(--color-text-muted);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  box-shadow: var(--shadow-inset-highlight);
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);

  &:focus-within {
    background: var(--color-bg-panel);
    border-color: var(--color-border-focus);
  }
}

.compact {
  min-height: 32px;
  border-radius: var(--radius-3);
}

.search-icon {
  color: var(--color-text-subtle);
  font-size: 15px;
}

input {
  min-width: 0;
  color: var(--color-text-primary);
  background: transparent;
  border: 0;
  outline: 0;
  font-size: var(--font-size-body);

  &::placeholder {
    color: var(--color-text-subtle);
  }
}

.clear-button {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  color: var(--color-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--radius-2);
  cursor: pointer;

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-hover);
  }

  &:focus-visible {
    outline: 1px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}
</style>
