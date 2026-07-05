<template>
  <div class="settings-section">
    <SettingsSectionHeader
      title-id="keyboard-settings-title"
      title="Keyboard"
      description="Customize single-file diff navigation and review actions. Use comma-separated bindings such as h, &lt;Left&gt;."
    >
      <template #actions>
        <Button :disabled="!keybindingDraftsChanged || !keybindingValidation.valid" @click="applyKeybindings">Apply</Button>

        <Button variant="secondary" @click="resetKeybindingDrafts">Reset to Defaults</Button>
      </template>
    </SettingsSectionHeader>

    <div v-if="keybindingSaved" class="message success" role="status">Keybindings saved.</div>

    <div v-if="validationErrors.length > 0" class="message error" role="alert">
      {{ validationErrors.length }} keybinding {{ validationErrors.length === 1 ? 'issue' : 'issues' }} need attention.
    </div>

    <div class="keybinding-groups">
      <Panel v-for="group in keybindingGroups" :key="group.name" padding="none" class="keybinding-group">
        <header class="group-header">
          <div>
            <h3>{{ group.name }}</h3>

            <p>{{ group.actions.length }} {{ group.actions.length === 1 ? 'action' : 'actions' }}</p>
          </div>
        </header>

        <label v-for="action in group.actions" :key="action.id" class="keybinding-row">
          <span class="keybinding-meta">
            <span class="keybinding-label">{{ action.label }}</span>

            <span class="keybinding-description">{{ action.description }}</span>
          </span>

          <span class="keybinding-editor">
            <input
              class="keybinding-input"
              type="text"
              :value="keybindingDrafts[action.id]"
              spellcheck="false"
              :aria-label="`${action.label} keybindings`"
              :aria-invalid="Boolean(keybindingValidation.errors[action.id])"
              @input="updateKeybindingDraft(action.id, $event)"
            />

            <span v-if="keybindingValidation.errors[action.id]" class="keybinding-error">
              {{ keybindingValidation.errors[action.id] }}
            </span>
          </span>
        </label>
      </Panel>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  diffKeybindingActionIds,
  diffKeybindingDefinitions,
  normalizeDiffKeybindingList,
  validateDiffKeybindingMap,
  type DiffKeybindingAction,
  type DiffKeybindingDefinition,
  type DiffKeybindingMap,
} from '../../lib/diffKeybindings';
import { useSettingsStore } from '../../stores/settings';
import Button from '../Button.vue';
import Panel from '../ui/Panel.vue';
import SettingsSectionHeader from './SettingsSectionHeader.vue';

const settings = useSettingsStore();
const keybindingDrafts = ref<Record<DiffKeybindingAction, string>>(keybindingDraftsFromMap(settings.diffKeybindings));
const keybindingSaved = ref(false);
let keybindingSavedTimer: number | undefined;

const keybindingGroups = computed(() => {
  const groups: { name: DiffKeybindingDefinition['group']; actions: DiffKeybindingDefinition[] }[] = [];
  for (const definition of diffKeybindingDefinitions) {
    const group = groups.find((item) => item.name === definition.group);
    if (group) group.actions.push(definition);
    else groups.push({ name: definition.group, actions: [definition] });
  }
  return groups;
});
const keybindingDraftMap = computed<DiffKeybindingMap>(() => {
  return Object.fromEntries(
    diffKeybindingActionIds.map((action) => [action, normalizeDiffKeybindingList(keybindingDrafts.value[action] ?? '')]),
  ) as DiffKeybindingMap;
});
const keybindingValidation = computed(() => validateDiffKeybindingMap(keybindingDraftMap.value));
const keybindingDraftsChanged = computed(() => JSON.stringify(keybindingDraftMap.value) !== JSON.stringify(settings.diffKeybindings));
const validationErrors = computed(() => Object.values(keybindingValidation.value.errors).filter(Boolean));

const updateKeybindingDraft = (action: DiffKeybindingAction, event: Event) => {
  const input = event.target as HTMLInputElement;
  keybindingDrafts.value = { ...keybindingDrafts.value, [action]: input.value };
  keybindingSaved.value = false;
};

const applyKeybindings = () => {
  const validation = settings.setDiffKeybindings(keybindingDraftMap.value);
  if (!validation.valid) return;

  keybindingDrafts.value = keybindingDraftsFromMap(settings.diffKeybindings);
  showKeybindingSaved();
};

const resetKeybindingDrafts = () => {
  settings.resetDiffKeybindings();
  keybindingDrafts.value = keybindingDraftsFromMap(settings.diffKeybindings);
  showKeybindingSaved();
};

function keybindingDraftsFromMap(keybindings: DiffKeybindingMap): Record<DiffKeybindingAction, string> {
  return Object.fromEntries(diffKeybindingActionIds.map((action) => [action, keybindings[action].join(', ')])) as Record<
    DiffKeybindingAction,
    string
  >;
}

const showKeybindingSaved = () => {
  keybindingSaved.value = true;
  if (keybindingSavedTimer !== undefined) window.clearTimeout(keybindingSavedTimer);
  keybindingSavedTimer = window.setTimeout(() => {
    keybindingSaved.value = false;
    keybindingSavedTimer = undefined;
  }, 1400);
};

onBeforeUnmount(() => {
  if (keybindingSavedTimer !== undefined) window.clearTimeout(keybindingSavedTimer);
});
</script>

<style scoped lang="scss">
.settings-section,
.keybinding-groups {
  display: grid;
  gap: var(--space-7);
  min-width: 0;
}

.keybinding-group {
  overflow: hidden;
}

.group-header {
  padding: var(--space-7);
  border-bottom: 1px solid var(--color-border-subtle);
}

h3,
p {
  margin: 0;
}

h3 {
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-sm);
}

p {
  margin-top: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
}

.keybinding-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(190px, 340px);
  gap: var(--space-8);
  align-items: start;
  padding: var(--space-6) var(--space-7);
  border-top: 1px solid var(--color-border-hairline);
}

.keybinding-row:first-of-type {
  border-top: 0;
}

.keybinding-meta,
.keybinding-editor {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.keybinding-label {
  color: var(--color-text-primary);
  font-size: var(--font-size-body);
  font-weight: 700;
}

.keybinding-description {
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
  line-height: 1.4;
}

.keybinding-input {
  width: 100%;
  min-width: 0;
  padding: var(--space-4) var(--space-5);
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  outline: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-label);

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }

  &[aria-invalid='true'] {
    border-color: var(--color-danger);
  }
}

.keybinding-error {
  color: var(--color-danger);
  font-size: var(--font-size-label);
  line-height: 1.4;
}

.message {
  padding: var(--space-5) var(--space-6);
  color: var(--color-text-muted);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-4);
  font-size: var(--font-size-body);

  &.error {
    color: var(--color-danger);
    background: var(--color-danger-muted);
  }

  &.success {
    color: var(--color-success);
    background: var(--color-success-muted);
  }
}

@media (max-width: 760px) {
  .keybinding-row {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-5);
  }
}
</style>
