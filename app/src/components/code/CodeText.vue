<template>
  <pre
    class="code"
  ><template v-for="(fragment, index) in fragments" :key="index"><span v-if="fragment.style || fragment.className" :class="fragment.className" :style="fragment.style" :data-diff-cursor="fragment.cursor ? 'true' : undefined">{{ fragment.text }}</span><template v-else>{{ fragment.text }}</template></template><span v-if="endCursorVisible" class="code-cursor code-cursor-end" data-diff-cursor="true">&nbsp;</span></pre>
</template>

<script lang="ts">
import type { SyntaxStyle, SyntaxThemeColors } from '../../stores/settings';

const syntaxThemeCache = new WeakMap<SyntaxThemeColors, Record<string, SyntaxStyle>>();
const syntaxStyleCache = new WeakMap<SyntaxThemeColors, Map<string, SyntaxStyle | undefined>>();
</script>

<script setup lang="ts">
import { computed, type CSSProperties } from 'vue';
import type { SyntaxSpan } from '../../lib/protocol';
import { useSettingsStore } from '../../stores/settings';
import type { CodeTextHighlight } from './codeModels';

const props = defineProps<{
  text: string;
  spans?: SyntaxSpan[];
  highlights?: CodeTextHighlight[];
}>();

type Fragment = {
  text: string;
  style?: CSSProperties;
  className?: string;
  cursor?: boolean;
};

type VisualSpan = {
  startColumn: number;
  endColumn: number;
  scope: string;
  priority: number;
  style?: SyntaxStyle;
};

type NormalizedHighlight = CodeTextHighlight & {
  startColumn: number;
  endColumn: number;
};

const settings = useSettingsStore();

const cursorHighlight = computed(() => {
  return props.highlights?.find((highlight) => highlight.kind === 'cursor');
});

const endCursorVisible = computed(() => {
  const cursor = cursorHighlight.value;
  return Boolean(cursor && cursor.startColumn >= props.text.length);
});

const fragments = computed<Fragment[]>(() => {
  const result: Fragment[] = [];
  const textLength = props.text.length;
  const spans = (props.spans ?? [])
    .filter((span) => isVisualScope(span.scope))
    .map((span): VisualSpan => {
      const scope = span.scope;
      return {
        startColumn: Math.max(0, Math.min(textLength, span.startColumn)),
        endColumn: Math.max(0, Math.min(textLength, span.endColumn)),
        scope,
        priority: scopePriority(scope),
        style: resolveStyle(scope),
      };
    })
    .filter((span) => span.endColumn > span.startColumn)
    .sort((first, second) => first.startColumn - second.startColumn || first.endColumn - second.endColumn);
  const highlights = (props.highlights ?? [])
    .map((highlight) => ({
      kind: highlight.kind,
      startColumn: Math.max(0, Math.min(textLength, highlight.startColumn)),
      endColumn: Math.max(0, Math.min(textLength, highlight.endColumn)),
    }))
    .filter((highlight) => highlight.kind === 'cursor' || highlight.endColumn > highlight.startColumn)
    .filter((highlight) => highlight.kind !== 'cursor' || highlight.startColumn < textLength);
  if (spans.length === 0 && highlights.length === 0) return [{ text: props.text }];

  const boundaries = sortedBoundaries(textLength, spans, highlights);
  const activeSpans: VisualSpan[] = [];
  let nextSpanIndex = 0;
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;

    while (nextSpanIndex < spans.length && spans[nextSpanIndex].startColumn <= start) {
      activeSpans.push(spans[nextSpanIndex]);
      nextSpanIndex += 1;
    }
    for (let spanIndex = activeSpans.length - 1; spanIndex >= 0; spanIndex -= 1) {
      if (activeSpans[spanIndex].endColumn < end) activeSpans.splice(spanIndex, 1);
    }

    const span = bestSpanForRange(activeSpans, start, end);
    const style: CSSProperties = span?.style ? { ...span.style } : {};
    const highlight = highlightForRange(highlights, start, end);
    let className: string | undefined;
    if (highlight?.kind === 'review') {
      className = 'code-highlight';
      style.background = 'rgba(240, 195, 106, 0.32)';
    } else if (highlight?.kind === 'search' || highlight?.kind === 'active-search') {
      className = 'code-highlight';
      style.background = highlight.kind === 'active-search' ? 'rgba(255, 214, 102, 0.78)' : 'rgba(255, 214, 102, 0.34)';
      style.color = '#101318';
      if (highlight.kind === 'active-search') style.outline = '1px solid rgba(255, 241, 184, 0.95)';
    } else if (highlight?.kind === 'visual') {
      className = 'code-highlight';
      style.background = 'var(--color-bg-selected)';
      style.color = 'var(--color-text-primary)';
    } else if (highlight?.kind === 'cursor') {
      className = 'code-cursor';
      style.background = 'var(--color-text-primary)';
      style.color = 'var(--color-bg-code)';
    } else if (highlight?.kind === 'diff-inserted') {
      className = 'code-highlight';
      style.background = 'rgba(75, 210, 118, 0.34)';
      style.boxShadow = 'inset 0 -1px 0 rgba(141, 242, 177, 0.72)';
    } else if (highlight?.kind === 'diff-deleted') {
      className = 'code-highlight';
      style.background = 'rgba(255, 123, 138, 0.32)';
      style.boxShadow = 'inset 0 -1px 0 rgba(255, 123, 138, 0.72)';
    }
    result.push({
      text: props.text.slice(start, end),
      style: Object.keys(style).length > 0 ? style : undefined,
      className,
      cursor: highlight?.kind === 'cursor',
    });
  }

  return result.length > 0 ? result : [{ text: props.text }];
});

const highlightForRange = (highlights: CodeTextHighlight[], start: number, end: number) => {
  return (
    highlights.find((highlight) => highlight.kind === 'cursor' && highlight.startColumn < end && highlight.endColumn > start) ??
    highlights.find((highlight) => highlight.kind === 'active-search' && highlight.startColumn < end && highlight.endColumn > start) ??
    highlights.find((highlight) => highlight.kind === 'search' && highlight.startColumn < end && highlight.endColumn > start) ??
    highlights.find((highlight) => highlight.kind === 'visual' && highlight.startColumn < end && highlight.endColumn > start) ??
    highlights.find((highlight) => highlight.kind === 'review' && highlight.startColumn < end && highlight.endColumn > start) ??
    highlights.find((highlight) => highlight.kind.startsWith('diff-') && highlight.startColumn < end && highlight.endColumn > start)
  );
};

const sortedBoundaries = (textLength: number, spans: VisualSpan[], highlights: NormalizedHighlight[]): number[] => {
  const boundaries = [0, textLength];
  for (const span of spans) {
    boundaries.push(span.startColumn, span.endColumn);
  }
  for (const highlight of highlights) {
    boundaries.push(highlight.startColumn, highlight.endColumn);
  }
  boundaries.sort((a, b) => a - b);

  let writeIndex = 1;
  for (let readIndex = 1; readIndex < boundaries.length; readIndex += 1) {
    if (boundaries[readIndex] === boundaries[writeIndex - 1]) continue;
    boundaries[writeIndex] = boundaries[readIndex];
    writeIndex += 1;
  }
  boundaries.length = writeIndex;
  return boundaries;
};

const bestSpanForRange = (spans: VisualSpan[], start: number, end: number): VisualSpan | undefined => {
  let best: VisualSpan | undefined;

  for (const span of spans) {
    if (span.startColumn > start || span.endColumn < end) continue;
    if (!best || span.priority > best.priority) best = span;
  }

  return best;
};

const isVisualScope = (scope: string): boolean => scope !== 'none' && !scope.startsWith('_');

const scopePriority = (scope: string): number => {
  if (scope === 'none') return -100;

  const normalized = normalizeAlias(scope);
  const depth = normalized.split('.').length;
  const genericPenalty = normalized === 'variable' || normalized === 'constant' ? -10 : 0;
  const punctuationPenalty = normalized.startsWith('punctuation') ? -20 : 0;
  return depth * 10 + genericPenalty + punctuationPenalty;
};

const resolveStyle = (scope: string): SyntaxStyle | undefined => {
  if (scope === 'none') return undefined;

  const colors = settings.syntaxTheme.colors;
  const cachedStyles = styleCacheForColors(colors);
  if (cachedStyles.has(scope)) return cachedStyles.get(scope);

  const style = resolveUncachedStyle(scope, syntaxThemeForColors(colors));
  cachedStyles.set(scope, style);
  return style;
};

const resolveUncachedStyle = (scope: string, syntaxTheme: Record<string, SyntaxStyle>): SyntaxStyle | undefined => {
  if (scope === 'none') return undefined;

  const aliases = [scope, normalizeAlias(scope)];
  for (const alias of aliases) {
    let current = alias;
    while (current.length > 0) {
      const style = syntaxTheme[current];
      if (style) return style;

      const dot = current.lastIndexOf('.');
      if (dot === -1) break;
      current = current.slice(0, dot);
    }
  }

  return syntaxTheme.variable;
};

const styleCacheForColors = (colors: SyntaxThemeColors) => {
  let cache = syntaxStyleCache.get(colors);
  if (!cache) {
    cache = new Map<string, SyntaxStyle | undefined>();
    syntaxStyleCache.set(colors, cache);
  }
  return cache;
};

const syntaxThemeForColors = (colors: SyntaxThemeColors): Record<string, SyntaxStyle> => {
  const cached = syntaxThemeCache.get(colors);
  if (cached) return cached;

  const theme = {
    attribute: { color: colors.type },
    boolean: { color: colors.number, fontWeight: '600' },
    comment: { color: colors.comment, fontStyle: 'italic' },
    'comment.documentation': { color: colors.comment, fontStyle: 'italic' },
    constant: { color: colors.number },
    'constant.builtin': { color: colors.number, fontWeight: '600' },
    constructor: { color: colors.type },
    embedded: { color: colors.text },
    function: { color: colors.function },
    'function.builtin': { color: colors.function, fontWeight: '600' },
    'function.call': { color: colors.function },
    'function.macro': { color: colors.number },
    'function.method': { color: colors.function },
    'function.method.call': { color: colors.function },
    'character.special': { color: colors.string },
    keyword: { color: colors.keyword, fontWeight: '600' },
    'keyword.directive': { color: colors.keyword, fontWeight: '600' },
    'keyword.function': { color: colors.keyword, fontWeight: '600' },
    label: { color: colors.property },
    module: { color: colors.type },
    namespace: { color: colors.type },
    number: { color: colors.number },
    operator: { color: colors.punctuation },
    property: { color: colors.property },
    'property.builtin': { color: colors.property, fontWeight: '600' },
    punctuation: { color: colors.punctuation },
    'punctuation.bracket': { color: colors.punctuation },
    'punctuation.delimiter': { color: colors.punctuation },
    'punctuation.special': { color: colors.punctuation },
    string: { color: colors.string },
    'string.escape': { color: colors.string },
    'string.regexp': { color: colors.string },
    'string.special': { color: colors.string },
    tag: { color: colors.string },
    'tag.attribute': { color: colors.type },
    'tag.builtin': { color: colors.string, fontWeight: '600' },
    'tag.delimiter': { color: colors.punctuation },
    type: { color: colors.type },
    'type.builtin': { color: colors.type },
    variable: { color: colors.text },
    'variable.builtin': { color: colors.number },
    'variable.member': { color: colors.property },
    'variable.parameter': { color: colors.property, fontStyle: 'italic' },
  } satisfies Record<string, SyntaxStyle>;
  syntaxThemeCache.set(colors, theme);
  return theme;
};

const normalizeAlias = (scope: string): string => {
  if (scope === 'field') return 'variable.member';
  if (scope === 'method') return 'function.method';
  if (scope === 'parameter') return 'variable.parameter';
  if (scope === 'string.special.symbol') return 'string.special';
  return scope;
};
</script>

<style scoped lang="scss">
.code {
  min-width: 0;
  margin: 0;
  padding: 0 var(--space-4);
  overflow: hidden;
  color: v-bind('settings.syntaxTheme.colors.text');
  font: inherit;
  line-height: inherit;
  text-overflow: ellipsis;
  white-space: pre;
}

.code-cursor {
  display: inline-block;
  min-width: 0.62em;
  height: var(--line-height-code);
  color: var(--color-bg-code);
  background: var(--color-text-primary);
  line-height: var(--line-height-code);
  vertical-align: top;
}

.code-highlight {
  display: inline-block;
  height: var(--line-height-code);
  line-height: var(--line-height-code);
  vertical-align: top;
}

.code-cursor-end {
  width: 0.62em;
}
</style>
