import type { LspDiagnostic, SyntaxSide, SyntaxSpan } from '../../lib/protocol';

export type CodeTextHighlightKind = 'review' | 'search' | 'active-search';

export type CodeTextHighlight = {
  kind: CodeTextHighlightKind;
  startColumn: number;
  endColumn: number;
};

export type CodeLineModel = {
  key?: string;
  fileId?: string;
  side?: SyntaxSide;
  lineNumber?: number;
  text: string;
  syntaxSpans?: SyntaxSpan[];
  highlights?: CodeTextHighlight[];
  diagnostics?: LspDiagnostic[];
  commentCount?: number;
  commentsExpanded?: boolean;
  selectable?: boolean;
  commentable?: boolean;
  title?: string;
  className?: string | string[] | Record<string, boolean>;
};

export type CodeLineCommentPayload = {
  side: SyntaxSide;
  line: number;
  text: string;
  clientX: number;
  clientY: number;
};

export type CodeLineToggleCommentsPayload = {
  side: SyntaxSide;
  line: number;
};
