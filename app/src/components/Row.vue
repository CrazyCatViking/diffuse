<template>
  <div class="row">
    <slot />
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
}>();
</script>

<style scoped lang="scss">
.row {
  display: flex;
  justify-content: v-bind('justify');
  align-items: center;
  gap: 1rem;
  flex-grow: 1;
}
</style>
