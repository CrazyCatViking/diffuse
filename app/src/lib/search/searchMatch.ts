import type { SearchFieldMatch, SearchMatchRange } from './searchTypes';

export type TextMatchResult = {
  matched: boolean;
  score: number;
  ranges: SearchMatchRange[];
};

export const normalizeSearchText = (value: string): string => value.toLowerCase();

export const matchText = (value: string, terms: string[]): TextMatchResult => {
  const meaningfulTerms = terms.map((term) => term.trim()).filter(Boolean);
  if (meaningfulTerms.length === 0) return { matched: true, score: 0, ranges: [] };

  let score = 0;
  const ranges: SearchMatchRange[] = [];

  for (const term of meaningfulTerms) {
    const result = matchSingleTerm(value, term);
    if (!result.matched) return { matched: false, score: 0, ranges: [] };
    score += result.score;
    ranges.push(...result.ranges);
  }

  return { matched: true, score, ranges: mergeRanges(ranges) };
};

export const fieldMatch = (field: SearchFieldMatch['field'], value: string, terms: string[], boost = 0): SearchFieldMatch | null => {
  const result = matchText(value, terms);
  if (!result.matched) return null;
  return { field, ranges: result.ranges, score: result.score + boost };
};

const matchSingleTerm = (value: string, term: string): TextMatchResult => {
  const lowerValue = normalizeSearchText(value);
  const lowerTerm = normalizeSearchText(term);
  if (!lowerTerm) return { matched: true, score: 0, ranges: [] };

  const exactIndex = lowerValue.indexOf(lowerTerm);
  if (exactIndex >= 0) {
    const prefixBoost = exactIndex === 0 ? 800 : 0;
    const boundaryBoost = exactIndex > 0 && isBoundary(value[exactIndex - 1]) ? 240 : 0;
    return {
      matched: true,
      score: 1600 + prefixBoost + boundaryBoost - exactIndex,
      ranges: [{ start: exactIndex, end: exactIndex + term.length }],
    };
  }

  const initials = wordInitialRanges(value, lowerTerm);
  if (initials) return { matched: true, score: 980, ranges: initials };

  return fuzzyMatch(value, lowerTerm);
};

const fuzzyMatch = (value: string, lowerTerm: string): TextMatchResult => {
  const lowerValue = normalizeSearchText(value);
  const ranges: SearchMatchRange[] = [];
  let valueIndex = 0;
  let lastMatch = -1;
  let gapPenalty = 0;

  for (const char of lowerTerm) {
    const found = lowerValue.indexOf(char, valueIndex);
    if (found < 0) return { matched: false, score: 0, ranges: [] };
    if (lastMatch >= 0) gapPenalty += Math.max(0, found - lastMatch - 1);
    ranges.push({ start: found, end: found + 1 });
    valueIndex = found + 1;
    lastMatch = found;
  }

  return { matched: true, score: Math.max(120, 620 - gapPenalty * 8), ranges: mergeRanges(ranges) };
};

const wordInitialRanges = (value: string, lowerTerm: string): SearchMatchRange[] | null => {
  const initials: SearchMatchRange[] = [];
  const lowerValue = normalizeSearchText(value);
  let termIndex = 0;

  for (let index = 0; index < value.length && termIndex < lowerTerm.length; index += 1) {
    if (index > 0 && !isBoundary(value[index - 1])) continue;
    if (lowerValue[index] !== lowerTerm[termIndex]) continue;
    initials.push({ start: index, end: index + 1 });
    termIndex += 1;
  }

  return termIndex === lowerTerm.length ? initials : null;
};

const isBoundary = (char: string): boolean => char === '/' || char === '-' || char === '_' || char === '.' || char === ' ';

const mergeRanges = (ranges: SearchMatchRange[]): SearchMatchRange[] => {
  const sorted = [...ranges].sort((first, second) => first.start - second.start || first.end - second.end);
  const merged: SearchMatchRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }

  return merged;
};
