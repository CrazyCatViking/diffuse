<template>
  <div class="code-hunk-row" :class="mode">
    <div class="hunk-text">
      <span class="hunk-label">Hunk</span>

      <span>{{ text }}</span>
    </div>
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
  display: grid;
  align-items: center;
  height: 28px;
  color: var(--color-ai);
  background: linear-gradient(90deg, var(--color-diff-hunk-bg), var(--color-bg-code) 280px);
  border-top: 1px solid var(--color-border-default);
  border-bottom: 1px solid var(--color-border-default);
  box-shadow: var(--shadow-inset-highlight);
  font-family: var(--font-mono);
  font-size: var(--font-size-label);
  line-height: 1;
}

.hunk-text {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
  padding: 0 var(--space-7);
  font-weight: 600;
}

.hunk-label {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-3);
  color: var(--color-text-primary);
  background: var(--color-ai-muted);
  border: 1px solid rgba(143, 179, 255, 0.24);
  border-radius: var(--radius-pill);
  font-family: var(--font-ui);
  font-size: var(--font-size-caption);
  text-transform: uppercase;
}
</style>
