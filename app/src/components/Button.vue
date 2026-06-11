<template>
  <button class="button">
    <slot />
  </button>
</template>

<style scoped lang="scss">
.button {
  color: #f5f7fb;
  background: #2d63d8;
  border: 0;
  border-radius: 8px;
  padding: 7px 12px;
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
}
</style>
