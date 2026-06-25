import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export type SyntaxThemeId = 'github-dark' | 'solarized-dark' | 'nord' | 'high-contrast' | 'custom';

export type SyntaxThemeColors = {
  text: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  property: string;
  punctuation: string;
};

export type SyntaxStyle = {
  color?: string;
  fontStyle?: string;
  fontWeight?: string;
  textDecoration?: string;
};

export type SyntaxTheme = {
  id: SyntaxThemeId;
  name: string;
  colors: SyntaxThemeColors;
};

const syntaxThemeStorageKey = 'diffuse.syntaxTheme';
const customSyntaxThemeStorageKey = 'diffuse.customSyntaxTheme';

export const builtInSyntaxThemes: SyntaxTheme[] = [
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    colors: {
      text: '#e6edf3',
      comment: '#8b95a8',
      keyword: '#ff7bcb',
      string: '#7ee787',
      number: '#f2cc60',
      function: '#d2a8ff',
      type: '#ffa657',
      property: '#58a6ff',
      punctuation: '#9aa7b8',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    colors: {
      text: '#839496',
      comment: '#586e75',
      keyword: '#859900',
      string: '#2aa198',
      number: '#d33682',
      function: '#268bd2',
      type: '#b58900',
      property: '#6c71c4',
      punctuation: '#93a1a1',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    colors: {
      text: '#d8dee9',
      comment: '#616e88',
      keyword: '#81a1c1',
      string: '#a3be8c',
      number: '#b48ead',
      function: '#88c0d0',
      type: '#8fbcbb',
      property: '#d8dee9',
      punctuation: '#eceff4',
    },
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    colors: {
      text: '#ffffff',
      comment: '#9ca3af',
      keyword: '#ff5ea8',
      string: '#4ade80',
      number: '#fde047',
      function: '#93c5fd',
      type: '#fdba74',
      property: '#67e8f9',
      punctuation: '#e5e7eb',
    },
  },
];

const defaultCustomTheme: SyntaxThemeColors = { ...builtInSyntaxThemes[0].colors };

export const useSettingsStore = defineStore('settings', () => {
  const selectedSyntaxThemeId = ref<SyntaxThemeId>(loadThemeId());
  const customSyntaxTheme = ref<SyntaxThemeColors>(loadCustomTheme());

  const syntaxTheme = computed<SyntaxTheme>(() => {
    if (selectedSyntaxThemeId.value === 'custom') return { id: 'custom', name: 'Custom', colors: customSyntaxTheme.value };
    return builtInSyntaxThemes.find((theme) => theme.id === selectedSyntaxThemeId.value) ?? builtInSyntaxThemes[0];
  });

  const setSyntaxTheme = (themeId: SyntaxThemeId) => {
    selectedSyntaxThemeId.value = themeId;
    window.localStorage.setItem(syntaxThemeStorageKey, themeId);
  };

  const setCustomSyntaxColor = (key: keyof SyntaxThemeColors, color: string) => {
    customSyntaxTheme.value = { ...customSyntaxTheme.value, [key]: color };
    window.localStorage.setItem(customSyntaxThemeStorageKey, JSON.stringify(customSyntaxTheme.value));
  };

  return {
    selectedSyntaxThemeId,
    customSyntaxTheme,
    syntaxTheme,
    setSyntaxTheme,
    setCustomSyntaxColor,
  };
});

const loadThemeId = (): SyntaxThemeId => {
  const value = window.localStorage.getItem(syntaxThemeStorageKey);
  if (value === 'github-dark' || value === 'solarized-dark' || value === 'nord' || value === 'high-contrast' || value === 'custom')
    return value;
  return 'github-dark';
};

const loadCustomTheme = (): SyntaxThemeColors => {
  const raw = window.localStorage.getItem(customSyntaxThemeStorageKey);
  if (!raw) return defaultCustomTheme;

  try {
    const parsed = JSON.parse(raw) as Partial<SyntaxThemeColors>;
    return { ...defaultCustomTheme, ...parsed };
  } catch {
    return defaultCustomTheme;
  }
};
