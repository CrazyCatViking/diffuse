import type { CSSProperties } from 'vue';
import type { DiffRow, ReviewAnchor, ReviewChatMessage, ReviewThread, SyntaxSide } from '../../lib/protocol';
import type { CodeLineCommentPayload, CodeLineModel, CodeLineToggleCommentsPayload } from '../code/codeModels';
import type { DiffScrollMarker } from './DiffScrollbar.vue';
import type { InlineReviewEntry } from './InlineReviewBox.vue';

export type DiffPaneKey = 'left' | 'right' | 'syncedSplit' | 'inline';

export type DiffVirtualRow = {
  index: number;
  key: unknown;
  start: number;
};

export type DiffCodeRowModel = {
  kind: DiffRow['kind'];
  hunkText?: string;
  oldLine?: CodeLineModel;
  newLine?: CodeLineModel;
  inlineLine?: CodeLineModel;
};

export type DiffRenderedEntry = {
  virtualRow: DiffVirtualRow;
  diffRow?: DiffRow;
  diff?: DiffCodeRowModel;
  reviewRow?: InlineReviewEntry;
  reviewFocused?: boolean;
};

export type DiffPaneModel = {
  key: DiffPaneKey;
  compositionMode: 'split' | 'inline' | 'pane';
  paneSide?: SyntaxSide;
  rows: DiffRenderedEntry[];
  totalSize: number;
  hasScroll: boolean;
  markers: DiffScrollMarker[];
  thumbStyle: CSSProperties;
  shellClass?: string | string[] | Record<string, boolean>;
  paneClass?: string | string[] | Record<string, boolean>;
  spacerClass?: string | string[] | Record<string, boolean>;
  keyPrefix?: string;
  measureElement: (element: unknown) => void;
};

export type DiffReviewUi = {
  draftBody: string;
  error?: string;
  flashingThreadId?: string;
  chatMessagesForEntry: (entry: InlineReviewEntry) => ReviewChatMessage[];
  agentRespondingForEntry: (entry: InlineReviewEntry) => boolean;
};

export type DiffReviewActions = {
  updateDraftBody: (value: string) => void;
  submit: () => void;
  submitChatDraft: () => void;
  cancel: () => void;
  reply: (payload: { thread: ReviewThread; body: string }) => void;
  chat: (payload: { thread: ReviewThread; body: string }) => void;
  collapse: (anchor: ReviewAnchor) => void;
  resolve: (thread: ReviewThread) => void;
  reopen: (thread: ReviewThread) => void;
};

export type DiffPaneActions = {
  paneRef: (pane: DiffPaneKey, element: Element | null) => void;
  scroll: (pane: DiffPaneKey, event: Event) => void;
  pointerMove: (event: PointerEvent) => void;
  mouseLeave: () => void;
  mouseUp: (event: MouseEvent) => void;
  scrollbarTrackPointerDown: (event: PointerEvent, pane: DiffPaneKey) => void;
  scrollbarThumbPointerDown: (event: PointerEvent, pane: DiffPaneKey) => void;
  comment: (payload: CodeLineCommentPayload) => void;
  toggleComments: (payload: CodeLineToggleCommentsPayload) => void;
};
