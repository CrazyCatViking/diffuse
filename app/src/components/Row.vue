<template>
  <div class="row">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  }>(),
  {
    justify: 'start',
  },
);

const justifyContent = computed(() => {
  return (
    {
      start: 'flex-start',
      center: 'center',
      end: 'flex-end',
      between: 'space-between',
      around: 'space-around',
    } satisfies Record<NonNullable<typeof props.justify>, string>
  )[props.justify];
});
</script>

<style scoped lang="scss">
.row {
  display: flex;
  justify-content: v-bind('justifyContent');
  align-items: center;
  gap: 1rem;
  flex-grow: 1;
}
</style>
