<template>
  <button type="button" class="button" :class="[`variant-${variant}`, `size-${size}`, { pressed, block }]">
    <slot />
  </button>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'review' | 'ai';
    size?: 'sm' | 'md' | 'lg';
    pressed?: boolean;
    block?: boolean;
  }>(),
  {
    variant: 'primary',
    size: 'md',
    pressed: false,
    block: false,
  },
);
</script>

<style scoped lang="scss">
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  min-width: 0;
  color: var(--color-text-primary);
  background: var(--button-bg);
  border: 1px solid var(--button-border);
  border-radius: var(--radius-3);
  box-shadow: var(--button-shadow, none);
  cursor: pointer;
  font-weight: 650;
  line-height: 1;
  text-decoration: none;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast),
    box-shadow var(--transition-fast);

  &:hover:not(:disabled) {
    background: var(--button-bg-hover);
    border-color: var(--button-border-hover);
    color: var(--button-color-hover, var(--color-text-primary));
  }

  &.pressed {
    background: var(--button-bg-active);
    border-color: var(--button-border-active);
    color: var(--button-color-active, var(--color-text-primary));
  }

  &.block {
    width: 100%;
  }

  &:disabled {
    cursor: default;
    opacity: 0.55;
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.size-sm {
  min-height: 26px;
  padding: 0 var(--space-4);
  font-size: var(--font-size-label);
}

.size-md {
  min-height: 32px;
  padding: 0 var(--space-6);
  font-size: var(--font-size-body);
}

.size-lg {
  min-height: 38px;
  padding: 0 var(--space-7);
  font-size: var(--font-size-body-lg);
}

.variant-primary {
  --button-bg: #2d63d8;
  --button-bg-hover: var(--color-accent-hover);
  --button-bg-active: #244da8;
  --button-border: rgba(255, 255, 255, 0.06);
  --button-border-hover: rgba(255, 255, 255, 0.12);
  --button-border-active: rgba(255, 255, 255, 0.14);
  --button-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.variant-secondary,
.variant-ghost {
  color: var(--color-text-secondary);
}

.variant-secondary {
  --button-bg: var(--color-bg-panel-raised);
  --button-bg-hover: var(--color-bg-hover);
  --button-bg-active: var(--color-bg-active);
  --button-border: var(--color-border-default);
  --button-border-hover: var(--color-border-strong);
  --button-border-active: var(--color-accent);
}

.variant-ghost {
  --button-bg: transparent;
  --button-bg-hover: var(--color-bg-hover);
  --button-bg-active: var(--color-bg-active);
  --button-border: transparent;
  --button-border-hover: transparent;
  --button-border-active: var(--color-border-default);
}

.variant-danger {
  --button-bg: rgba(255, 107, 107, 0.13);
  --button-bg-hover: rgba(255, 107, 107, 0.2);
  --button-bg-active: rgba(255, 107, 107, 0.26);
  --button-border: rgba(255, 107, 107, 0.24);
  --button-border-hover: rgba(255, 107, 107, 0.36);
  --button-border-active: rgba(255, 107, 107, 0.44);
  color: #ffd4d4;
}

.variant-review {
  --button-bg: var(--color-review-muted);
  --button-bg-hover: rgba(240, 195, 106, 0.22);
  --button-bg-active: rgba(240, 195, 106, 0.28);
  --button-border: rgba(240, 195, 106, 0.26);
  --button-border-hover: rgba(240, 195, 106, 0.38);
  --button-border-active: rgba(240, 195, 106, 0.46);
  color: #f7d898;
}

.variant-ai {
  --button-bg: var(--color-ai-muted);
  --button-bg-hover: rgba(143, 179, 255, 0.22);
  --button-bg-active: rgba(143, 179, 255, 0.28);
  --button-border: rgba(143, 179, 255, 0.26);
  --button-border-hover: rgba(143, 179, 255, 0.38);
  --button-border-active: rgba(143, 179, 255, 0.46);
  color: #d6e3ff;
}

@media (prefers-reduced-motion: reduce) {
  .button {
    transition: none;
  }
}
</style>
