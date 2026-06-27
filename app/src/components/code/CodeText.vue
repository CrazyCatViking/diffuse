<template>
  <pre
    class="code"
  ><template v-for="(fragment, index) in fragments" :key="index"><span v-if="fragment.style || fragment.className" :class="fragment.className" :style="fragment.style" :data-diff-cursor="fragment.cursor ? 'true' : undefined">{{ fragment.text }}</span><template v-else>{{ fragment.text }}</template></template><span v-if="endCursorVisible" class="code-cursor code-cursor-end" data-diff-cursor="true">&nbsp;</span></pre>
</template>

<script setup lang="ts">
import { computed, type CSSProperties } from 'vue';
import type { SyntaxSpan } from '../../lib/protocol';
import { useSettingsStore, type SyntaxStyle } from '../../stores/settings';
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

const settings = useSettingsStore();

const syntaxTheme = computed<Record<string, SyntaxStyle>>(() => {
  const colors = settings.syntaxTheme.colors;
  return {
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
  };
});

const cursorHighlight = computed(() => {
  return props.highlights?.find((highlight) => highlight.kind === 'cursor');
});

const endCursorVisible = computed(() => {
  const cursor = cursorHighlight.value;
  return Boolean(cursor && cursor.startColumn >= props.text.length);
});

const fragments = computed<Fragment[]>(() => {
  const result: Fragment[] = [];
  const spans = props.spans
    ? props.spans
        .filter((span) => isVisualScope(span.scope))
        .map((span) => ({
          startColumn: Math.max(0, Math.min(props.text.length, span.startColumn)),
          endColumn: Math.max(0, Math.min(props.text.length, span.endColumn)),
          scope: span.scope,
        }))
        .filter((span) => span.endColumn > span.startColumn)
    : [];
  const highlights = (props.highlights ?? [])
    .map((highlight) => ({
      kind: highlight.kind,
      startColumn: Math.max(0, Math.min(props.text.length, highlight.startColumn)),
      endColumn: Math.max(0, Math.min(props.text.length, highlight.endColumn)),
    }))
    .filter((highlight) => highlight.kind === 'cursor' || highlight.endColumn > highlight.startColumn)
    .filter((highlight) => highlight.kind !== 'cursor' || highlight.startColumn < props.text.length);
  if (spans.length === 0 && highlights.length === 0) return [{ text: props.text }];

  const boundaries = [
    ...new Set([
      0,
      props.text.length,
      ...spans.flatMap((span) => [span.startColumn, span.endColumn]),
      ...highlights.flatMap((highlight) => [highlight.startColumn, highlight.endColumn]),
    ]),
  ].sort((a, b) => a - b);
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;

    const scope = bestScopeForRange(spans, start, end);
    const style: CSSProperties = scope ? { ...resolveStyle(scope) } : {};
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
    highlights.find((highlight) => highlight.kind === 'review' && highlight.startColumn < end && highlight.endColumn > start)
  );
};

const bestScopeForRange = (spans: SyntaxSpan[], start: number, end: number): string | undefined => {
  let best: string | undefined;

  for (const span of spans) {
    if (span.startColumn > start || span.endColumn < end) continue;
    if (!best || scopePriority(span.scope) > scopePriority(best)) best = span.scope;
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

  const aliases = [scope, normalizeAlias(scope)];
  for (const alias of aliases) {
    let current = alias;
    while (current.length > 0) {
      const style = syntaxTheme.value[current];
      if (style) return style;

      const dot = current.lastIndexOf('.');
      if (dot === -1) break;
      current = current.slice(0, dot);
    }
  }

  return syntaxTheme.value.variable;
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
