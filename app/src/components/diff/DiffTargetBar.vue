<template>
  <section class="diff-target-bar">
    <div class="intro">
      <span class="eyebrow">Compare</span>

      <span class="description">{{ description }}</span>
    </div>

    <label class="ref-field source-field">
      <span>Source</span>

      <select v-model="sourceRef" @change="applySelection">
        <option :value="workingTreeValue">Working tree</option>

        <option v-for="option in refOptions" :key="`source-${option.value}`" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </label>

    <span class="against">against</span>

    <label class="ref-field target-field">
      <span>Target</span>

      <select v-model="targetRef" @change="applySelection">
        <option v-for="option in refOptions" :key="`target-${option.value}`" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </label>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { BranchInfo, DiffTarget, DiffTargetDefaults } from '../../lib/protocol';

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
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
  padding: 10px 12px;
  border-bottom: 1px solid #252a35;
  background: #121722;
}

.intro {
  display: grid;
  min-width: 220px;
  margin-right: auto;
}

.ref-field {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.eyebrow,
.ref-field span {
  color: #7e8aa0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.description {
  overflow: hidden;
  color: #cbd5e1;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.against {
  align-self: end;
  padding-bottom: 7px;
  color: #7e8aa0;
  font-size: 12px;
}

select {
  width: 220px;
  height: 32px;
  color: #f5f7fb;
  background: #171c27;
  border: 1px solid #2a3140;
  border-radius: 999px;
  padding: 0 9px;

  &:focus {
    border-color: #4b7bec;
    outline: none;
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
