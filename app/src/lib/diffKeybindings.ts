export const diffKeybindingActionIds = [
  'moveLeft',
  'moveDown',
  'moveUp',
  'moveRight',
  'nextWord',
  'previousWord',
  'endWord',
  'lineStart',
  'firstNonBlank',
  'lineEnd',
  'fileStart',
  'fileEnd',
  'pageDown',
  'pageUp',
  'openSearch',
  'searchNext',
  'searchPrevious',
  'previousChange',
  'nextChange',
  'previousDiagnostic',
  'nextDiagnostic',
  'previousReview',
  'nextReview',
  'previousCursorPosition',
  'nextCursorPosition',
  'splitLeft',
  'splitRight',
  'visualChar',
  'visualLine',
  'clear',
  'hover',
  'comment',
  'askAi',
] as const;

export type DiffKeybindingAction = (typeof diffKeybindingActionIds)[number];

export type DiffKeybindingMap = Record<DiffKeybindingAction, string[]>;

export type DiffKeybindingDefinition = {
  id: DiffKeybindingAction;
  label: string;
  description: string;
  group: 'Motion' | 'Navigation' | 'Selection' | 'Actions';
};

export type DiffKeybindingValidation = {
  valid: boolean;
  errors: Partial<Record<DiffKeybindingAction, string>>;
};

export const diffKeybindingDefinitions: DiffKeybindingDefinition[] = [
  { id: 'moveLeft', label: 'Move left', description: 'Move one column left.', group: 'Motion' },
  { id: 'moveDown', label: 'Move down', description: 'Move down by visible code lines.', group: 'Motion' },
  { id: 'moveUp', label: 'Move up', description: 'Move up by visible code lines.', group: 'Motion' },
  { id: 'moveRight', label: 'Move right', description: 'Move one column right.', group: 'Motion' },
  { id: 'nextWord', label: 'Next word', description: 'Jump to the next word start.', group: 'Motion' },
  { id: 'previousWord', label: 'Previous word', description: 'Jump to the previous word start.', group: 'Motion' },
  { id: 'endWord', label: 'End word', description: 'Jump to the current or next word end.', group: 'Motion' },
  { id: 'lineStart', label: 'Line start', description: 'Jump to column 0.', group: 'Motion' },
  { id: 'firstNonBlank', label: 'First non-blank', description: 'Jump to the first non-blank column.', group: 'Motion' },
  { id: 'lineEnd', label: 'Line end', description: 'Jump to the line end.', group: 'Motion' },
  { id: 'fileStart', label: 'File start', description: 'Jump to the first navigable line.', group: 'Navigation' },
  { id: 'fileEnd', label: 'File end', description: 'Jump to the last navigable line.', group: 'Navigation' },
  { id: 'pageDown', label: 'Page down', description: 'Move down by half a page.', group: 'Navigation' },
  { id: 'pageUp', label: 'Page up', description: 'Move up by half a page.', group: 'Navigation' },
  { id: 'openSearch', label: 'Search file', description: 'Open file search.', group: 'Navigation' },
  { id: 'searchNext', label: 'Next search match', description: 'Move to the next file-search match.', group: 'Navigation' },
  { id: 'searchPrevious', label: 'Previous search match', description: 'Move to the previous file-search match.', group: 'Navigation' },
  { id: 'previousChange', label: 'Previous change', description: 'Jump to the previous changed line.', group: 'Navigation' },
  { id: 'nextChange', label: 'Next change', description: 'Jump to the next changed line.', group: 'Navigation' },
  { id: 'previousDiagnostic', label: 'Previous diagnostic', description: 'Jump to the previous diagnostic.', group: 'Navigation' },
  { id: 'nextDiagnostic', label: 'Next diagnostic', description: 'Jump to the next diagnostic.', group: 'Navigation' },
  {
    id: 'previousReview',
    label: 'Previous review row',
    description: 'Jump to the previous comment or AI review row.',
    group: 'Navigation',
  },
  { id: 'nextReview', label: 'Next review row', description: 'Jump to the next comment or AI review row.', group: 'Navigation' },
  {
    id: 'previousCursorPosition',
    label: 'Previous cursor position',
    description: 'Jump back through cursor history.',
    group: 'Navigation',
  },
  { id: 'nextCursorPosition', label: 'Next cursor position', description: 'Jump forward through cursor history.', group: 'Navigation' },
  { id: 'splitLeft', label: 'Split left', description: 'Move to the old-side split pane.', group: 'Navigation' },
  { id: 'splitRight', label: 'Split right', description: 'Move to the new-side split pane.', group: 'Navigation' },
  { id: 'visualChar', label: 'Visual selection', description: 'Start character-wise visual selection.', group: 'Selection' },
  { id: 'visualLine', label: 'Visual line selection', description: 'Start line-wise visual selection.', group: 'Selection' },
  { id: 'clear', label: 'Clear', description: 'Clear visual mode, pending keys, or hover.', group: 'Selection' },
  { id: 'hover', label: 'LSP hover', description: 'Show LSP hover at the cursor.', group: 'Actions' },
  { id: 'comment', label: 'Comment', description: 'Comment on the current line or visual selection.', group: 'Actions' },
  { id: 'askAi', label: 'Ask AI', description: 'Ask AI about the current line or visual selection.', group: 'Actions' },
];

export const defaultDiffKeybindings: DiffKeybindingMap = {
  moveLeft: ['h', '<Left>'],
  moveDown: ['j', '<Down>'],
  moveUp: ['k', '<Up>'],
  moveRight: ['l', '<Right>'],
  nextWord: ['w'],
  previousWord: ['b'],
  endWord: ['e'],
  lineStart: ['0'],
  firstNonBlank: ['^'],
  lineEnd: ['$'],
  fileStart: ['gg'],
  fileEnd: ['G'],
  pageDown: ['<C-d>'],
  pageUp: ['<C-u>'],
  openSearch: ['/'],
  searchNext: ['n'],
  searchPrevious: ['N'],
  previousChange: ['[c'],
  nextChange: [']c'],
  previousDiagnostic: ['[d'],
  nextDiagnostic: [']d'],
  previousReview: ['[r'],
  nextReview: [']r'],
  previousCursorPosition: ['<C-o>'],
  nextCursorPosition: ['<C-i>'],
  splitLeft: ['<C-w>h'],
  splitRight: ['<C-w>l'],
  visualChar: ['v'],
  visualLine: ['V'],
  clear: ['<Esc>'],
  hover: ['K'],
  comment: ['gc'],
  askAi: ['ga'],
};

export const normalizeDiffKeybindingList = (value: string): string[] => {
  return value
    .split(',')
    .map((binding) => normalizeDiffKeybinding(binding))
    .filter((binding) => binding.length > 0);
};

export const normalizeDiffKeybinding = (value: string): string => value.trim().replace(/\s+/g, '');

export const parseDiffKeybinding = (binding: string): string[] | undefined => {
  const normalized = normalizeDiffKeybinding(binding);
  if (!normalized) return [];

  const tokens: string[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char !== '<') {
      tokens.push(char);
      continue;
    }

    const closeIndex = normalized.indexOf('>', index + 1);
    if (closeIndex === -1) return undefined;

    const token = normalized.slice(index, closeIndex + 1);
    tokens.push(normalizeSpecialToken(token));
    index = closeIndex;
  }

  return tokens.every(isValidDiffKeybindingToken) ? tokens : undefined;
};

export const validateDiffKeybindingMap = (map: DiffKeybindingMap): DiffKeybindingValidation => {
  const errors: Partial<Record<DiffKeybindingAction, string>> = {};
  const seen = new Map<string, DiffKeybindingAction>();
  const parsedBindings: { action: DiffKeybindingAction; binding: string; tokens: string[] }[] = [];

  for (const action of diffKeybindingActionIds) {
    const bindings = map[action] ?? [];
    for (const binding of bindings) {
      const tokens = parseDiffKeybinding(binding);
      if (!tokens) {
        errors[action] = `Invalid binding: ${binding}`;
        continue;
      }
      if (tokens.length === 0) continue;
      if (/^[1-9]$/.test(tokens[0])) {
        errors[action] = `Bindings cannot start with a count: ${binding}`;
        continue;
      }

      const normalized = tokens.join('');
      const previousAction = seen.get(normalized);
      if (previousAction && previousAction !== action) {
        errors[action] = `${binding} is already used by ${labelForDiffKeybindingAction(previousAction)}`;
        if (!errors[previousAction]) errors[previousAction] = `${binding} is also used by ${labelForDiffKeybindingAction(action)}`;
        continue;
      }

      seen.set(normalized, action);
      parsedBindings.push({ action, binding, tokens });
    }
  }

  for (let firstIndex = 0; firstIndex < parsedBindings.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < parsedBindings.length; secondIndex += 1) {
      const first = parsedBindings[firstIndex];
      const second = parsedBindings[secondIndex];
      const prefix = bindingPrefixConflict(first, second);
      if (!prefix) continue;

      errors[first.action] = `${prefix.binding} conflicts with ${prefix.otherBinding}`;
      errors[second.action] = `${prefix.otherBinding} conflicts with ${prefix.binding}`;
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
};

export const mergeDiffKeybindings = (value: unknown): DiffKeybindingMap => {
  if (!value || typeof value !== 'object') return cloneDefaultDiffKeybindings();

  const source = value as Partial<Record<DiffKeybindingAction, unknown>>;
  const merged = cloneDefaultDiffKeybindings();
  for (const action of diffKeybindingActionIds) {
    if (!Array.isArray(source[action])) continue;
    merged[action] = source[action].filter((binding): binding is string => typeof binding === 'string').map(normalizeDiffKeybinding);
  }

  const validation = validateDiffKeybindingMap(merged);
  return validation.valid ? merged : cloneDefaultDiffKeybindings();
};

export const cloneDefaultDiffKeybindings = (): DiffKeybindingMap => {
  return Object.fromEntries(diffKeybindingActionIds.map((action) => [action, [...defaultDiffKeybindings[action]]])) as DiffKeybindingMap;
};

const labelForDiffKeybindingAction = (action: DiffKeybindingAction) => {
  return diffKeybindingDefinitions.find((definition) => definition.id === action)?.label ?? action;
};

const normalizeSpecialToken = (token: string) => {
  const content = token.slice(1, -1);
  const lower = content.toLowerCase();
  if (lower.startsWith('c-') && lower.length === 3) return `<C-${lower[2]}>`;
  if (lower === 'left') return '<Left>';
  if (lower === 'right') return '<Right>';
  if (lower === 'up') return '<Up>';
  if (lower === 'down') return '<Down>';
  if (lower === 'esc' || lower === 'escape') return '<Esc>';
  return `<${content}>`;
};

const bindingPrefixConflict = (
  first: { binding: string; tokens: string[] },
  second: { binding: string; tokens: string[] },
): { binding: string; otherBinding: string } | undefined => {
  if (first.tokens.length === second.tokens.length) return undefined;
  if (tokensStartWith(second.tokens, first.tokens)) return { binding: first.binding, otherBinding: second.binding };
  if (tokensStartWith(first.tokens, second.tokens)) return { binding: second.binding, otherBinding: first.binding };
  return undefined;
};

const tokensStartWith = (tokens: string[], prefix: string[]) => prefix.every((token, index) => tokens[index] === token);

const isValidDiffKeybindingToken = (token: string) => {
  if (token.length === 1) return token !== ',' && token >= '!' && token <= '~';
  if (/^<C-[a-z]>$/.test(token)) return true;
  return token === '<Left>' || token === '<Right>' || token === '<Up>' || token === '<Down>' || token === '<Esc>';
};
