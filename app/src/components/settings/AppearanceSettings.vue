<template>
  <div class="settings-section">
    <SettingsSectionHeader
      title-id="appearance-settings-title"
      title="Appearance"
      description="Control how code is rendered in diffs without leaving the review workspace."
    />

    <div class="section-grid">
      <Panel padding="lg" class="theme-panel">
        <div class="panel-heading">
          <div>
            <h3>Syntax Theme</h3>

            <p>Choose a built-in syntax theme or switch to custom colors.</p>
          </div>

          <Badge tone="accent">{{ selectedTheme.name }}</Badge>
        </div>

        <div class="theme-grid">
          <button
            v-for="theme in themeOptions"
            :key="theme.id"
            class="theme-card"
            :class="{ active: settings.selectedSyntaxThemeId === theme.id }"
            type="button"
            @click="settings.setSyntaxTheme(theme.id)"
          >
            <span class="theme-name">{{ theme.name }}</span>

            <span class="theme-swatches" aria-hidden="true">
              <span v-for="color in swatchColors(theme.colors)" :key="color" class="swatch" :style="{ background: color }" />
            </span>
          </button>
        </div>
      </Panel>

      <Panel v-if="settings.selectedSyntaxThemeId === 'custom'" padding="lg" class="custom-panel">
        <div class="panel-heading">
          <div>
            <h3>Custom Colors</h3>

            <p>Fine tune syntax scopes with hex values or the color picker.</p>
          </div>
        </div>

        <div class="custom-theme">
          <label v-for="field in customColorFields" :key="field.key" class="color-field">
            <span>{{ field.label }}</span>

            <span class="color-controls">
              <input
                class="color-swatch-input"
                type="color"
                :value="settings.customSyntaxTheme[field.key]"
                :aria-label="`${field.label} color`"
                @input="setCustomSyntaxColor(field.key, $event)"
              />

              <input
                class="hex-input"
                type="text"
                :value="settings.customSyntaxTheme[field.key]"
                spellcheck="false"
                :aria-label="`${field.label} hex color`"
                @input="previewCustomSyntaxHexColor(field.key, $event)"
                @change="setCustomSyntaxHexColor(field.key, $event)"
                @blur="setCustomSyntaxHexColor(field.key, $event)"
                @keyup.enter="setCustomSyntaxHexColor(field.key, $event)"
              />
            </span>
          </label>
        </div>
      </Panel>

      <Panel padding="lg" class="preview-panel">
        <div class="panel-heading">
          <div>
            <h3>Preview</h3>

            <p>Review a representative code fragment before returning to the diff.</p>
          </div>
        </div>

        <div class="theme-preview" aria-label="Syntax theme preview">
          <HighlightedCode v-for="line in previewLines" :key="line.text" :text="line.text" :spans="line.spans" />
        </div>
      </Panel>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { builtInSyntaxThemes, useSettingsStore, type SyntaxTheme, type SyntaxThemeColors } from '../../stores/settings';
import HighlightedCode from '../diff/HighlightedCode.vue';
import Badge from '../ui/Badge.vue';
import Panel from '../ui/Panel.vue';
import SettingsSectionHeader from './SettingsSectionHeader.vue';

const settings = useSettingsStore();
const themeOptions = computed<SyntaxTheme[]>(() => [
  ...builtInSyntaxThemes,
  { id: 'custom', name: 'Custom', colors: settings.customSyntaxTheme },
]);
const selectedTheme = computed(
  () => themeOptions.value.find((theme) => theme.id === settings.selectedSyntaxThemeId) ?? themeOptions.value[0],
);

const customColorFields: { key: keyof SyntaxThemeColors; label: string }[] = [
  { key: 'text', label: 'Text' },
  { key: 'comment', label: 'Comment' },
  { key: 'keyword', label: 'Keyword' },
  { key: 'string', label: 'String' },
  { key: 'number', label: 'Number' },
  { key: 'function', label: 'Function' },
  { key: 'type', label: 'Type' },
  { key: 'property', label: 'Property' },
  { key: 'punctuation', label: 'Punctuation' },
];

const previewLines = [
  {
    text: 'function formatUser(user: User) {',
    spans: [
      { startColumn: 0, endColumn: 8, scope: 'keyword.function' },
      { startColumn: 9, endColumn: 19, scope: 'function' },
      { startColumn: 20, endColumn: 24, scope: 'variable.parameter' },
      { startColumn: 26, endColumn: 30, scope: 'type' },
      { startColumn: 31, endColumn: 32, scope: 'punctuation.bracket' },
    ],
  },
  {
    text: '  const active = user.enabled && user.score > 10;',
    spans: [
      { startColumn: 2, endColumn: 7, scope: 'keyword' },
      { startColumn: 8, endColumn: 14, scope: 'variable' },
      { startColumn: 17, endColumn: 21, scope: 'variable.parameter' },
      { startColumn: 22, endColumn: 29, scope: 'property' },
      { startColumn: 30, endColumn: 32, scope: 'operator' },
      { startColumn: 33, endColumn: 37, scope: 'variable.parameter' },
      { startColumn: 38, endColumn: 43, scope: 'property' },
      { startColumn: 46, endColumn: 48, scope: 'number' },
    ],
  },
  {
    text: '  return `${user.name}: ${active}`; // visible in review',
    spans: [
      { startColumn: 2, endColumn: 8, scope: 'keyword' },
      { startColumn: 9, endColumn: 34, scope: 'string' },
      { startColumn: 37, endColumn: 57, scope: 'comment' },
    ],
  },
  {
    text: '}',
    spans: [{ startColumn: 0, endColumn: 1, scope: 'punctuation.bracket' }],
  },
];

const swatchColors = (colors: SyntaxThemeColors) => {
  return [colors.keyword, colors.string, colors.function, colors.type, colors.comment];
};

const setCustomSyntaxColor = (key: keyof SyntaxThemeColors, event: Event) => {
  const input = event.target as HTMLInputElement;
  settings.setCustomSyntaxColor(key, input.value);
};

const setCustomSyntaxHexColor = (key: keyof SyntaxThemeColors, event: Event) => {
  const input = event.target as HTMLInputElement;
  const color = normalizeHexColor(input.value);
  if (!color) {
    input.value = settings.customSyntaxTheme[key];
    return;
  }

  settings.setCustomSyntaxColor(key, color);
  input.value = color;
};

const previewCustomSyntaxHexColor = (key: keyof SyntaxThemeColors, event: Event) => {
  const input = event.target as HTMLInputElement;
  const color = normalizeHexColor(input.value);
  if (color) settings.setCustomSyntaxColor(key, color);
};

const normalizeHexColor = (value: string) => {
  const trimmed = value.trim();
  const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  if (!/^#[0-9a-fA-F]{3}$/.test(hex)) return undefined;

  return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase();
};
</script>

<style scoped lang="scss">
.settings-section,
.section-grid,
.custom-theme {
  display: grid;
  gap: var(--space-7);
  min-width: 0;
}

.panel-heading {
  display: flex;
  gap: var(--space-6);
  align-items: flex-start;
  justify-content: space-between;
  min-width: 0;
  margin-bottom: var(--space-7);
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
  line-height: 1.45;
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-4);
}

.theme-card {
  display: flex;
  gap: var(--space-6);
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  padding: var(--space-6);
  color: var(--color-text-primary);
  cursor: pointer;
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-5);
  box-shadow: var(--shadow-inset-highlight);

  &:hover {
    background: var(--color-bg-hover);
    border-color: var(--color-border-strong);
  }

  &.active {
    background: var(--color-bg-active);
    border-color: var(--color-accent);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.theme-name {
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.theme-swatches {
  display: flex;
  flex-shrink: 0;
}

.swatch {
  width: 16px;
  height: 16px;
  margin-left: -3px;
  border: 1px solid var(--color-bg-app);
  border-radius: var(--radius-pill);
}

.custom-theme {
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: var(--space-4);
}

.color-field {
  display: flex;
  gap: var(--space-5);
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  padding: var(--space-5) var(--space-6);
  color: var(--color-text-secondary);
  background: var(--color-bg-panel-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-5);
  font-size: var(--font-size-body);
}

.color-controls {
  display: flex;
  flex: 0 0 auto;
  gap: var(--space-4);
  align-items: center;
}

.color-swatch-input {
  width: 26px;
  height: 26px;
  padding: 0;
  overflow: hidden;
  background: transparent;
  border: 0;
  border-radius: var(--radius-pill);
  cursor: pointer;
}

.color-swatch-input::-webkit-color-swatch-wrapper {
  padding: 0;
}

.color-swatch-input::-webkit-color-swatch {
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-pill);
}

.hex-input {
  width: 88px;
  min-width: 0;
  padding: var(--space-3) var(--space-4);
  color: var(--color-text-primary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
  outline: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-label);
  text-transform: lowercase;

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.theme-preview {
  overflow: hidden;
  background: var(--color-bg-code);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-5);
}

.theme-preview :deep(.code) {
  height: var(--line-height-code);
  font-family: var(--font-mono);
  font-size: var(--font-size-label);
  line-height: var(--line-height-code);
}

@media (max-width: 760px) {
  .panel-heading {
    display: grid;
  }
}
</style>
