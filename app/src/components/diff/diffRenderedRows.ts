import type { DiffRow, DiffTokenSpan, LspDiagnostic, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
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
  const oldDiffHighlights = diffHighlights(diffRow.oldDiffSpans);
  const newDiffHighlights = diffHighlights(diffRow.newDiffSpans);

  const lineOptions = (side: SyntaxSide, full: boolean) => {
    const lineNumber = side === 'old' ? oldLine : newLine;
    const text = side === 'old' ? oldText : newText;
    const cursorState = full ? options.cursorStateForLine?.(side, lineNumber, text.length) : undefined;
    return {
      side,
      fileId: options.fileId,
      lineNumber,
      text,
      syntaxSpans: full && lineNumber ? options.syntaxSpansForLine(side, lineNumber) : undefined,
      commentCount: lineNumber ? options.commentCountForLine(side, lineNumber) : 0,
      commentsExpanded: Boolean(lineNumber && options.commentsExpandedForLine(side, lineNumber)),
      reviewHighlights: full && lineNumber && text.length > 0 ? options.reviewHighlightsForLine(side, lineNumber, text.length) : [],
      searchHighlights: full ? (options.searchHighlightsForLine?.(side, lineNumber) ?? []) : [],
      diffHighlights: full ? (side === 'old' ? oldDiffHighlights : newDiffHighlights) : [],
      diagnostics: options.diagnosticsForLine(side, lineNumber),
      title: side === 'old' ? 'Add old-side comment' : 'Add new-side comment',
      cursorHighlights: cursorState?.highlights ?? [],
      className: mergeClassNames(cursorState?.className, full ? diffClassName(diffRow, side) : undefined),
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

const diffHighlights = (spans: DiffTokenSpan[] | undefined): CodeTextHighlight[] =>
  (spans ?? []).map((span) => ({
    kind: diffHighlightKind(span.kind),
    startColumn: span.startColumn,
    endColumn: span.endColumn,
  }));

const diffHighlightKind = (kind: DiffTokenSpan['kind']): CodeTextHighlight['kind'] => {
  if (kind === 'inserted-token') return 'diff-inserted';
  if (kind === 'deleted-token') return 'diff-deleted';
  if (kind === 'whitespace') return 'diff-whitespace';
  return 'diff-replaced';
};

const diffClassName = (row: DiffRow | undefined, side: SyntaxSide): string | undefined => {
  if (!row?.changeRole) return undefined;
  if (row.changeRole === 'moved-from' && side === 'old') return 'diff-moved diff-moved-from';
  if (row.changeRole === 'moved-to' && side === 'new') return 'diff-moved diff-moved-to';
  return undefined;
};

const mergeClassNames = (first: CodeLineModel['className'], second: string | undefined): CodeLineModel['className'] => {
  if (!first) return second;
  if (!second) return first;
  if (typeof first === 'string') return `${first} ${second}`;
  if (Array.isArray(first)) return [...first, second];
  return { ...first, [second]: true };
};
