export const settingsSectionIds = ['appearance', 'keyboard', 'languageServers', 'syntaxGrammars'] as const;

export type SettingsSectionId = (typeof settingsSectionIds)[number];
export type SettingsSectionGroupId = 'workbench' | 'languages';

export type SettingsSection = {
  id: SettingsSectionId;
  group: SettingsSectionGroupId;
  label: string;
  description: string;
  keywords: string[];
};

export const settingsSectionGroups: { id: SettingsSectionGroupId; label: string }[] = [
  { id: 'workbench', label: 'Workbench' },
  { id: 'languages', label: 'Languages' },
];

export const settingsSections: SettingsSection[] = [
  {
    id: 'appearance',
    group: 'workbench',
    label: 'Appearance',
    description: 'Themes, syntax colors, and code preview.',
    keywords: ['theme', 'colors', 'syntax', 'preview', 'custom'],
  },
  {
    id: 'keyboard',
    group: 'workbench',
    label: 'Keyboard',
    description: 'Diff viewer shortcuts and navigation bindings.',
    keywords: ['keybindings', 'shortcuts', 'keyboard', 'navigation', 'vim'],
  },
  {
    id: 'languageServers',
    group: 'languages',
    label: 'Language Servers',
    description: 'LSP status, config, installs, and server restarts.',
    keywords: ['lsp', 'diagnostics', 'hover', 'servers', 'config'],
  },
  {
    id: 'syntaxGrammars',
    group: 'languages',
    label: 'Syntax Grammars',
    description: 'Tree-sitter grammar catalog and installed parsers.',
    keywords: ['tree-sitter', 'grammar', 'parser', 'highlighting', 'registry'],
  },
];

export const isSettingsSectionId = (value: string): value is SettingsSectionId => {
  return settingsSectionIds.includes(value as SettingsSectionId);
};
