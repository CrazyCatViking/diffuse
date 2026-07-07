import type { DiffRow, ReviewAnchor, ReviewChatMessage, ReviewThread, SyntaxSide } from '../../lib/protocol';
import type { InlineReviewEntry } from './InlineReviewBox.vue';

export type DisplayRow =
  | {
      kind: 'diff';
      key: string;
      row: DiffRow;
      rowIndex: number;
      pairedRowIndex?: number;
    }
  | InlineReviewEntry;

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

export const selectionChatThreadId = (fileId: string, anchor: ReviewAnchor) =>
  `chat:${fileId}:${anchor.side}:${anchor.startLine}:${anchor.endLine}:${anchor.startColumn ?? ''}:${anchor.endColumn ?? ''}`;

export const buildDisplayRows = (rows: DiffRow[], reviewEntries: Map<string, InlineReviewEntry[]>): DisplayRow[] => {
  const result: DisplayRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row?.kind === 'deleted') {
      const deletedStart = index;
      while (rows[index]?.kind === 'deleted') index += 1;
      const addedStart = index;
      while (rows[index]?.kind === 'added') index += 1;
      if (addedStart > deletedStart && index > addedStart) {
        pushReplacementRun(result, rows, deletedStart, addedStart, index, reviewEntries);
        continue;
      }

      for (let rowIndex = deletedStart; rowIndex < addedStart; rowIndex += 1) {
        const deletedRow = rows[rowIndex];
        if (deletedRow) pushDiffRow(result, deletedRow, rowIndex, undefined, reviewEntries);
      }
      continue;
    }

    if (row) pushDiffRow(result, row, index, undefined, reviewEntries);
    index += 1;
  }
  return result;
};

const pushReplacementRun = (
  result: DisplayRow[],
  rows: DiffRow[],
  deletedStart: number,
  addedStart: number,
  addedEnd: number,
  reviewEntries: Map<string, InlineReviewEntry[]>,
) => {
  const pairCount = Math.min(addedStart - deletedStart, addedEnd - addedStart);
  for (let offset = 0; offset < pairCount; offset += 1) {
    const oldIndex = deletedStart + offset;
    const newIndex = addedStart + offset;
    const oldRow = rows[oldIndex];
    const newRow = rows[newIndex];
    if (oldRow && newRow) {
      pushDiffRow(result, pairedReplacementRow(oldRow, newRow), oldIndex, newIndex, reviewEntries);
    }
  }

  for (let oldIndex = deletedStart + pairCount; oldIndex < addedStart; oldIndex += 1) {
    const oldRow = rows[oldIndex];
    if (oldRow) pushDiffRow(result, oldRow, oldIndex, undefined, reviewEntries);
  }

  for (let newIndex = addedStart + pairCount; newIndex < addedEnd; newIndex += 1) {
    const newRow = rows[newIndex];
    if (newRow) pushDiffRow(result, newRow, newIndex, undefined, reviewEntries);
  }
};

const pushDiffRow = (
  result: DisplayRow[],
  row: DiffRow,
  rowIndex: number,
  pairedRowIndex: number | undefined,
  reviewEntries: Map<string, InlineReviewEntry[]>,
) => {
  result.push({
    kind: 'diff',
    key: pairedRowIndex === undefined ? `diff:${rowIndex}` : `diff:${rowIndex}+${pairedRowIndex}`,
    row,
    rowIndex,
    pairedRowIndex,
  });
  const oldEntries = row.oldLine ? (reviewEntries.get(`old:${row.oldLine}`) ?? []) : [];
  const newEntries = row.newLine ? (reviewEntries.get(`new:${row.newLine}`) ?? []) : [];
  result.push(...oldEntries, ...newEntries);
};

const pairedReplacementRow = (oldRow: DiffRow, newRow: DiffRow): DiffRow => ({
  kind: 'modified',
  oldLine: oldRow.oldLine,
  newLine: newRow.newLine,
  oldText: oldRow.oldText,
  newText: newRow.newText,
  oldSyntaxSpans: oldRow.oldSyntaxSpans,
  newSyntaxSpans: newRow.newSyntaxSpans,
  oldDiffSpans: oldRow.oldDiffSpans,
  newDiffSpans: newRow.newDiffSpans,
  changeGroupId: newRow.changeGroupId ?? oldRow.changeGroupId,
  changeRole: newRow.changeRole ?? oldRow.changeRole,
  changeConfidence: Math.max(oldRow.changeConfidence ?? 0, newRow.changeConfidence ?? 0) || undefined,
  symbol: newRow.symbol ?? oldRow.symbol,
  semanticSummary: [oldRow.semanticSummary, newRow.semanticSummary].filter(Boolean).join('\n') || undefined,
});

export const buildReviewEntriesByEndLine = (options: BuildReviewEntriesOptions): Map<string, InlineReviewEntry[]> => {
  const entries = new Map<string, InlineReviewEntry[]>();
  const addEntry = (entry: InlineReviewEntry) => {
    if (options.side && entry.anchor.side !== options.side) return;
    if (entry.kind === 'thread' && options.collapsedCommentStarts.has(commentStartKey(entry.anchor.side, entry.anchor.startLine))) return;
    const key = `${entry.anchor.side}:${entry.anchor.endLine}`;
    entries.set(key, [...(entries.get(key) ?? []), entry]);
  };

  for (const thread of options.threads) {
    if (thread.status === 'resolved' && !options.resolvedCommentStarts.has(commentStartKey(thread.anchor.side, thread.anchor.startLine)))
      continue;
    addEntry({ kind: 'thread', key: `thread:${thread.id}`, anchor: thread.anchor, thread });
  }

  for (const chat of selectionChatEntries(options.fileId, options.chatMessages)) addEntry(chat);

  if (options.draft?.fileId === options.fileId) {
    const anchor = options.draft.anchor;
    addEntry({
      kind: 'draft',
      key: `draft:${options.draft.mode}:${anchor.side}:${anchor.startLine}:${anchor.endLine}`,
      anchor,
      mode: options.draft.mode,
    });
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

export const displayDiffRow = (item?: DisplayRow) => (item?.kind === 'diff' ? item.row : undefined);

export const displayReviewRow = (item?: DisplayRow): InlineReviewEntry | undefined => (item && item.kind !== 'diff' ? item : undefined);
