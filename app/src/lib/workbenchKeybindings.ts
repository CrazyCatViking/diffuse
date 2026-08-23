export const workbenchCommandIds = [
  'nextWorkspace',
  'previousWorkspace',
  'workbenchOverview',
  'openWorkspace',
  'switchWorkspace',
  'workspaceSlot1',
  'workspaceSlot2',
  'workspaceSlot3',
  'workspaceSlot4',
  'workspaceSlot5',
  'workspaceSlot6',
  'workspaceSlot7',
  'workspaceSlot8',
  'workspaceSlot9',
] as const;

export type WorkbenchCommand = (typeof workbenchCommandIds)[number];
export type WorkbenchKeybindingMap = Record<WorkbenchCommand, string[]>;

export const workbenchKeybindingDefinitions: { command: WorkbenchCommand; label: string; description: string }[] = [
  { command: 'nextWorkspace', label: 'Next workspace', description: 'Activate the next workspace in rail order.' },
  { command: 'previousWorkspace', label: 'Previous workspace', description: 'Activate the previous workspace in rail order.' },
  { command: 'workbenchOverview', label: 'Workbench overview', description: 'Show all open and recent workspaces.' },
  { command: 'openWorkspace', label: 'Open workspace', description: 'Choose a repository to open.' },
  { command: 'switchWorkspace', label: 'Switch workspace', description: 'Open the searchable workspace switcher.' },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((slot) => ({
    command: `workspaceSlot${slot}` as const,
    label: `Workspace ${slot}`,
    description: `Activate visible rail slot ${slot}.`,
  })),
];

export const defaultWorkbenchKeybindings: WorkbenchKeybindingMap = {
  nextWorkspace: ['Ctrl+Tab'],
  previousWorkspace: ['Ctrl+Shift+Tab'],
  workbenchOverview: ['Ctrl+Shift+O'],
  openWorkspace: ['Ctrl+O'],
  switchWorkspace: ['Ctrl+K'],
  workspaceSlot1: ['Ctrl+1'],
  workspaceSlot2: ['Ctrl+2'],
  workspaceSlot3: ['Ctrl+3'],
  workspaceSlot4: ['Ctrl+4'],
  workspaceSlot5: ['Ctrl+5'],
  workspaceSlot6: ['Ctrl+6'],
  workspaceSlot7: ['Ctrl+7'],
  workspaceSlot8: ['Ctrl+8'],
  workspaceSlot9: ['Ctrl+9'],
};

export function workbenchCommandForEvent(
  event: KeyboardEvent,
  keybindings: WorkbenchKeybindingMap = defaultWorkbenchKeybindings,
): WorkbenchCommand | undefined {
  if (event.isComposing) return undefined;
  const chord = chordForEvent(event);
  if (!chord) return undefined;
  return workbenchCommandIds.find((command) => keybindings[command].map(normalizeWorkbenchBinding).includes(chord));
}

export function normalizeWorkbenchBinding(binding: string): string {
  const parts = binding
    .trim()
    .split('+')
    .map((part) => part.trim().toLocaleLowerCase())
    .filter(Boolean);
  const key = parts.at(-1);
  if (!key) return '';
  const modifiers = [
    parts.includes('ctrl') || parts.includes('control') ? 'Ctrl' : '',
    parts.includes('alt') ? 'Alt' : '',
    parts.includes('shift') ? 'Shift' : '',
    parts.includes('meta') || parts.includes('cmd') ? 'Meta' : '',
  ].filter(Boolean);
  const normalizedKey = key === 'tab' ? 'Tab' : key.length === 1 ? key.toUpperCase() : `${key[0].toUpperCase()}${key.slice(1)}`;
  return [...modifiers, normalizedKey].join('+');
}

export function normalizeWorkbenchBindingList(value: string): string[] {
  return value.split(',').map(normalizeWorkbenchBinding).filter(Boolean);
}

export function validateWorkbenchKeybindings(map: WorkbenchKeybindingMap): {
  valid: boolean;
  errors: Partial<Record<WorkbenchCommand, string>>;
} {
  const errors: Partial<Record<WorkbenchCommand, string>> = {};
  const used = new Map<string, WorkbenchCommand>();
  for (const command of workbenchCommandIds) {
    for (const binding of map[command]) {
      const normalized = normalizeWorkbenchBinding(binding);
      if (!/^(?:(?:Ctrl|Alt|Shift|Meta)\+)+(?:Tab|[A-Z0-9])$/.test(normalized)) {
        errors[command] = `Invalid workbench shortcut: ${binding}`;
        continue;
      }
      const previous = used.get(normalized);
      if (previous && previous !== command) errors[command] = `${normalized} is already assigned.`;
      else used.set(normalized, command);
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function mergeWorkbenchKeybindings(value: unknown): WorkbenchKeybindingMap {
  const merged = cloneDefaultWorkbenchKeybindings();
  if (value && typeof value === 'object') {
    const source = value as Partial<Record<WorkbenchCommand, unknown>>;
    for (const command of workbenchCommandIds) {
      if (Array.isArray(source[command])) {
        merged[command] = source[command].filter((item): item is string => typeof item === 'string').map(normalizeWorkbenchBinding);
      }
    }
  }
  return validateWorkbenchKeybindings(merged).valid ? merged : cloneDefaultWorkbenchKeybindings();
}

export function cloneDefaultWorkbenchKeybindings(): WorkbenchKeybindingMap {
  return Object.fromEntries(
    workbenchCommandIds.map((command) => [command, [...defaultWorkbenchKeybindings[command]]]),
  ) as WorkbenchKeybindingMap;
}

function chordForEvent(event: KeyboardEvent): string | undefined {
  const modifiers = [
    event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Meta' : '',
  ].filter(Boolean);
  if (modifiers.length === 0) return undefined;
  const key = event.key === 'Tab' ? 'Tab' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [...modifiers, key].join('+');
}
