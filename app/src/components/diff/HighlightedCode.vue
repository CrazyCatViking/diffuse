<template>
  <pre class="code"><template v-for="(fragment, index) in fragments" :key="index"><span v-if="fragment.style" :style="fragment.style">{{ fragment.text }}</span><template v-else>{{ fragment.text }}</template></template></pre>
</template>

<script setup lang="ts">
import { computed, type CSSProperties } from 'vue';
import type { SyntaxSpan } from '../../lib/protocol';

const props = defineProps<{
  text: string;
  spans?: SyntaxSpan[];
}>();

type Fragment = {
  text: string;
  style?: CSSProperties;
};

type SyntaxStyle = Pick<CSSProperties, 'color' | 'fontStyle' | 'fontWeight' | 'textDecoration'>;

const syntaxTheme: Record<string, SyntaxStyle> = {
  attribute: { color: '#ffa657' },
  boolean: { color: '#ffab70', fontWeight: '600' },
  comment: { color: '#8b95a8', fontStyle: 'italic' },
  'comment.documentation': { color: '#9fb0c8', fontStyle: 'italic' },
  constant: { color: '#79c0ff' },
  'constant.builtin': { color: '#ffab70', fontWeight: '600' },
  constructor: { color: '#ffa657' },
  embedded: { color: '#e6edf3' },
  function: { color: '#d2a8ff' },
  'function.builtin': { color: '#c297ff', fontWeight: '600' },
  'function.call': { color: '#d2a8ff' },
  'function.macro': { color: '#ffab70' },
  'function.method': { color: '#a5d6ff' },
  'function.method.call': { color: '#a5d6ff' },
  'character.special': { color: '#56d4dd' },
  keyword: { color: '#ff7bcb', fontWeight: '600' },
  'keyword.directive': { color: '#ff7bcb', fontWeight: '600' },
  'keyword.function': { color: '#ff7bcb', fontWeight: '600' },
  label: { color: '#f0b7ff' },
  module: { color: '#f2cc60' },
  namespace: { color: '#f2cc60' },
  number: { color: '#f2cc60' },
  operator: { color: '#79c0ff' },
  property: { color: '#58a6ff' },
  'property.builtin': { color: '#58a6ff', fontWeight: '600' },
  punctuation: { color: '#9aa7b8' },
  'punctuation.bracket': { color: '#8b949e' },
  'punctuation.delimiter': { color: '#8b949e' },
  'punctuation.special': { color: '#79c0ff' },
  string: { color: '#7ee787' },
  'string.escape': { color: '#56d4dd' },
  'string.regexp': { color: '#56d4dd' },
  'string.special': { color: '#56d4dd' },
  tag: { color: '#7ee787' },
  'tag.attribute': { color: '#ffa657' },
  'tag.builtin': { color: '#7ee787', fontWeight: '600' },
  'tag.delimiter': { color: '#9aa7b8' },
  type: { color: '#ffa657' },
  'type.builtin': { color: '#ffdf5d' },
  variable: { color: '#e6edf3' },
  'variable.builtin': { color: '#ffab70' },
  'variable.member': { color: '#58a6ff' },
  'variable.parameter': { color: '#f0b7ff', fontStyle: 'italic' },
};

const fragments = computed<Fragment[]>(() => {
  if (!props.spans?.length) return [{ text: props.text }];

  const result: Fragment[] = [];
  const spans = props.spans
    .filter((span) => isVisualScope(span.scope))
    .map((span) => ({
      startColumn: Math.max(0, Math.min(props.text.length, span.startColumn)),
      endColumn: Math.max(0, Math.min(props.text.length, span.endColumn)),
      scope: span.scope
    }))
    .filter((span) => span.endColumn > span.startColumn);
  if (spans.length === 0) return [{ text: props.text }];

  const boundaries = [...new Set([0, props.text.length, ...spans.flatMap((span) => [span.startColumn, span.endColumn])])].sort((a, b) => a - b);
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;

    const scope = bestScopeForRange(spans, start, end);
    result.push({ text: props.text.slice(start, end), style: scope ? resolveStyle(scope) : undefined });
  }

  return result.length > 0 ? result : [{ text: props.text }];
});

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
      const style = syntaxTheme[current];
      if (style) return style;

      const dot = current.lastIndexOf('.');
      if (dot === -1) break;
      current = current.slice(0, dot);
    }
  }

  return syntaxTheme.variable;
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
  color: #d7deea;
  font: inherit;
  line-height: inherit;
  text-overflow: ellipsis;
  white-space: pre;
}

</style>
