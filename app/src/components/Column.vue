<template>
  <div class="column">
    <slot />
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
}>();
</script>

<style scoped lang="scss">
.column {
  display: flex;
  flex-direction: column;
  justify-content: v-bind('justify');
  align-items: center;
  gap: 1rem;
  padding: 1rem;
}
</style>
