<template>
  <div ref="rootRef" class="diff-target-menu">
    <button
      ref="triggerRef"
      class="compare-trigger"
      type="button"
      :disabled="loading"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="toggleMenu"
      @keydown.down.prevent="openMenu"
    >
      <span class="trigger-kicker">Compare</span>

      <span class="trigger-summary" :title="activeSummary">{{ activeSummary }}</span>

      <span class="trigger-caret" aria-hidden="true" />
    </button>

    <div v-if="open" class="compare-popover" role="dialog" aria-label="Choose diff target" @keydown.esc.prevent="closeMenu(true)">
      <header class="popover-header">
        <div>
          <h2>Choose diff target</h2>

          <p>{{ draftSummary }}</p>
        </div>

        <Button variant="ghost" size="sm" @click="closeMenu(true)">Close</Button>
      </header>

      <div class="selector-grid">
        <section class="ref-column" aria-labelledby="source-ref-title">
          <div class="column-header">
            <span id="source-ref-title" class="field-label">Source</span>

            <span class="field-value" :title="draftSource">{{ draftSource }}</span>
          </div>

          <label class="search-field">
            <span class="visually-hidden">Search source refs</span>

            <input
              ref="sourceSearchRef"
              v-model="sourceQuery"
              type="search"
              placeholder="Search source..."
              autocomplete="off"
              spellcheck="false"
            />
          </label>

          <div class="option-list" role="listbox" aria-label="Source refs">
            <button
              v-for="option in sourceDisplayOptions"
              :key="`source-${option.custom ? 'custom' : 'ref'}-${option.value}`"
              class="ref-option"
              :class="{ selected: draftSource === option.value, custom: option.custom }"
              type="button"
              role="option"
              :aria-selected="draftSource === option.value"
              @click="selectSource(option.value)"
            >
              <span class="option-main">
                <span class="option-label">{{ option.label }}</span>

                <span v-if="option.badge" class="option-badge">{{ option.badge }}</span>
              </span>

              <span v-if="option.detail" class="option-detail">{{ option.detail }}</span>
            </button>
          </div>
        </section>

        <section class="ref-column" aria-labelledby="target-ref-title">
          <div class="column-header">
            <span id="target-ref-title" class="field-label">Target</span>

            <span class="field-value" :title="draftTarget">{{ draftTarget }}</span>
          </div>

          <label class="search-field">
            <span class="visually-hidden">Search target refs</span>

            <input v-model="targetQuery" type="search" placeholder="Search target..." autocomplete="off" spellcheck="false" />
          </label>

          <div class="option-list" role="listbox" aria-label="Target refs">
            <button
              v-for="option in targetDisplayOptions"
              :key="`target-${option.custom ? 'custom' : 'ref'}-${option.value}`"
              class="ref-option"
              :class="{ selected: draftTarget === option.value, custom: option.custom }"
              type="button"
              role="option"
              :aria-selected="draftTarget === option.value"
              @click="selectTarget(option.value)"
            >
              <span class="option-main">
                <span class="option-label">{{ option.label }}</span>

                <span v-if="option.badge" class="option-badge">{{ option.badge }}</span>
              </span>

              <span v-if="option.detail" class="option-detail">{{ option.detail }}</span>
            </button>
          </div>
        </section>
      </div>

      <div v-if="isWorkingTreeDraft" class="scope-row" role="group" aria-label="Working tree change scope">
        <Button
          v-for="option in workingTreeScopeOptions"
          :key="option.value"
          variant="secondary"
          size="sm"
          :pressed="draftScope === option.value"
          :aria-pressed="draftScope === option.value"
          :title="option.detail"
          @click="draftScope = option.value"
        >
          {{ option.label }}
        </Button>
      </div>

      <footer class="popover-footer">
        <div class="secondary-actions">
          <Button variant="ghost" size="sm" :disabled="isWorkingTreeDraft" @click="swapDraftRefs">Swap</Button>

          <Button variant="ghost" size="sm" :disabled="loading" @click="resetTarget">Reset</Button>
        </div>

        <div class="primary-actions">
          <Button variant="ghost" size="sm" @click="closeMenu(true)">Cancel</Button>

          <Button variant="primary" size="sm" :disabled="loading" @click="applyDraft">Apply</Button>
        </div>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { BranchInfo, DiffTarget, DiffTargetDefaults } from '../../lib/protocol';
import Button from '../Button.vue';

type RefOption = {
  value: string;
  label: string;
  detail?: string;
  badge?: string;
  custom?: boolean;
};

type WorkingTreeScope = 'all' | 'staged' | 'unstaged';

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
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const sourceSearchRef = ref<HTMLInputElement | null>(null);
const open = ref(false);
const draftSource = ref(workingTreeValue);
const draftTarget = ref('HEAD');
const draftScope = ref<WorkingTreeScope>('all');
const sourceQuery = ref('');
const targetQuery = ref('');

const workingTreeScopeOptions: { value: WorkingTreeScope; label: string; detail: string }[] = [
  { value: 'all', label: 'All changes', detail: 'Compare staged and unstaged changes together' },
  { value: 'staged', label: 'Staged', detail: 'Compare only staged changes in the index' },
  { value: 'unstaged', label: 'Unstaged', detail: 'Compare only unstaged working tree changes' },
];

const baseFallback = computed(() => props.defaults?.base ?? 'HEAD');
const isWorkingTreeDraft = computed(() => draftSource.value === workingTreeValue);
const activeSummary = computed(() =>
  targetSummary(sourceFromTarget(props.target), targetBase(props.target), scopeFromTarget(props.target)),
);
const draftSummary = computed(() => targetSummary(draftSource.value, draftTarget.value, draftScope.value));
const sourceOptions = computed<RefOption[]>(() => [
  {
    value: workingTreeValue,
    label: workingTreeValue,
    detail: scopeDescription(draftScope.value),
    badge: 'Local',
  },
  ...commonRefOptions.value,
]);
const targetOptions = computed<RefOption[]>(() => commonRefOptions.value);
const sourceDisplayOptions = computed(() => displayOptions(sourceOptions.value, sourceQuery.value));
const targetDisplayOptions = computed(() => displayOptions(targetOptions.value, targetQuery.value));
const commonRefOptions = computed<RefOption[]>(() => {
  const options: RefOption[] = [];
  const seen = new Set<string>();

  const addOption = (option: RefOption) => {
    const value = option.value.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    options.push({ ...option, value, label: option.label || value });
  };

  addOption({ value: 'HEAD', label: 'HEAD', detail: 'Current repository HEAD', badge: 'Pinned' });

  if (props.defaults?.base && props.defaults.base !== 'HEAD') {
    addOption({
      value: props.defaults.base,
      label: props.defaults.base,
      detail: props.defaults.base === props.defaults.upstream ? 'Default upstream target' : 'Default target',
      badge: 'Default',
    });
  }

  if (props.defaults?.upstream && props.defaults.upstream !== props.defaults.base) {
    addOption({ value: props.defaults.upstream, label: props.defaults.upstream, detail: 'Configured upstream', badge: 'Upstream' });
  }

  for (const branch of props.branches) {
    addOption({
      value: branch.name,
      label: branch.name,
      detail: branch.current ? 'Checked-out branch' : branchDetail(branch),
      badge: branch.current ? 'Current' : undefined,
    });
  }

  return options;
});

const toggleMenu = () => {
  if (props.loading) return;
  if (open.value) closeMenu();
  else openMenu();
};

const openMenu = async () => {
  if (props.loading || open.value) return;
  resetDraftFromTarget();
  sourceQuery.value = '';
  targetQuery.value = '';
  open.value = true;
  await nextTick();
  sourceSearchRef.value?.focus();
};

const closeMenu = (restoreFocus = false) => {
  open.value = false;
  sourceQuery.value = '';
  targetQuery.value = '';
  if (restoreFocus) triggerRef.value?.focus();
};

const selectSource = (value: string) => {
  draftSource.value = normalizeRef(value, workingTreeValue);
  sourceQuery.value = '';
};

const selectTarget = (value: string) => {
  draftTarget.value = normalizeRef(value, baseFallback.value);
  targetQuery.value = '';
};

const swapDraftRefs = () => {
  if (isWorkingTreeDraft.value) return;

  const source = draftSource.value;
  draftSource.value = draftTarget.value;
  draftTarget.value = source;
};

const applyDraft = () => {
  const source = normalizeRef(draftSource.value, workingTreeValue);
  const target = normalizeRef(draftTarget.value, baseFallback.value);

  if (source === workingTreeValue) {
    emit('apply', {
      base: target,
      compare: undefined,
      includeStaged: draftScope.value === 'all' || draftScope.value === 'staged',
      includeUnstaged: draftScope.value === 'all' || draftScope.value === 'unstaged',
    });
    closeMenu(true);
    return;
  }

  emit('apply', {
    base: target,
    compare: source,
    includeStaged: false,
    includeUnstaged: false,
  });
  closeMenu(true);
};

const resetTarget = () => {
  emit('reset');
  closeMenu(true);
};

const resetDraftFromTarget = () => {
  draftSource.value = sourceFromTarget(props.target);
  draftTarget.value = targetBase(props.target);
  draftScope.value = scopeFromTarget(props.target);
};

const sourceFromTarget = (target: DiffTarget) => target.compare?.trim() || workingTreeValue;

const targetBase = (target: DiffTarget) => target.base?.trim() || baseFallback.value;

const normalizeRef = (value: string, fallback: string) => value.trim() || fallback;

const scopeFromTarget = (target: DiffTarget): WorkingTreeScope => {
  if (target.compare) return 'all';
  if (target.includeStaged && target.includeUnstaged) return 'all';
  if (target.includeStaged) return 'staged';
  if (target.includeUnstaged) return 'unstaged';
  return 'all';
};

const targetSummary = (source: string, target: string, scope: WorkingTreeScope) => {
  if (source === workingTreeValue) return `${scopeShortLabel(scope)} -> ${target || 'HEAD'}`;
  return `${source || 'HEAD'} -> ${target || 'HEAD'}`;
};

const scopeShortLabel = (scope: WorkingTreeScope) => {
  if (scope === 'staged') return 'Staged';
  if (scope === 'unstaged') return 'Unstaged';
  return 'Working tree';
};

const scopeDescription = (scope: WorkingTreeScope) => {
  if (scope === 'staged') return 'Only staged changes';
  if (scope === 'unstaged') return 'Only unstaged changes';
  return 'Staged and unstaged changes';
};

const displayOptions = (options: RefOption[], query: string) => {
  const value = query.trim();
  const needle = normalizeText(value);
  const ranked = needle
    ? options
        .map((option) => ({ option, score: optionScore(option, needle) }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((left, right) => left.score - right.score || left.option.label.localeCompare(right.option.label))
        .map((entry) => entry.option)
    : options;

  if (!value || options.some((option) => normalizeText(option.value) === needle)) return ranked;

  return [
    ...ranked,
    {
      value,
      label: `Use ${value}`,
      detail: 'Custom Git ref, tag, or commit',
      badge: 'Custom',
      custom: true,
    },
  ];
};

const normalizeText = (value: string) => value.toLowerCase();

const optionScore = (option: RefOption, needle: string) => {
  const value = normalizeText(option.value);
  const label = normalizeText(option.label);
  const detail = normalizeText(option.detail ?? '');
  const shortName = normalizeText(option.value.split('/').at(-1) ?? option.value);

  if (value === needle || label === needle) return 0;
  if (shortName === needle) return 1;
  if (value.startsWith(needle) || label.startsWith(needle)) return 2;
  if (shortName.startsWith(needle)) return 3;
  if (value.includes(needle) || label.includes(needle)) return 4;
  if (detail.includes(needle)) return 5;
  if (fuzzyIncludes(value, needle) || fuzzyIncludes(label, needle)) return 6;
  return Number.POSITIVE_INFINITY;
};

const fuzzyIncludes = (value: string, needle: string) => {
  let index = 0;

  for (const character of value) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }

  return false;
};

const branchDetail = (branch: BranchInfo) => {
  if (branch.name.includes('/')) return 'Branch or remote ref';
  return 'Local branch';
};

const onWindowPointerDown = (event: PointerEvent) => {
  const target = event.target instanceof Node ? event.target : null;
  if (target && rootRef.value?.contains(target)) return;
  closeMenu();
};

watch(open, (isOpen) => {
  if (isOpen) window.addEventListener('pointerdown', onWindowPointerDown);
  else window.removeEventListener('pointerdown', onWindowPointerDown);
});

watch(
  [() => props.target, () => props.defaults?.base],
  () => {
    if (!open.value) resetDraftFromTarget();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown);
});
</script>

<style scoped lang="scss">
.diff-target-menu {
  position: relative;
  min-width: 0;
}

.compare-trigger {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--space-3);
  align-items: center;
  max-width: 330px;
  min-height: 28px;
  padding: 0 var(--space-4);
  color: var(--color-text-secondary);
  cursor: pointer;
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-inset-highlight);
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);

  &:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-bg-hover);
    border-color: var(--color-border-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }

  &:disabled {
    cursor: default;
    opacity: 0.6;
  }
}

.trigger-kicker {
  color: var(--color-accent);
  font-size: var(--font-size-label);
  font-weight: 800;
}

.trigger-summary {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: var(--font-size-label);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trigger-caret {
  width: 6px;
  height: 6px;
  border-right: 1px solid var(--color-text-subtle);
  border-bottom: 1px solid var(--color-text-subtle);
  transform: rotate(45deg) translateY(-2px);
}

.compare-popover {
  position: absolute;
  top: calc(100% + var(--space-4));
  left: 0;
  z-index: 35;
  display: grid;
  gap: var(--space-5);
  width: min(760px, calc(100vw - 2 * var(--space-6)));
  padding: var(--space-6);
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-5);
  box-shadow: var(--shadow-popover);
}

.popover-header,
.popover-footer,
.secondary-actions,
.primary-actions,
.scope-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
}

.popover-header,
.popover-footer {
  justify-content: space-between;
}

h2,
p {
  margin: 0;
}

h2 {
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-sm);
}

p {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
}

.selector-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-5);
}

.ref-column {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
  padding: var(--space-5);
  background: var(--color-bg-panel);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-4);
}

.column-header {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.field-label {
  color: var(--color-text-subtle);
  font-size: var(--font-size-caption);
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.field-value {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-field {
  display: block;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

input {
  width: 100%;
  height: 32px;
  padding: 0 var(--space-4);
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
  outline: 0;

  &:focus {
    border-color: var(--color-border-focus);
  }

  &::placeholder {
    color: var(--color-text-subtle);
  }
}

.option-list {
  display: grid;
  gap: var(--space-2);
  max-height: 260px;
  overflow: auto;
  padding-right: var(--space-2);
}

.ref-option {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-4) var(--space-5);
  color: var(--color-text-secondary);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-3);

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-hover);
    border-color: var(--color-border-default);
  }

  &.selected {
    background: var(--color-accent-muted);
    border-color: var(--color-accent);
  }

  &.custom {
    border-style: dashed;
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.option-main {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  min-width: 0;
}

.option-label,
.option-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-label {
  min-width: 0;
  color: var(--color-text-primary);
  font-weight: 700;
}

.option-badge {
  flex: 0 0 auto;
  padding: 1px var(--space-3);
  color: var(--color-text-secondary);
  background: var(--color-bg-active);
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
}

.option-detail {
  color: var(--color-text-subtle);
  font-size: var(--font-size-label);
}

.scope-row,
.popover-footer {
  flex-wrap: wrap;
}

@media (max-width: 860px) {
  .compare-popover {
    width: min(520px, calc(100vw - 2 * var(--space-6)));
  }

  .selector-grid {
    grid-template-columns: 1fr;
  }
}
</style>
