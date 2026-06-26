import type { ParsedSearchFilter, ParsedSearchQuery } from './searchTypes';

const filterPattern = /^([a-zA-Z][\w-]*):(.*)$/;

export const parseSearchQuery = (raw: string): ParsedSearchQuery => {
  const tokens = tokenize(raw.trim());
  const terms: string[] = [];
  const phrases: string[] = [];
  const filters: ParsedSearchFilter[] = [];

  for (const token of tokens) {
    const negated = token.startsWith('-');
    const value = negated ? token.slice(1) : token;
    const filter = filterPattern.exec(value);
    if (filter && filter[2].length > 0) {
      filters.push({ key: filter[1].toLowerCase(), value: filter[2], negated });
      continue;
    }

    if (token.startsWith('"') && token.endsWith('"') && token.length > 1) {
      phrases.push(token.slice(1, -1));
      continue;
    }

    if (token.toUpperCase() === 'NOT') continue;
    terms.push(token);
  }

  return { raw, terms, phrases, filters };
};

const tokenize = (value: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }

    if (/\s/.test(char) && !quoted) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
};
