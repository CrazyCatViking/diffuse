import type { DiffRow, ReviewAnchor, ReviewChatMessage, ReviewThread, SyntaxSide } from '../../lib/protocol';
import type { InlineReviewEntry } from './InlineReviewBox.vue';

export type DisplayRow = {
  kind: 'diff';
  key: string;
  row: DiffRow;
} | InlineReviewEntry;

export type BuildReviewEntriesOptions = {
  fileId: string;
  threads: ReviewThread[];
  chatMessages: ReviewChatMessage[];
  collapsedCommentStarts: ReadonlySet<string>;
  resolvedCommentStarts: ReadonlySet<string>;
  draft?: {
    fileId: string;
    anchor: ReviewAnchor;
    mode: 'comment' | 'chat';
  };
  side?: SyntaxSide;
};

export const commentStartKey = (side: SyntaxSide, line: number) => `${side}:${line}`;

export const selectionChatThreadId = (fileId: string, anchor: ReviewAnchor) => `chat:${fileId}:${anchor.side}:${anchor.startLine}:${anchor.endLine}:${anchor.startColumn ?? ''}:${anchor.endColumn ?? ''}`;

export const buildDisplayRows = (rows: DiffRow[], reviewEntries: Map<string, InlineReviewEntry[]>): DisplayRow[] => {
  const result: DisplayRow[] = [];
  rows.forEach((row, index) => {
    result.push({ kind: 'diff', key: `diff:${index}`, row });
    const oldEntries = row.oldLine ? reviewEntries.get(`old:${row.oldLine}`) ?? [] : [];
    const newEntries = row.newLine ? reviewEntries.get(`new:${row.newLine}`) ?? [] : [];
    result.push(...oldEntries, ...newEntries);
  });
  return result;
};

export const buildReviewEntriesByEndLine = (options: BuildReviewEntriesOptions): Map<string, InlineReviewEntry[]> => {
  const entries = new Map<string, InlineReviewEntry[]>();
  const addEntry = (entry: InlineReviewEntry) => {
    if (options.side && entry.anchor.side !== options.side) return;
    if (entry.kind === 'thread' && options.collapsedCommentStarts.has(commentStartKey(entry.anchor.side, entry.anchor.startLine))) return;
    const key = `${entry.anchor.side}:${entry.anchor.endLine}`;
    entries.set(key, [...entries.get(key) ?? [], entry]);
  };

  for (const thread of options.threads) {
    if (thread.status === 'resolved' && !options.resolvedCommentStarts.has(commentStartKey(thread.anchor.side, thread.anchor.startLine))) continue;
    addEntry({ kind: 'thread', key: `thread:${thread.id}`, anchor: thread.anchor, thread });
  }

  for (const chat of selectionChatEntries(options.fileId, options.chatMessages)) addEntry(chat);

  if (options.draft?.fileId === options.fileId) {
    const anchor = options.draft.anchor;
    addEntry({ kind: 'draft', key: `draft:${options.draft.mode}:${anchor.side}:${anchor.startLine}:${anchor.endLine}`, anchor, mode: options.draft.mode });
  }

  return entries;
};

export const selectionChatEntries = (fileId: string, chatMessages: ReviewChatMessage[]): InlineReviewEntry[] => {
  const seen = new Set<string>();
  const result: InlineReviewEntry[] = [];
  for (const message of chatMessages) {
    const threadId = message.context?.threadIds?.[0];
    const anchor = message.context?.selection;
    if (!threadId?.startsWith('chat:') || !anchor || message.context?.fileId !== fileId || seen.has(threadId)) continue;
    seen.add(threadId);
    result.push({ kind: 'chat', key: threadId, anchor, chatThreadId: threadId });
  }
  return result;
};

export const displayDiffRow = (item?: DisplayRow) => item?.kind === 'diff' ? item.row : undefined;

export const displayReviewRow = (item?: DisplayRow): InlineReviewEntry | undefined => item && item.kind !== 'diff' ? item : undefined;
