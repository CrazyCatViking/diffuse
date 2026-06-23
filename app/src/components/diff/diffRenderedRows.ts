import type { DiffRow, LspDiagnostic, SyntaxSide, SyntaxSpan } from '../../lib/protocol';
import type { ReviewTextHighlight, SearchTextHighlight } from './HighlightedCode.vue';
import type { DisplayRow } from './reviewRows';

export type RenderedDiffRowFields = {
  item?: DisplayRow;
  diffRow?: DiffRow;
  oldSyntaxSpans?: SyntaxSpan[];
  newSyntaxSpans?: SyntaxSpan[];
  inlineSyntaxSpans?: SyntaxSpan[];
  oldCommentCount: number;
  newCommentCount: number;
  oldCommentsExpanded: boolean;
  newCommentsExpanded: boolean;
  oldReviewHighlights: ReviewTextHighlight[];
  newReviewHighlights: ReviewTextHighlight[];
  inlineReviewHighlights: ReviewTextHighlight[];
  oldSearchHighlights: SearchTextHighlight[];
  newSearchHighlights: SearchTextHighlight[];
  inlineSearchHighlights: SearchTextHighlight[];
  newDiagnostics: LspDiagnostic[];
};

export const buildRenderedDiffRowFields = (
  item: DisplayRow | undefined,
  options: {
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

  return {
    item,
    diffRow,
    oldSyntaxSpans: oldLine ? options.syntaxSpansForLine('old', oldLine) : undefined,
    newSyntaxSpans: newLine ? options.syntaxSpansForLine('new', newLine) : undefined,
    inlineSyntaxSpans:
      diffRow?.kind === 'deleted'
        ? oldLine
          ? options.syntaxSpansForLine('old', oldLine)
          : undefined
        : newLine
          ? options.syntaxSpansForLine('new', newLine)
          : undefined,
    oldCommentCount: oldLine ? options.commentCountForLine('old', oldLine) : 0,
    newCommentCount: newLine ? options.commentCountForLine('new', newLine) : 0,
    oldCommentsExpanded: Boolean(oldLine && options.commentsExpandedForLine('old', oldLine)),
    newCommentsExpanded: Boolean(newLine && options.commentsExpandedForLine('new', newLine)),
    oldReviewHighlights,
    newReviewHighlights,
    inlineReviewHighlights: diffRow?.kind === 'deleted' ? oldReviewHighlights : newReviewHighlights,
    oldSearchHighlights,
    newSearchHighlights,
    inlineSearchHighlights: diffRow?.kind === 'deleted' ? oldSearchHighlights : newSearchHighlights,
    newDiagnostics: options.diagnosticsForLine('new', newLine),
  };
};
