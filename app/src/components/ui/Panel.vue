<template>
  <section class="panel" :class="[`padding-${padding}`, { elevated }]">
    <slot />
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    padding?: 'none' | 'sm' | 'md' | 'lg';
    elevated?: boolean;
  }>(),
  {
    padding: 'md',
    elevated: false,
  },
);
</script>

<style scoped lang="scss">
.panel {
  min-width: 0;
  color: var(--color-text-secondary);
  background: var(--color-bg-panel);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-6);
  box-shadow: var(--shadow-inset-highlight);
}

.elevated {
  background: var(--color-bg-panel-raised);
  border-color: var(--color-border-default);
  box-shadow: var(--shadow-popover);
}

.padding-none {
  padding: 0;
}

.padding-sm {
  padding: var(--space-5);
}

.padding-md {
  padding: var(--space-7);
}

.padding-lg {
  padding: var(--space-9);
}
</style>
