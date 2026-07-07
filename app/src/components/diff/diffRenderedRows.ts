import type { DiffRow, LspDiagnostic, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import type { CodeLineModel, CodeTextHighlight } from '../code/codeModels';
import type { DiffCodeRowModel } from './diffViewModels';
import type { ReviewTextHighlight, SearchTextHighlight } from './HighlightedCode.vue';
import type { DisplayRow } from './reviewRows';

export type DiffRowRenderTarget = 'all' | 'split' | 'inline' | SyntaxSide;

export type RenderedDiffRowFields = {
  item?: DisplayRow;
  diffRow?: DiffRow;
  diff?: DiffCodeRowModel;
};

export const buildRenderedDiffRowFields = (
  item: DisplayRow | undefined,
  options: {
    fileId?: string;
    syntaxSpansForLine: (side: SyntaxSide, line: number) => SyntaxSpan[] | undefined;
    commentCountForLine: (side: SyntaxSide, line: number) => number;
    commentsExpandedForLine: (side: SyntaxSide, line: number) => boolean;
    reviewHighlightsForLine: (side: SyntaxSide, line: number, textLength: number) => ReviewTextHighlight[];
    searchHighlightsForLine?: (side: SyntaxSide, line: number | undefined) => SearchTextHighlight[];
    cursorStateForLine?: (
      side: SyntaxSide,
      line: number | undefined,
      textLength: number,
    ) => Pick<CodeLineModel, 'highlights' | 'className'>;
    diagnosticsForLine: (side: SyntaxSide, line: number | undefined) => LspDiagnostic[];
    renderTarget?: DiffRowRenderTarget;
  },
): RenderedDiffRowFields => {
  const diffRow = item?.kind === 'diff' ? item.row : undefined;
  if (!diffRow) return { item };
  if (diffRow.kind === 'hunk') {
    return {
      item,
      diffRow,
      diff: {
        kind: diffRow.kind,
        hunkText: diffRow.hunkHeader ?? diffRow.text,
      },
    };
  }

  const oldLine = diffRow.oldLine;
  const newLine = diffRow.newLine;
  const oldText = diffRow.oldText ?? '';
  const newText = diffRow.newText ?? '';
  const renderTarget = options.renderTarget ?? 'all';
  const needsOldLine = renderTarget === 'all' || renderTarget === 'split' || renderTarget === 'old';
  const needsNewLine = renderTarget === 'all' || renderTarget === 'split' || renderTarget === 'new';
  const needsInlineLine = renderTarget === 'all' || renderTarget === 'inline';
  const inlineSide = diffRow.kind === 'deleted' ? 'old' : 'new';
  const oldLineIsInlineMetadata = renderTarget === 'inline' && inlineSide !== 'old' && oldLine !== undefined;
  const newLineIsInlineMetadata = renderTarget === 'inline' && inlineSide !== 'new' && newLine !== undefined;
  const tokenHighlights = inlineDiffHighlights(diffRow, oldText, newText);

  const lineOptions = (side: SyntaxSide, full: boolean) => {
    const lineNumber = side === 'old' ? oldLine : newLine;
    const text = side === 'old' ? oldText : newText;
    const hasLine = lineNumber !== undefined;
    const hasFullLine = full && hasLine;
    const cursorState = hasFullLine ? options.cursorStateForLine?.(side, lineNumber, text.length) : undefined;
    return {
      side,
      fileId: options.fileId,
      lineNumber,
      text,
      syntaxSpans: hasFullLine ? options.syntaxSpansForLine(side, lineNumber) : undefined,
      commentCount: lineNumber ? options.commentCountForLine(side, lineNumber) : 0,
      commentsExpanded: Boolean(lineNumber && options.commentsExpandedForLine(side, lineNumber)),
      reviewHighlights: hasFullLine && text.length > 0 ? options.reviewHighlightsForLine(side, lineNumber, text.length) : [],
      searchHighlights: hasFullLine ? (options.searchHighlightsForLine?.(side, lineNumber) ?? []) : [],
      diffHighlights: hasFullLine ? (side === 'old' ? tokenHighlights.old : tokenHighlights.new) : [],
      diagnostics: hasFullLine ? options.diagnosticsForLine(side, lineNumber) : [],
      title: side === 'old' ? 'Add old-side comment' : 'Add new-side comment',
      cursorHighlights: cursorState?.highlights ?? [],
      className: cursorState?.className,
    };
  };

  const oldCodeLine = needsOldLine || oldLineIsInlineMetadata ? codeLineForSide(lineOptions('old', needsOldLine)) : undefined;
  const newCodeLine = needsNewLine || newLineIsInlineMetadata ? codeLineForSide(lineOptions('new', needsNewLine)) : undefined;
  const inlineCodeLine = needsInlineLine ? codeLineForSide(lineOptions(inlineSide, true)) : undefined;

  return {
    item,
    diffRow,
    diff: {
      kind: diffRow.kind,
      hunkText: diffRow.hunkHeader ?? diffRow.text,
      oldLine: inlineSide === 'old' && inlineCodeLine ? inlineCodeLine : oldCodeLine,
      newLine: inlineSide === 'new' && inlineCodeLine ? inlineCodeLine : newCodeLine,
      inlineLine: inlineCodeLine,
    },
  };
};

const codeLineForSide = (options: {
  side: SyntaxSide;
  fileId?: string;
  lineNumber?: number;
  text: string;
  syntaxSpans?: SyntaxSpan[];
  commentCount: number;
  commentsExpanded: boolean;
  reviewHighlights: ReviewTextHighlight[];
  searchHighlights: SearchTextHighlight[];
  diffHighlights: CodeTextHighlight[];
  diagnostics: LspDiagnostic[];
  title: string;
  cursorHighlights: CodeTextHighlight[];
  className?: CodeLineModel['className'];
}): CodeLineModel => {
  const highlights = codeHighlights(options.reviewHighlights, options.searchHighlights, options.diffHighlights, options.cursorHighlights);
  return {
    side: options.side,
    fileId: options.fileId,
    lineNumber: options.lineNumber,
    text: options.text,
    syntaxSpans: options.syntaxSpans,
    commentCount: options.commentCount,
    commentsExpanded: options.commentsExpanded,
    diagnostics: options.diagnostics,
    title: options.title,
    className: options.className,
    highlights: highlights.length > 0 ? highlights : undefined,
  };
};

const codeHighlights = (
  reviewHighlights: ReviewTextHighlight[],
  searchHighlights: SearchTextHighlight[],
  diffHighlights: CodeTextHighlight[],
  cursorHighlights: CodeTextHighlight[],
): CodeTextHighlight[] => [
  ...diffHighlights,
  ...reviewHighlights.map((highlight) => ({ kind: 'review' as const, startColumn: highlight.startColumn, endColumn: highlight.endColumn })),
  ...searchHighlights.map((highlight) => ({
    kind: highlight.active ? ('active-search' as const) : ('search' as const),
    startColumn: highlight.startColumn,
    endColumn: highlight.endColumn,
  })),
  ...cursorHighlights,
];

type InlineDiffHighlights = {
  old: CodeTextHighlight[];
  new: CodeTextHighlight[];
};

type TextToken = {
  text: string;
  startColumn: number;
  endColumn: number;
};

type TokenMatch = {
  oldIndex: number;
  newIndex: number;
};

const inlineDiffHighlights = (row: DiffRow, oldText: string, newText: string): InlineDiffHighlights => {
  if (row.kind !== 'modified' || !oldText.trim() || !newText.trim()) return emptyInlineDiffHighlights();

  const oldTokens = diffTokens(oldText);
  const newTokens = diffTokens(newText);
  if (oldTokens.length === 0 || newTokens.length === 0) return emptyInlineDiffHighlights();

  const oldHighlights: CodeTextHighlight[] = [];
  const newHighlights: CodeTextHighlight[] = [];
  const matches = tokenMatches(oldTokens, newTokens);
  let oldIndex = 0;
  let newIndex = 0;

  for (const match of [...matches, { oldIndex: oldTokens.length, newIndex: newTokens.length }]) {
    appendChangedTokenGroup(
      oldTokens.slice(oldIndex, match.oldIndex),
      newTokens.slice(newIndex, match.newIndex),
      oldHighlights,
      newHighlights,
    );
    oldIndex = match.oldIndex + 1;
    newIndex = match.newIndex + 1;
  }

  return filteredInlineDiffHighlights(oldText, newText, oldHighlights, newHighlights);
};

const emptyInlineDiffHighlights = (): InlineDiffHighlights => ({ old: [], new: [] });

const diffTokens = (text: string): TextToken[] => {
  const tokens: TextToken[] = [];
  const pattern = /[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const startColumn = match.index ?? 0;
    tokens.push({
      text: token,
      startColumn,
      endColumn: startColumn + token.length,
    });
  }
  return tokens;
};

const tokenMatches = (oldTokens: TextToken[], newTokens: TextToken[]): TokenMatch[] => {
  const width = newTokens.length + 1;
  const table = new Array<number>((oldTokens.length + 1) * (newTokens.length + 1)).fill(0);

  for (let oldIndex = 1; oldIndex <= oldTokens.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newTokens.length; newIndex += 1) {
      const cell = oldIndex * width + newIndex;
      table[cell] =
        oldTokens[oldIndex - 1].text === newTokens[newIndex - 1].text
          ? table[(oldIndex - 1) * width + (newIndex - 1)] + 1
          : Math.max(table[(oldIndex - 1) * width + newIndex], table[oldIndex * width + (newIndex - 1)]);
    }
  }

  const matches: TokenMatch[] = [];
  let oldIndex = oldTokens.length;
  let newIndex = newTokens.length;
  while (oldIndex > 0 && newIndex > 0) {
    if (oldTokens[oldIndex - 1].text === newTokens[newIndex - 1].text) {
      matches.push({ oldIndex: oldIndex - 1, newIndex: newIndex - 1 });
      oldIndex -= 1;
      newIndex -= 1;
    } else if (table[(oldIndex - 1) * width + newIndex] >= table[oldIndex * width + (newIndex - 1)]) {
      oldIndex -= 1;
    } else {
      newIndex -= 1;
    }
  }
  return matches.reverse();
};

const appendChangedTokenGroup = (
  oldTokens: TextToken[],
  newTokens: TextToken[],
  oldHighlights: CodeTextHighlight[],
  newHighlights: CodeTextHighlight[],
) => {
  if (oldTokens.length === 0 && newTokens.length === 0) return;
  for (const token of oldTokens) appendTokenHighlight(oldHighlights, token, 'diff-deleted');
  for (const token of newTokens) appendTokenHighlight(newHighlights, token, 'diff-inserted');
};

const appendTokenHighlight = (highlights: CodeTextHighlight[], token: TextToken, kind: CodeTextHighlight['kind']) => {
  highlights.push({ kind, startColumn: token.startColumn, endColumn: token.endColumn });
};

const filteredInlineDiffHighlights = (
  oldText: string,
  newText: string,
  oldHighlights: CodeTextHighlight[],
  newHighlights: CodeTextHighlight[],
): InlineDiffHighlights => {
  const oldMerged = mergeHighlights(oldHighlights);
  const newMerged = mergeHighlights(newHighlights);
  if (oldMerged.length === 0 && newMerged.length === 0) return emptyInlineDiffHighlights();
  if (!hasHighlightedWord(oldText, oldMerged) && !hasHighlightedWord(newText, newMerged)) return emptyInlineDiffHighlights();
  if (spansCoverWholeContent(oldMerged, oldText) && spansCoverWholeContent(newMerged, newText)) return emptyInlineDiffHighlights();

  const oldCoverage = changedCoverageRatio(oldMerged, oldText);
  const newCoverage = changedCoverageRatio(newMerged, newText);
  if (oldCoverage >= 0.72 && newCoverage >= 0.72) return emptyInlineDiffHighlights();
  if (stableContentLength(oldMerged, oldText) + stableContentLength(newMerged, newText) < 3) return emptyInlineDiffHighlights();

  return { old: oldMerged, new: newMerged };
};

const mergeHighlights = (highlights: CodeTextHighlight[]): CodeTextHighlight[] => {
  const sorted = [...highlights]
    .filter((highlight) => highlight.endColumn > highlight.startColumn)
    .sort((first, second) => first.startColumn - second.startColumn || first.endColumn - second.endColumn);
  const merged: CodeTextHighlight[] = [];
  for (const highlight of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && previous.kind === highlight.kind && highlight.startColumn <= previous.endColumn) {
      previous.endColumn = Math.max(previous.endColumn, highlight.endColumn);
    } else {
      merged.push({ ...highlight });
    }
  }
  return merged;
};

const hasHighlightedWord = (text: string, highlights: CodeTextHighlight[]) => {
  return highlights.some((highlight) => /[\p{L}\p{N}_]/u.test(text.slice(highlight.startColumn, highlight.endColumn)));
};

const spansCoverWholeContent = (spans: CodeTextHighlight[], text: string) => {
  const contentStart = text.search(/\S/);
  if (contentStart === -1) return true;
  const contentEnd = lastNonWhitespaceColumn(text) + 1;
  let coveredUntil = contentStart;

  for (const span of spans) {
    const start = Math.max(contentStart, span.startColumn);
    const end = Math.min(contentEnd, span.endColumn);
    if (end <= start) continue;
    if (start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, end);
    if (coveredUntil >= contentEnd) return true;
  }

  return false;
};

const changedCoverageRatio = (spans: CodeTextHighlight[], text: string) => {
  const total = nonWhitespaceLength(text);
  if (total === 0) return 1;
  return nonWhitespaceLengthForSpans(spans, text) / total;
};

const stableContentLength = (spans: CodeTextHighlight[], text: string) => {
  return Math.max(0, nonWhitespaceLength(text) - nonWhitespaceLengthForSpans(spans, text));
};

const nonWhitespaceLengthForSpans = (spans: CodeTextHighlight[], text: string) => {
  let count = 0;
  for (const span of spans) count += nonWhitespaceLength(text.slice(span.startColumn, span.endColumn));
  return count;
};

const nonWhitespaceLength = (text: string) => text.replace(/\s/gu, '').length;

const lastNonWhitespaceColumn = (text: string) => {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (!/\s/.test(text[index])) return index;
  }
  return -1;
};
