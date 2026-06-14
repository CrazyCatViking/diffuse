<template>
  <pre class="code"><template v-for="(fragment, index) in fragments" :key="index"><span v-if="fragment.style" :style="fragment.style">{{ fragment.text }}</span><template v-else>{{ fragment.text }}</template></template></pre>
</template>

<script setup lang="ts">
import { computed, type CSSProperties } from 'vue';
import type { SyntaxSpan } from '../../lib/protocol';
import { useSettingsStore, type SyntaxStyle } from '../../stores/settings';

const props = defineProps<{
  text: string;
  spans?: SyntaxSpan[];
  reviewHighlights?: ReviewTextHighlight[];
}>();

export type ReviewTextHighlight = {
  startColumn: number;
  endColumn: number;
};

type Fragment = {
  text: string;
  style?: CSSProperties;
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

const fragments = computed<Fragment[]>(() => {
  const result: Fragment[] = [];
  const spans = props.spans
    ? props.spans
    .filter((span) => isVisualScope(span.scope))
    .map((span) => ({
      startColumn: Math.max(0, Math.min(props.text.length, span.startColumn)),
      endColumn: Math.max(0, Math.min(props.text.length, span.endColumn)),
      scope: span.scope
    }))
    .filter((span) => span.endColumn > span.startColumn)
    : [];
  const highlights = props.reviewHighlights
    ?.map((highlight) => ({
      startColumn: Math.max(0, Math.min(props.text.length, highlight.startColumn)),
      endColumn: Math.max(0, Math.min(props.text.length, highlight.endColumn)),
    }))
    .filter((highlight) => highlight.endColumn > highlight.startColumn) ?? [];
  if (spans.length === 0 && highlights.length === 0) return [{ text: props.text }];

  const boundaries = [...new Set([
    0,
    props.text.length,
    ...spans.flatMap((span) => [span.startColumn, span.endColumn]),
    ...highlights.flatMap((highlight) => [highlight.startColumn, highlight.endColumn]),
  ])].sort((a, b) => a - b);
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;

    const scope = bestScopeForRange(spans, start, end);
    const style: CSSProperties = scope ? { ...resolveStyle(scope) } : {};
    if (isReviewHighlighted(highlights, start, end)) {
      style.background = 'rgba(240, 195, 106, 0.32)';
    }
    result.push({ text: props.text.slice(start, end), style: Object.keys(style).length > 0 ? style : undefined });
  }

  return result.length > 0 ? result : [{ text: props.text }];
});

const isReviewHighlighted = (highlights: ReviewTextHighlight[], start: number, end: number) => {
  return highlights.some((highlight) => highlight.startColumn < end && highlight.endColumn > start);
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
  padding: 0 12px;
  overflow: hidden;
  color: v-bind('settings.syntaxTheme.colors.text');
  font: inherit;
  line-height: inherit;
  text-overflow: ellipsis;
  white-space: pre;
}

</style>
