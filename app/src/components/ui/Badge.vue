<template>
  <span class="badge" :class="[`tone-${tone}`, `size-${size}`]">
    <slot />
  </span>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'review' | 'ai';
    size?: 'sm' | 'md';
  }>(),
  {
    tone: 'neutral',
    size: 'sm',
  },
);
</script>

<style scoped lang="scss">
.badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-width: 0;
  border: 1px solid var(--badge-border);
  border-radius: var(--radius-pill);
  color: var(--badge-color);
  background: var(--badge-bg);
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  text-transform: uppercase;
  white-space: nowrap;
}

.size-sm {
  min-height: 20px;
  padding: 0 var(--space-3);
  font-size: 10px;
}

.size-md {
  min-height: 24px;
  padding: 0 var(--space-4);
  font-size: var(--font-size-caption);
}

.tone-neutral {
  --badge-color: var(--color-text-muted);
  --badge-bg: rgba(143, 151, 166, 0.1);
  --badge-border: rgba(143, 151, 166, 0.18);
}

.tone-accent {
  --badge-color: #dbe7ff;
  --badge-bg: var(--color-accent-muted);
  --badge-border: rgba(75, 123, 236, 0.26);
}

.tone-success {
  --badge-color: var(--color-success);
  --badge-bg: var(--color-success-muted);
  --badge-border: rgba(91, 184, 119, 0.25);
}

.tone-warning {
  --badge-color: var(--color-warning);
  --badge-bg: var(--color-warning-muted);
  --badge-border: rgba(240, 184, 106, 0.25);
}

.tone-danger {
  --badge-color: var(--color-danger);
  --badge-bg: var(--color-danger-muted);
  --badge-border: rgba(255, 107, 107, 0.25);
}

.tone-info {
  --badge-color: var(--color-info);
  --badge-bg: var(--color-info-muted);
  --badge-border: rgba(77, 166, 255, 0.25);
}

.tone-review {
  --badge-color: var(--color-review);
  --badge-bg: var(--color-review-muted);
  --badge-border: rgba(240, 195, 106, 0.25);
}

.tone-ai {
  --badge-color: var(--color-ai);
  --badge-bg: var(--color-ai-muted);
  --badge-border: rgba(143, 179, 255, 0.25);
}
</style>
