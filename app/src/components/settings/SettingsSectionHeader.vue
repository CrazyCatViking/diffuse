<template>
  <header class="section-header">
    <div class="section-copy">
      <div>
        <h2 :id="titleId">{{ title }}</h2>

        <p>{{ description }}</p>
      </div>
    </div>

    <div v-if="$slots.actions" class="section-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  titleId: string;
  title: string;
  description: string;
}>();
</script>

<style scoped lang="scss">
.section-header {
  display: flex;
  gap: var(--space-8);
  align-items: flex-start;
  justify-content: space-between;
  min-width: 0;
  margin-bottom: var(--space-8);
}

.section-copy {
  display: flex;
  gap: var(--space-6);
  align-items: flex-start;
  min-width: 0;
}

.section-actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-4);
}

h2,
p {
  margin: 0;
}

h2 {
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-lg);
  line-height: 1.1;
}

p {
  margin-top: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
  line-height: 1.45;
}

@media (max-width: 760px) {
  .section-header,
  .section-copy {
    display: grid;
  }

  .section-actions {
    justify-content: flex-start;
  }
}
</style>
