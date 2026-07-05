<template>
  <main class="settings-view">
    <Toolbar class="settings-toolbar" density="normal">
      <div class="settings-title">
        <Badge tone="accent">Settings</Badge>

        <div>
          <h1>Settings</h1>

          <p>Manage Diffuse preferences, integrations, and local developer tools.</p>
        </div>
      </div>

      <Button variant="secondary" @click="$emit('close')">Back to Diff</Button>
    </Toolbar>

    <div class="settings-layout">
      <SettingsNav
        :sections="settingsSections"
        :active-section-id="activeSectionId"
        :query="navQuery"
        @update:query="navQuery = $event"
        @select="selectSection"
      />

      <section class="settings-content" :aria-labelledby="`${activeSectionId}-settings-title`">
        <component :is="activeSectionComponent" />
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, ref, type Component } from 'vue';
import Button from '../Button.vue';
import Badge from '../ui/Badge.vue';
import Toolbar from '../ui/Toolbar.vue';
import AppearanceSettings from './AppearanceSettings.vue';
import KeyboardSettings from './KeyboardSettings.vue';
import LanguageServersSettings from './LanguageServersSettings.vue';
import SettingsNav from './SettingsNav.vue';
import SyntaxGrammarsSettings from './SyntaxGrammarsSettings.vue';
import { isSettingsSectionId, settingsSections, type SettingsSectionId } from './settingsSections';

defineEmits<{
  close: [];
}>();

const activeSectionStorageKey = 'diffuse.settings.activeSection';
const sectionComponents: Record<SettingsSectionId, Component> = {
  appearance: AppearanceSettings,
  keyboard: KeyboardSettings,
  languageServers: LanguageServersSettings,
  syntaxGrammars: SyntaxGrammarsSettings,
};

const activeSectionId = ref<SettingsSectionId>(loadActiveSectionId());
const navQuery = ref('');
const activeSectionComponent = computed(() => sectionComponents[activeSectionId.value]);

const selectSection = (sectionId: SettingsSectionId) => {
  activeSectionId.value = sectionId;
  window.localStorage.setItem(activeSectionStorageKey, sectionId);
};

function loadActiveSectionId(): SettingsSectionId {
  const value = window.localStorage.getItem(activeSectionStorageKey);
  return value && isSettingsSectionId(value) ? value : 'appearance';
}
</script>

<style scoped lang="scss">
.settings-view {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  color: var(--color-text-secondary);
  background: var(--color-bg-app);
}

.settings-toolbar {
  align-items: flex-start;
}

.settings-title {
  display: flex;
  gap: var(--space-6);
  align-items: flex-start;
  min-width: 0;
}

h1,
p {
  margin: 0;
}

h1 {
  color: var(--color-text-primary);
  font-size: var(--font-size-heading-lg);
  line-height: 1.1;
}

p {
  margin-top: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
  line-height: 1.45;
}

.settings-layout {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  min-height: 0;
}

.settings-content {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: var(--space-8);
}

@media (max-width: 900px) {
  .settings-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .settings-content {
    padding: var(--space-6);
  }
}

@media (max-width: 640px) {
  .settings-toolbar,
  .settings-title {
    display: grid;
  }
}
</style>
