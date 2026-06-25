import type { DiffRow, LspDiagnostic, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import type { CodeLineModel, CodeTextHighlight } from '../code/codeModels';
import type { DiffCodeRowModel } from './diffViewModels';
import type { ReviewTextHighlight, SearchTextHighlight } from './HighlightedCode.vue';
import type { DisplayRow } from './reviewRows';

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
    diagnosticsForLine: (side: SyntaxSide, line: number | undefined) => LspDiagnostic[];
  },
): RenderedDiffRowFields => {
  const diffRow = item?.kind === 'diff' ? item.row : undefined;
  const oldLine = diffRow?.oldLine;
  const newLine = diffRow?.newLine;
  const oldText = diffRow?.oldText ?? '';
  const newText = diffRow?.newText ?? '';
  const oldReviewHighlights =
    diffRow && oldLine && oldText.length > 0 ? options.reviewHighlightsForLine('old', oldLine, oldText.length) : [];
  const newReviewHighlights =
    diffRow && newLine && newText.length > 0 ? options.reviewHighlightsForLine('new', newLine, newText.length) : [];
  const oldSearchHighlights = diffRow ? (options.searchHighlightsForLine?.('old', oldLine) ?? []) : [];
  const newSearchHighlights = diffRow ? (options.searchHighlightsForLine?.('new', newLine) ?? []) : [];

  const oldSyntaxSpans = oldLine ? options.syntaxSpansForLine('old', oldLine) : undefined;
  const newSyntaxSpans = newLine ? options.syntaxSpansForLine('new', newLine) : undefined;
  const inlineSyntaxSpans =
    diffRow?.kind === 'deleted'
      ? oldLine
        ? options.syntaxSpansForLine('old', oldLine)
        : undefined
      : newLine
        ? options.syntaxSpansForLine('new', newLine)
        : undefined;
  const oldCommentCount = oldLine ? options.commentCountForLine('old', oldLine) : 0;
  const newCommentCount = newLine ? options.commentCountForLine('new', newLine) : 0;
  const oldCommentsExpanded = Boolean(oldLine && options.commentsExpandedForLine('old', oldLine));
  const newCommentsExpanded = Boolean(newLine && options.commentsExpandedForLine('new', newLine));
  const newDiagnostics = options.diagnosticsForLine('new', newLine);
  const oldCodeLine = diffRow
    ? codeLineForSide({
        side: 'old',
        fileId: options.fileId,
        lineNumber: oldLine,
        text: oldText,
        syntaxSpans: oldSyntaxSpans,
        commentCount: oldCommentCount,
        commentsExpanded: oldCommentsExpanded,
        reviewHighlights: oldReviewHighlights,
        searchHighlights: oldSearchHighlights,
        diagnostics: options.diagnosticsForLine('old', oldLine),
        title: 'Add old-side comment',
      })
    : undefined;
  const newCodeLine = diffRow
    ? codeLineForSide({
        side: 'new',
        fileId: options.fileId,
        lineNumber: newLine,
        text: newText,
        syntaxSpans: newSyntaxSpans,
        commentCount: newCommentCount,
        commentsExpanded: newCommentsExpanded,
        reviewHighlights: newReviewHighlights,
        searchHighlights: newSearchHighlights,
        diagnostics: newDiagnostics,
        title: 'Add new-side comment',
      })
    : undefined;
  const inlineSide = diffRow?.kind === 'deleted' ? 'old' : 'new';
  const inlineCodeLine = diffRow
    ? codeLineForSide({
        side: inlineSide,
        fileId: options.fileId,
        lineNumber: inlineSide === 'old' ? oldLine : newLine,
        text: diffRow.oldText ?? diffRow.newText ?? diffRow.text ?? '',
        syntaxSpans: inlineSyntaxSpans,
        commentCount: inlineSide === 'old' ? oldCommentCount : newCommentCount,
        commentsExpanded: inlineSide === 'old' ? oldCommentsExpanded : newCommentsExpanded,
        reviewHighlights: diffRow.kind === 'deleted' ? oldReviewHighlights : newReviewHighlights,
        searchHighlights: diffRow.kind === 'deleted' ? oldSearchHighlights : newSearchHighlights,
        diagnostics: inlineSide === 'new' ? newDiagnostics : options.diagnosticsForLine('old', oldLine),
        title: inlineSide === 'old' ? 'Add old-side comment' : 'Add new-side comment',
      })
    : undefined;

  return {
    item,
    diffRow,
    diff: diffRow
      ? {
          kind: diffRow.kind,
          hunkText: diffRow.hunkHeader ?? diffRow.text,
          oldLine: oldCodeLine,
          newLine: newCodeLine,
          inlineLine: inlineCodeLine,
        }
      : undefined,
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
  diagnostics: LspDiagnostic[];
  title: string;
}): CodeLineModel => ({
  side: options.side,
  fileId: options.fileId,
  lineNumber: options.lineNumber,
  text: options.text,
  syntaxSpans: options.syntaxSpans,
  commentCount: options.commentCount,
  commentsExpanded: options.commentsExpanded,
  diagnostics: options.diagnostics,
  title: options.title,
  highlights: codeHighlights(options.reviewHighlights, options.searchHighlights),
});

const codeHighlights = (reviewHighlights: ReviewTextHighlight[], searchHighlights: SearchTextHighlight[]): CodeTextHighlight[] => [
  ...reviewHighlights.map((highlight) => ({ kind: 'review' as const, startColumn: highlight.startColumn, endColumn: highlight.endColumn })),
  ...searchHighlights.map((highlight) => ({
    kind: highlight.active ? ('active-search' as const) : ('search' as const),
    startColumn: highlight.startColumn,
    endColumn: highlight.endColumn,
  })),
];
