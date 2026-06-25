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
    background: #ff6b6b;
  }
  &.warning {
    background: #f0b86a;
  }
  &.info {
    background: #8fb3ff;
  }
}

.diagnostic-popover {
  position: absolute;
  top: 13px;
  right: -4px;
  display: grid;
  gap: 8px;
  width: min(360px, 72vw);
  max-height: 260px;
  padding: 10px;
  overflow: auto;
  color: #d7deea;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  background: #171b24;
  border: 1px solid #30384a;
  border-radius: 10px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.36);
}

.diagnostic-item {
  display: grid;
  gap: 4px;
  padding-left: 8px;
  border-left: 2px solid #8fb3ff;

  &.error {
    border-left-color: #ff6b6b;
  }
  &.warning {
    border-left-color: #f0b86a;
  }
}

.diagnostic-header {
  display: flex;
  gap: 8px;
  color: #98a2b3;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.diagnostic-message {
  color: #f5f7fb;
  font-size: 12px;
}
</style>
