<template>
  <div class="code-hunk-row" :class="mode">
    <div class="hunk-text">{{ text }}</div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  text: string;
  mode?: string;
}>();
</script>

<style scoped lang="scss">
.code-hunk-row {
  display: block;
  height: 28px;
  color: #8fb3ff;
  background: #101827;
  border-top: 1px solid #26334a;
  border-bottom: 1px solid #26334a;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 28px;
}

.hunk-text {
  padding: 0 14px;
  font-weight: 600;
}
</style>
