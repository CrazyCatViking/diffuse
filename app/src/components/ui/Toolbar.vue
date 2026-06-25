<template>
  <section class="toolbar" :class="[`density-${density}`, { borderless }]">
    <slot />
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    density?: 'compact' | 'normal';
    borderless?: boolean;
  }>(),
  {
    density: 'normal',
    borderless: false,
  },
);
</script>

<style scoped lang="scss">
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-7);
  min-width: 0;
  color: var(--color-text-muted);
  background: var(--color-bg-shell);
  border-bottom: 1px solid var(--color-border-subtle);
}

.density-compact {
  min-height: 42px;
  padding: var(--space-4) var(--space-6);
}

.density-normal {
  min-height: 54px;
  padding: var(--space-6) var(--space-7);
}

.borderless {
  border-bottom: 0;
}
</style>
