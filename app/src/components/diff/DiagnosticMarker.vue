<template>
  <span
    v-if="severity"
    class="diagnostic-marker"
    :class="severity"
    tabindex="0"
    role="button"
    :aria-label="label"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @focus="open = true"
    @blur="open = false"
    @click.stop="open = !open"
  >
    <span v-if="open" class="diagnostic-popover" role="tooltip">
      <span v-for="diagnostic in diagnostics" :key="diagnosticKey(diagnostic)" class="diagnostic-item" :class="diagnostic.severity">
        <span class="diagnostic-header">
          <span>{{ diagnostic.severity }}</span>

          <span v-if="diagnostic.source || diagnostic.code">{{ diagnosticSource(diagnostic) }}</span>
        </span>

        <span class="diagnostic-message">{{ diagnostic.message }}</span>
      </span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { LspDiagnostic } from '../../lib/protocol';

const props = defineProps<{
  diagnostics?: LspDiagnostic[];
}>();

const open = ref(false);

const diagnostics = computed(() => props.diagnostics ?? []);
const severity = computed(() => diagnosticSeverity(diagnostics.value));
const label = computed(() => diagnostics.value.map((diagnostic) => diagnostic.message).join('\n'));

const diagnosticSeverity = (items: LspDiagnostic[]) => {
  if (!items.length) return undefined;
  if (items.some((diagnostic) => diagnostic.severity === 'error')) return 'error';
  if (items.some((diagnostic) => diagnostic.severity === 'warning')) return 'warning';
  return 'info';
};

const diagnosticSource = (diagnostic: LspDiagnostic) => {
  return [diagnostic.source, diagnostic.code].filter(Boolean).join(' ');
};

const diagnosticKey = (diagnostic: LspDiagnostic) => {
  return `${diagnostic.line}:${diagnostic.startColumn}:${diagnostic.endColumn}:${diagnostic.severity}:${diagnostic.message}`;
};
</script>

<style scoped lang="scss">
.diagnostic-marker {
  position: absolute;
  top: 8px;
  right: 6px;
  z-index: 5;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  cursor: help;
  outline: none;

  &.error {
    background: var(--color-danger);
  }

  &.warning {
    background: var(--color-warning);
  }

  &.info {
    background: var(--color-ai);
  }
}

.diagnostic-popover {
  position: absolute;
  top: 13px;
  right: -4px;
  display: grid;
  gap: var(--space-4);
  width: min(360px, 72vw);
  max-height: 260px;
  padding: var(--space-5);
  overflow: auto;
  color: var(--color-text-secondary);
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  box-shadow: var(--shadow-popover);
}

.diagnostic-item {
  display: grid;
  gap: var(--space-2);
  padding-left: var(--space-4);
  border-left: 2px solid var(--color-ai);

  &.error {
    border-left-color: var(--color-danger);
  }

  &.warning {
    border-left-color: var(--color-warning);
  }
}

.diagnostic-header {
  display: flex;
  gap: var(--space-4);
  color: var(--color-text-muted);
  font-size: var(--font-size-caption);
  font-weight: 700;
  text-transform: uppercase;
}

.diagnostic-message {
  color: var(--color-text-primary);
  font-size: var(--font-size-label);
}
</style>
