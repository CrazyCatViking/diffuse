<template>
  <aside class="settings-nav">
    <SearchInput
      :model-value="query"
      compact
      placeholder="Search settings..."
      label="Search settings"
      @update:model-value="emit('update:query', $event)"
    />

    <nav class="nav-groups" aria-label="Settings sections">
      <section v-for="group in visibleGroups" :key="group.id" class="nav-group">
        <div class="nav-group-label">{{ group.label }}</div>

        <button
          v-for="section in group.sections"
          :key="section.id"
          class="nav-item"
          :class="{ active: section.id === activeSectionId }"
          type="button"
          :aria-current="section.id === activeSectionId ? 'page' : undefined"
          @click="emit('select', section.id)"
        >
          <span class="nav-item-copy">
            <span class="nav-item-label">{{ section.label }}</span>

            <span class="nav-item-description">{{ section.description }}</span>
          </span>
        </button>
      </section>
    </nav>

    <div v-if="visibleGroups.length === 0" class="nav-empty">No settings match your search.</div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import SearchInput from '../search/SearchInput.vue';
import { settingsSectionGroups, type SettingsSection, type SettingsSectionGroupId, type SettingsSectionId } from './settingsSections';

const props = defineProps<{
  sections: SettingsSection[];
  activeSectionId: SettingsSectionId;
  query: string;
}>();

const emit = defineEmits<{
  'update:query': [query: string];
  select: [sectionId: SettingsSectionId];
}>();

const normalizedQuery = computed(() => props.query.trim().toLowerCase());
const visibleGroups = computed(() => {
  return settingsSectionGroups
    .map((group) => ({
      ...group,
      sections: props.sections.filter((section) => section.group === group.id && sectionMatchesQuery(section, group.id)),
    }))
    .filter((group) => group.sections.length > 0);
});

const sectionMatchesQuery = (section: SettingsSection, groupId: SettingsSectionGroupId) => {
  const query = normalizedQuery.value;
  if (!query) return true;

  const haystack = [section.label, section.description, groupId, ...section.keywords].join(' ').toLowerCase();
  return haystack.includes(query);
};
</script>

<style scoped lang="scss">
.settings-nav {
  display: grid;
  align-content: start;
  gap: var(--space-7);
  min-width: 0;
  min-height: 0;
  padding: var(--space-7);
  overflow: auto;
  background: var(--color-bg-shell);
  border-right: 1px solid var(--color-border-subtle);
}

.nav-groups,
.nav-group {
  display: grid;
  gap: var(--space-3);
}

.nav-groups {
  gap: var(--space-7);
}

.nav-group-label {
  color: var(--color-text-subtle);
  font-size: var(--font-size-caption);
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.nav-item {
  display: grid;
  min-width: 0;
  padding: var(--space-5) var(--space-6);
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-4);
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);

  &:hover {
    background: var(--color-bg-hover);
    border-color: var(--color-border-subtle);
  }

  &.active {
    background: var(--color-bg-active);
    border-color: var(--color-border-default);
    box-shadow: var(--shadow-inset-highlight);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.nav-item-copy {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.nav-item-label {
  color: var(--color-text-primary);
  font-size: var(--font-size-body);
  font-weight: 700;
}

.nav-item-description,
.nav-empty {
  color: var(--color-text-muted);
  font-size: var(--font-size-label);
  line-height: 1.4;
}

.nav-empty {
  padding: var(--space-6);
  border: 1px dashed var(--color-border-default);
  border-radius: var(--radius-5);
}

@media (max-width: 900px) {
  .settings-nav {
    border-right: 0;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .nav-groups {
    display: flex;
    flex-wrap: wrap;
  }

  .nav-group {
    flex: 1 1 220px;
  }
}
</style>
