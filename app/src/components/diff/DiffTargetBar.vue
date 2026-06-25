<template>
  <Toolbar class="diff-target-bar" density="compact">
    <div class="intro">
      <Badge tone="accent">Compare</Badge>

      <span class="description">{{ description }}</span>
    </div>

    <label class="ref-field source-field">
      <span>Source</span>

      <select v-model="sourceRef" :disabled="loading" @change="applySelection">
        <option :value="workingTreeValue">Working tree</option>

        <option v-for="option in refOptions" :key="`source-${option.value}`" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </label>

    <span class="against">against</span>

    <label class="ref-field target-field">
      <span>Target</span>

      <select v-model="targetRef" :disabled="loading" @change="applySelection">
        <option v-for="option in refOptions" :key="`target-${option.value}`" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </label>

    <Button variant="ghost" size="sm" :disabled="loading" @click="emit('reset')">Reset</Button>
  </Toolbar>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { BranchInfo, DiffTarget, DiffTargetDefaults } from '../../lib/protocol';
import Button from '../Button.vue';
import Badge from '../ui/Badge.vue';
import Toolbar from '../ui/Toolbar.vue';

const props = defineProps<{
  target: DiffTarget;
  defaults?: DiffTargetDefaults;
  branches: BranchInfo[];
  loading: boolean;
}>();

const emit = defineEmits<{
  apply: [target: DiffTarget];
  reset: [];
}>();

const workingTreeValue = 'Working tree';
const sourceRef = ref(workingTreeValue);
const targetRef = ref('HEAD');

const refOptions = computed(() => [
  { value: 'HEAD', label: 'HEAD' },
  ...props.branches.map((branch) => ({
    value: branch.name,
    label: branch.current ? `${branch.name} (current)` : branch.name,
  })),
]);

const description = computed(() => {
  if (sourceRef.value === workingTreeValue) return `Working tree changes against ${targetRef.value || 'HEAD'}`;
  return `${sourceRef.value || 'HEAD'} against ${targetRef.value || 'HEAD'}`;
});

watch(
  () => props.target,
  (target) => {
    sourceRef.value = target.compare ?? workingTreeValue;
    targetRef.value = target.base ?? props.defaults?.base ?? 'HEAD';
  },
  { immediate: true },
);

const applySelection = () => {
  const source = sourceRef.value.trim() || workingTreeValue;
  const target = targetRef.value.trim() || 'HEAD';

  emit('apply', {
    base: target,
    compare: source === workingTreeValue ? undefined : source,
    includeStaged: source === workingTreeValue,
    includeUnstaged: source === workingTreeValue,
  });
};
</script>

<style scoped lang="scss">
.diff-target-bar {
  min-width: 0;
}

.intro {
  display: grid;
  gap: var(--space-3);
  min-width: 240px;
  margin-right: auto;
}

.ref-field {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.ref-field span {
  color: var(--color-text-subtle);
  font-size: var(--font-size-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.description {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--font-size-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.against {
  align-self: end;
  padding-bottom: 7px;
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
}

select {
  width: 220px;
  height: 32px;
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-pill);
  padding: 0 9px;

  &:focus {
    border-color: var(--color-border-focus);
    outline: none;
  }

  &:disabled {
    opacity: 0.6;
  }
}

@media (max-width: 980px) {
  .diff-target-bar {
    flex-wrap: wrap;
  }

  .intro {
    width: 100%;
  }
}
</style>
