<template>
  <section class="empty-state" :class="[`align-${align}`, { bordered }]">
    <div v-if="$slots.visual" class="visual" aria-hidden="true">
      <slot name="visual" />
    </div>

    <div class="copy">
      <h1 v-if="title">{{ title }}</h1>

      <p v-if="description">{{ description }}</p>
    </div>

    <div v-if="$slots.actions" class="actions">
      <slot name="actions" />
    </div>
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    align?: 'center' | 'start';
    bordered?: boolean;
  }>(),
  {
    align: 'center',
    bordered: false,
  },
);
</script>

<style scoped lang="scss">
.empty-state {
  display: grid;
  gap: var(--space-7);
  place-items: center;
  padding: var(--space-10);
  color: var(--color-text-muted);
}

.bordered {
  border: 1px dashed var(--color-border-default);
  border-radius: var(--radius-6);
  background: rgba(21, 27, 38, 0.54);
}

.align-start {
  justify-items: start;
  text-align: left;
}

.align-center {
  justify-items: center;
  text-align: center;
}

.visual {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  color: var(--color-accent);
  background: var(--color-accent-muted);
  border: 1px solid rgba(75, 123, 236, 0.18);
  border-radius: 18px;
}

.copy {
  display: grid;
  gap: var(--space-4);
  max-width: 560px;
}

h1,
p {
  margin: 0;
}

h1 {
  color: var(--color-text-primary);
  font-size: 22px;
  line-height: 1.2;
}

p {
  color: var(--color-text-muted);
  font-size: var(--font-size-body-lg);
  line-height: 1.55;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-4);
}

.align-start .actions {
  justify-content: flex-start;
}
</style>
