import { computed, ref, watch } from 'vue';
import { diffKeyTokenForEvent, parseDiffKeybinding, type DiffKeybindingAction, type DiffKeybindingMap } from '../../lib/diffKeybindings';
import type { DiffRenderModel, DiffRow, DiffViewMode, LspDiagnostic, ReviewAnchor, SyntaxSide } from '../../lib/protocol';
import type { DiffSurface } from '../../stores/cursor';
import type { CodeLineModel, CodeTextHighlight } from '../code/codeModels';
import type { DisplayRow } from './reviewRows';

export type DiffCursorPane = 'left' | 'right' | 'syncedSplit' | 'inline';

export type DiffCursorMode = 'normal' | 'visual-char' | 'visual-line';

export type DiffCursorPosition = {
  target: 'code' | 'review';
  fileId: string;
  side: SyntaxSide;
  line: number;
  column: number;
  rowIndex: number;
  displayIndex: number;
  pane: DiffCursorPane;
  text: string;
  kind: DiffRow['kind'] | 'review';
  reviewKey?: string;
};

export type DiffCursorSearchMatch = {
  rowIndex: number;
  side: SyntaxSide;
  line: number;
  startColumn: number;
  endColumn: number;
};

type DiffCursorLine = DiffCursorPosition;

type ParsedBinding = {
  action: DiffKeybindingAction;
  tokens: string[];
};

export const useDiffCursor = (options: {
  model: () => DiffRenderModel | undefined;
  viewMode: () => DiffViewMode;
  syncScroll: () => boolean;
  keybindings: () => DiffKeybindingMap;
  displayRows: (side?: SyntaxSide) => DisplayRow[];
  diagnostics: () => LspDiagnostic[];
  diffTargetFingerprint: () => string;
  halfPageLines: () => number;
  shouldRestoreStoredPosition?: () => boolean;
  onOpenFile?: (fileId: string) => void;
  onMoveSurface?: (direction: -1 | 1) => void;
  onOpenSearch: () => void;
  onMoveSearch: (direction: number) => void;
  onHover: (position: DiffCursorPosition) => void;
  onComment: (anchor: ReviewAnchor) => void;
  onAskAi: (anchor: ReviewAnchor) => void;
  onClear: () => void;
  onMove?: (position: DiffCursorPosition) => void;
}) => {
  const cursor = ref<DiffCursorPosition>();
  const desiredColumn = ref(0);
  const mode = ref<DiffCursorMode>('normal');
  const visualStart = ref<DiffCursorPosition>();
  const pendingTokens = ref<string[]>([]);
  const countDigits = ref('');
  const savedPositions = new Map<string, DiffCursorPosition>();
  const jumpHistory = ref<DiffCursorPosition[]>([]);
  const jumpHistoryIndex = ref(-1);
  const pendingHistoryPosition = ref<DiffCursorPosition>();
  let restoringHistory = false;

  const visualAnchor = computed<ReviewAnchor | undefined>(() => {
    if (
      mode.value === 'normal' ||
      !visualStart.value ||
      !cursor.value ||
      visualStart.value.target !== 'code' ||
      cursor.value.target !== 'code' ||
      visualStart.value.side !== cursor.value.side
    )
      return undefined;
    return buildVisualAnchor(visualStart.value, cursor.value, mode.value);
  });

  const ensureCursor = () => {
    const model = options.model();
    if (!model || model.rows.length === 0) {
      cursor.value = undefined;
      visualStart.value = undefined;
      mode.value = 'normal';
      return;
    }

    const current = cursor.value;
    const openingDifferentFile = current?.fileId !== model.fileId;
    if (current && current.fileId !== model.fileId && !restoringHistory) pushJumpHistory(current);

    if (current?.fileId === model.fileId) {
      const refreshed = refreshPosition(current);
      if (refreshed) {
        cursor.value = refreshed;
        savedPositions.set(model.fileId, refreshed);
        return;
      }
    }

    const pending = pendingHistoryPosition.value;
    if (pending?.fileId === model.fileId) {
      const refreshed = refreshPosition(pending);
      pendingHistoryPosition.value = undefined;
      restoringHistory = false;
      if (refreshed) {
        setCursor(refreshed, refreshed.column, true, refreshed.column, { history: false });
        return;
      }
    }

    const stored = options.shouldRestoreStoredPosition?.() === false ? undefined : savedPositions.get(model.fileId);
    if (stored) {
      const refreshed = refreshPosition(stored);
      if (refreshed) {
        setCursor(refreshed, refreshed.column, false, refreshed.column, { history: false });
        if (openingDifferentFile) pushJumpHistory(refreshed);
        return;
      }
    }

    const first = initialLine(model);
    if (!first) {
      cursor.value = undefined;
      return;
    }

    setCursor(first, Math.min(desiredColumn.value, maxCursorColumn(first.text)), true, undefined, { history: false });
    if (openingDifferentFile) pushJumpHistory(first);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const token = diffKeyTokenForEvent(event);
    if (!token) return false;

    if (token === '<Esc>') {
      return executeBindingToken(token, event);
    }

    if (pendingTokens.value.length === 0 && /^[1-9]$/.test(token)) {
      countDigits.value += token;
      event.preventDefault();
      return true;
    }

    if (pendingTokens.value.length === 0 && token === '0' && countDigits.value.length > 0) {
      countDigits.value += token;
      event.preventDefault();
      return true;
    }

    return executeBindingToken(token, event);
  };

  const moveCursorToSearchMatch = (match: DiffCursorSearchMatch | undefined) => {
    if (!match) return;
    const target = lineForSearchMatch(match);
    if (!target) return;

    setCursor(target, clampColumn(match.startColumn, target.text), true);
  };

  const moveCursorToLine = (side: SyntaxSide, line: number, column: number) => {
    const target = sideLines(side).find((item) => item.line === line);
    if (!target) return false;

    clearVisual();
    setCursor(target, clampColumn(column, target.text), true, column);
    return true;
  };

  const moveCursorToReviewKey = (reviewKey: string) => {
    const target = reviewEntries().find((entry) => entry.reviewKey === reviewKey);
    if (!target) return false;

    clearVisual();
    setCursor(target, 0, true, 0);
    return true;
  };

  const moveCursorToSurfacePosition = (position: DiffSurface['position']) => {
    if (position.target === 'review' && position.reviewKey) {
      return moveCursorToReviewKey(position.reviewKey);
    }

    return moveCursorToLine(position.side, position.line, position.column);
  };

  const currentSurfacePosition = (): DiffSurface['position'] | undefined => {
    const active = cursor.value;
    if (!active) return undefined;

    return {
      fileId: active.fileId,
      pane: active.pane === 'left' ? 'old' : active.pane === 'right' ? 'new' : active.pane === 'syncedSplit' ? active.side : 'inline',
      side: active.side,
      line: active.line,
      column: active.column,
      rowIndex: active.rowIndex,
      displayIndex: active.displayIndex,
      target: active.target,
      reviewKey: active.reviewKey,
    };
  };

  const moveCursorToPane = (pane: DiffCursorPane) => {
    ensureCursor();
    const active = cursor.value;
    if (!active) return false;

    const target = lineForPane(pane, active);
    if (!target) return false;

    clearVisual();
    setCursor(target, Math.min(desiredColumn.value, maxCursorColumn(target.text)), true, desiredColumn.value);
    return true;
  };

  const isReviewFocused = (reviewKey: string) => cursor.value?.target === 'review' && cursor.value.reviewKey === reviewKey;

  const lineStateForLine = (
    side: SyntaxSide,
    line: number | undefined,
    textLength: number,
  ): Pick<CodeLineModel, 'highlights' | 'className'> => {
    if (!line) return {};

    const highlights: CodeTextHighlight[] = [];
    const active = cursor.value;
    const className = active?.target === 'code' && active.side === side && active.line === line ? 'cursor-line' : undefined;
    if (active?.target === 'code' && active.side === side && active.line === line) {
      const column = Math.max(0, Math.min(textLength, active.column));
      highlights.push({ kind: 'cursor', startColumn: column, endColumn: Math.min(textLength, column + 1) });
    }

    return {
      highlights,
      className,
    };
  };

  const currentLineAnchor = (): ReviewAnchor | undefined => {
    const active = cursor.value;
    if (!active || active.target !== 'code') return undefined;

    return {
      side: active.side,
      startLine: active.line,
      endLine: active.line,
      lineText: active.text,
      diffTargetFingerprint: options.diffTargetFingerprint(),
    };
  };

  const clearVisual = () => {
    mode.value = 'normal';
    visualStart.value = undefined;
  };

  const clearPending = () => {
    pendingTokens.value = [];
    countDigits.value = '';
  };

  const executeBindingToken = (token: string, event: KeyboardEvent) => {
    const nextTokens = [...pendingTokens.value, token];
    const bindings = parsedBindings(options.keybindings());
    const exact = bindings.find((binding) => sameTokens(binding.tokens, nextTokens));
    const hasPrefix = bindings.some((binding) => isTokenPrefix(nextTokens, binding.tokens));

    if (exact) {
      const count = countDigits.value ? Number(countDigits.value) : 1;
      const hasCount = countDigits.value.length > 0;
      clearPending();
      runAction(exact.action, Math.max(1, count), hasCount);
      event.preventDefault();
      return true;
    }

    if (hasPrefix) {
      pendingTokens.value = nextTokens;
      event.preventDefault();
      return true;
    }

    clearPending();
    return false;
  };

  const handleAction = (action: DiffKeybindingAction, count = 1, hasCount = false) => runAction(action, Math.max(1, count), hasCount);

  const runAction = (action: DiffKeybindingAction, count: number, hasCount: boolean) => {
    ensureCursor();

    if (action === 'clear') {
      clearVisual();
      options.onClear();
      return true;
    }

    if (!cursor.value && action !== 'openSearch') return false;

    if (action === 'moveLeft') moveHorizontal(-count);
    else if (action === 'moveRight') moveHorizontal(count);
    else if (action === 'moveDown') moveVertical(count);
    else if (action === 'moveUp') moveVertical(-count);
    else if (action === 'nextWord') repeat(count, moveNextWord);
    else if (action === 'previousWord') repeat(count, movePreviousWord);
    else if (action === 'endWord') repeat(count, moveEndWord);
    else if (action === 'lineStart') moveToColumn(0);
    else if (action === 'firstNonBlank') moveToFirstNonBlank();
    else if (action === 'lineEnd') moveToLineEnd();
    else if (action === 'fileStart') moveToFileBoundary('start', hasCount ? count : undefined);
    else if (action === 'fileEnd') moveToFileBoundary('end', hasCount ? count : undefined);
    else if (action === 'pageDown') moveVertical(options.halfPageLines() * count);
    else if (action === 'pageUp') moveVertical(-options.halfPageLines() * count);
    else if (action === 'openSearch') options.onOpenSearch();
    else if (action === 'searchNext') options.onMoveSearch(count);
    else if (action === 'searchPrevious') options.onMoveSearch(-count);
    else if (action === 'previousChange') moveToChange(-count);
    else if (action === 'nextChange') moveToChange(count);
    else if (action === 'previousDiagnostic') moveToDiagnostic(-count);
    else if (action === 'nextDiagnostic') moveToDiagnostic(count);
    else if (action === 'previousReview') moveToReview(-count);
    else if (action === 'nextReview') moveToReview(count);
    else if (action === 'previousCursorPosition') moveThroughHistory(-1);
    else if (action === 'nextCursorPosition') moveThroughHistory(1);
    else if (action === 'splitLeft') moveToSplitSide('old', -1);
    else if (action === 'splitRight') moveToSplitSide('new', 1);
    else if (action === 'diffSideLeft') moveToDiffSide('old');
    else if (action === 'diffSideRight') moveToDiffSide('new');
    else if (action === 'visualChar') toggleVisualMode('visual-char');
    else if (action === 'visualLine') toggleVisualMode('visual-line');
    else if (action === 'hover' && cursor.value) options.onHover(cursor.value);
    else if (action === 'comment') commentAtCursor();
    else if (action === 'askAi') askAiAtCursor();
    else return false;

    return true;
  };

  const moveHorizontal = (delta: number) => {
    const active = cursor.value;
    if (!active || active.target !== 'code') return;

    const column = clampColumn(active.column + delta, active.text);
    setCursor(active, column, true, column);
  };

  const moveVertical = (delta: number) => {
    const active = cursor.value;
    if (!active || delta === 0) return;

    const lines = navigationEntriesForCursor(true);
    const index = lineIndex(lines, active);
    if (index === -1) return;

    const target = lines[Math.max(0, Math.min(lines.length - 1, index + delta))];
    if (!target) return;

    setCursor(target, Math.min(desiredColumn.value, maxCursorColumn(target.text)), true, desiredColumn.value);
  };

  const moveToColumn = (column: number) => {
    const active = cursor.value;
    if (!active || active.target !== 'code') return;

    const nextColumn = clampColumn(column, active.text);
    setCursor(active, nextColumn, true, nextColumn);
  };

  const moveToFirstNonBlank = () => {
    const active = cursor.value;
    if (!active) return;

    const column = active.text.search(/\S/);
    moveToColumn(column === -1 ? 0 : column);
  };

  const moveToLineEnd = () => {
    const active = cursor.value;
    if (!active) return;
    moveToColumn(maxCursorColumn(active.text));
  };

  const moveToFileBoundary = (boundary: 'start' | 'end', lineNumber?: number) => {
    const active = cursor.value;
    if (!active) return;

    const lines = codeLinesForCursor();
    const target = lineNumber ? lineAtOrAfter(lines, lineNumber) : boundary === 'start' ? lines[0] : lines[lines.length - 1];
    if (!target) return;

    setCursor(target, Math.min(desiredColumn.value, maxCursorColumn(target.text)), true);
  };

  const moveNextWord = () => {
    const active = cursor.value;
    if (!active) return;

    const lines = codeLinesForCursor();
    const index = lineIndex(lines, active);
    if (index === -1) return;

    const currentColumn = nextWordStart(active.text, active.column);
    if (currentColumn !== undefined) {
      setCursor(active, currentColumn, true, currentColumn);
      return;
    }

    for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
      const column = firstNonWhitespace(lines[lineIndex].text);
      if (column === undefined) continue;
      setCursor(lines[lineIndex], column, true, column);
      return;
    }
  };

  const movePreviousWord = () => {
    const active = cursor.value;
    if (!active) return;

    const lines = codeLinesForCursor();
    const index = lineIndex(lines, active);
    if (index === -1) return;

    const currentColumn = previousWordStart(active.text, active.column);
    if (currentColumn !== undefined) {
      setCursor(active, currentColumn, true, currentColumn);
      return;
    }

    for (let lineIndex = index - 1; lineIndex >= 0; lineIndex -= 1) {
      const column = lastWordStart(lines[lineIndex].text);
      if (column === undefined) continue;
      setCursor(lines[lineIndex], column, true, column);
      return;
    }
  };

  const moveEndWord = () => {
    const active = cursor.value;
    if (!active) return;

    const lines = codeLinesForCursor();
    const index = lineIndex(lines, active);
    if (index === -1) return;

    const currentColumn = wordEnd(active.text, active.column);
    if (currentColumn !== undefined) {
      setCursor(active, currentColumn, true, currentColumn);
      return;
    }

    for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
      const column = firstWordEnd(lines[lineIndex].text);
      if (column === undefined) continue;
      setCursor(lines[lineIndex], column, true, column);
      return;
    }
  };

  const moveToChange = (delta: number) => {
    const active = cursor.value;
    if (!active || delta === 0) return;

    const lines = codeLinesForCursor().filter((line) => line.kind === 'added' || line.kind === 'deleted');
    moveToRelativeTarget(lines, active, delta);
  };

  const moveToDiagnostic = (delta: number) => {
    const active = cursor.value;
    if (!active || delta === 0) return;

    const diagnosticLines = [...new Set(options.diagnostics().map((diagnostic) => diagnostic.line))].sort(
      (first, second) => first - second,
    );
    const lines = sideLines('new').filter((line) => diagnosticLines.includes(line.line));
    moveToRelativeTarget(lines, active, delta);
  };

  const moveToReview = (delta: number) => {
    const active = cursor.value;
    if (!active || delta === 0) return;

    moveToRelativeTarget(reviewEntries(), active, delta);
  };

  const moveToSplitSide = (side: SyntaxSide, surfaceDirection: -1 | 1) => {
    const active = cursor.value;
    if (!active || options.viewMode() !== 'split') {
      options.onMoveSurface?.(surfaceDirection);
      return;
    }

    if (active.side === side) {
      options.onMoveSurface?.(surfaceDirection);
      return;
    }

    clearVisual();
    const target = nearestLineForSide(side, active.rowIndex);
    if (!target) return;

    setCursor(target, Math.min(desiredColumn.value, maxCursorColumn(target.text)), true, desiredColumn.value);
  };

  const moveToDiffSide = (side: SyntaxSide) => {
    const active = cursor.value;
    if (!active || options.viewMode() !== 'split' || active.side === side) return;

    clearVisual();
    const target = nearestLineForSide(side, active.rowIndex);
    if (!target) return;

    setCursor(target, Math.min(desiredColumn.value, maxCursorColumn(target.text)), true, desiredColumn.value);
  };

  const toggleVisualMode = (nextMode: Exclude<DiffCursorMode, 'normal'>) => {
    const active = cursor.value;
    if (!active || active.target !== 'code') return;

    if (mode.value === nextMode) {
      clearVisual();
      return;
    }

    mode.value = nextMode;
    visualStart.value = { ...active };
  };

  const commentAtCursor = () => {
    const anchor = visualAnchor.value ?? currentLineAnchor();
    if (!anchor) return;

    options.onComment(anchor);
    clearVisual();
  };

  const askAiAtCursor = () => {
    const anchor = visualAnchor.value ?? currentLineAnchor();
    if (!anchor) return;

    options.onAskAi(anchor);
    clearVisual();
  };

  const moveToRelativeTarget = (targets: DiffCursorLine[], active: DiffCursorPosition, delta: number) => {
    if (targets.length === 0) return;

    const direction = delta < 0 ? -1 : 1;
    let index =
      direction > 0
        ? targets.findIndex((line) => line.rowIndex > active.rowIndex || (line.rowIndex === active.rowIndex && line.line > active.line))
        : lastIndexOf(targets, (line) => line.rowIndex < active.rowIndex || (line.rowIndex === active.rowIndex && line.line < active.line));

    if (index === -1) index = direction > 0 ? targets.length - 1 : 0;
    index = Math.max(0, Math.min(targets.length - 1, index + direction * (Math.abs(delta) - 1)));

    const target = targets[index];
    setCursor(target, Math.min(desiredColumn.value, maxCursorColumn(target.text)), true, desiredColumn.value);
  };

  const setCursor = (
    line: DiffCursorLine,
    column: number,
    notify: boolean,
    desired = column,
    cursorOptions: { history?: boolean } = {},
  ) => {
    const next = { ...line, column: line.target === 'code' ? clampColumn(column, line.text) : 0 };
    cursor.value = next;
    desiredColumn.value = Math.max(0, desired);
    savedPositions.set(next.fileId, next);
    if (notify) options.onMove?.(next);
  };

  const refreshPosition = (position: DiffCursorPosition): DiffCursorPosition | undefined => {
    const targetPane = paneForSide(position.side);
    const lines = linesForPane(targetPane, position.side);
    if (position.target === 'review' && position.reviewKey) {
      const review = reviewEntries().find((line) => line.reviewKey === position.reviewKey);
      if (review) return review;
    }

    const exact = lines.find((line) => line.target === 'code' && line.side === position.side && line.line === position.line);
    if (exact) return { ...exact, column: clampColumn(position.column, exact.text) };

    const nearest = nearestLineForSide(position.side, position.rowIndex) ?? lines[0];
    return nearest ? { ...nearest, column: clampColumn(position.column, nearest.text) } : undefined;
  };

  const initialLine = (model: DiffRenderModel): DiffCursorLine | undefined => {
    if (options.viewMode() === 'inline') return inlineLines(false, model)[0];

    const preferredSide: SyntaxSide = sideLines('new', model).length > 0 ? 'new' : 'old';
    return sideLines(preferredSide, model)[0];
  };

  const navigationEntriesForCursor = (includeReviews: boolean) => {
    const active = cursor.value;
    if (!active) return [];

    if (options.viewMode() === 'inline' && mode.value === 'normal') return inlineLines(includeReviews);
    return sideLines(active.side, undefined, includeReviews);
  };

  const codeLinesForCursor = () => {
    return navigationEntriesForCursor(false).filter((line) => line.target === 'code');
  };

  const linesForPane = (pane: DiffCursorPane, side?: SyntaxSide) => {
    if (pane === 'inline') return inlineLines();
    return sideLines(side ?? (pane === 'left' ? 'old' : 'new'));
  };

  const inlineLines = (includeReviews = false, model = options.model()): DiffCursorLine[] => {
    if (!model) return [];

    return entriesForDisplayRows(options.displayRows(), model, undefined, includeReviews);
  };

  const sideLines = (side: SyntaxSide, model = options.model(), includeReviews = false): DiffCursorLine[] => {
    if (!model) return [];

    const rows = options.viewMode() === 'split' && !options.syncScroll() ? options.displayRows(side) : options.displayRows();
    return entriesForDisplayRows(rows, model, side, includeReviews);
  };

  const reviewEntries = () => {
    const active = cursor.value;
    const side = active?.side;
    return entriesForDisplayRows(options.displayRows(side), options.model(), side, true).filter((entry) => entry.target === 'review');
  };

  const entriesForDisplayRows = (
    displayRows: DisplayRow[],
    model: DiffRenderModel | undefined,
    side: SyntaxSide | undefined,
    includeReviews: boolean,
  ): DiffCursorLine[] => {
    if (!model) return [];
    return displayRows
      .map((item, displayIndex) => {
        if (item.kind === 'diff') {
          const rowIndex = rowIndexFromDisplayKey(item.key);
          if (rowIndex === undefined) return undefined;
          return side
            ? sideLineForRow(model.fileId, item.row, rowIndex, displayIndex, side)
            : inlineLineForRow(model.fileId, item.row, rowIndex, displayIndex);
        }
        if (!includeReviews || (side && item.anchor.side !== side)) return undefined;
        return reviewEntryForRow(model.fileId, item, displayIndex);
      })
      .filter((line): line is DiffCursorLine => Boolean(line));
  };

  const inlineLineForRow = (fileId: string, row: DiffRow, rowIndex: number, displayIndex: number): DiffCursorLine | undefined => {
    if (row.kind === 'hunk') return undefined;
    const side = row.kind === 'deleted' ? 'old' : 'new';
    return sideLineForRow(fileId, row, rowIndex, displayIndex, side, 'inline');
  };

  const sideLineForRow = (
    fileId: string,
    row: DiffRow,
    rowIndex: number,
    displayIndex: number,
    side: SyntaxSide,
    paneOverride?: DiffCursorPane,
  ): DiffCursorLine | undefined => {
    if (row.kind === 'hunk') return undefined;

    const line = side === 'old' ? row.oldLine : row.newLine;
    if (!line) return undefined;

    return {
      target: 'code',
      fileId,
      side,
      line,
      column: 0,
      rowIndex,
      displayIndex,
      pane: paneOverride ?? paneForSide(side),
      text: side === 'old' ? (row.oldText ?? '') : (row.newText ?? ''),
      kind: row.kind,
    };
  };

  const reviewEntryForRow = (fileId: string, item: Exclude<DisplayRow, { kind: 'diff' }>, displayIndex: number): DiffCursorLine => ({
    target: 'review',
    fileId,
    side: item.anchor.side,
    line: item.anchor.startLine,
    column: 0,
    rowIndex: displayIndex,
    displayIndex,
    pane: paneForSide(item.anchor.side),
    text: '',
    kind: 'review',
    reviewKey: item.key,
  });

  const paneForSide = (side: SyntaxSide): DiffCursorPane => {
    if (options.viewMode() === 'inline') return 'inline';
    if (options.syncScroll()) return 'syncedSplit';
    return side === 'old' ? 'left' : 'right';
  };

  const nearestLineForSide = (side: SyntaxSide, rowIndex: number) => {
    const lines = sideLines(side).filter((line) => line.target === 'code');
    return (
      lines.find((line) => line.rowIndex === rowIndex) ??
      lines.find((line) => line.rowIndex > rowIndex) ??
      [...lines].reverse().find((line) => line.rowIndex < rowIndex)
    );
  };

  const lineForPane = (pane: DiffCursorPane, active: DiffCursorPosition) => {
    if (pane === 'left') return nearestLineForSide('old', active.rowIndex);
    if (pane === 'right') return nearestLineForSide('new', active.rowIndex);
    return (
      nearestLineForSide(active.side, active.rowIndex) ??
      nearestLineForSide('new', active.rowIndex) ??
      nearestLineForSide('old', active.rowIndex)
    );
  };

  const lineForSearchMatch = (match: DiffCursorSearchMatch) => {
    return sideLines(match.side).find((line) => line.target === 'code' && line.line === match.line && line.rowIndex === match.rowIndex);
  };

  const moveThroughHistory = (direction: -1 | 1) => {
    const active = cursor.value;
    if (!active) return;

    if (jumpHistoryIndex.value === jumpHistory.value.length - 1 && !sameCursorPosition(jumpHistory.value[jumpHistoryIndex.value], active)) {
      pushJumpHistory(active);
    }

    const nextIndex = jumpHistoryIndex.value + direction;
    const target = jumpHistory.value[nextIndex];
    if (!target) return;

    jumpHistoryIndex.value = nextIndex;
    pendingHistoryPosition.value = target;
    restoringHistory = target.fileId !== active.fileId;
    if (target.fileId !== active.fileId) {
      options.onOpenFile?.(target.fileId);
      return;
    }

    const refreshed = refreshPosition(target);
    if (refreshed) setCursor(refreshed, refreshed.column, true, refreshed.column, { history: false });
  };

  const pushJumpHistory = (position: DiffCursorPosition) => {
    const current = jumpHistory.value[jumpHistoryIndex.value];
    if (sameCursorPosition(current, position)) return;
    const next = jumpHistory.value.slice(0, jumpHistoryIndex.value + 1);
    next.push({ ...position });
    jumpHistory.value = next;
    jumpHistoryIndex.value = next.length - 1;
  };

  const lineAtOrAfter = (lines: DiffCursorLine[], lineNumber: number) => {
    return lines.find((line) => line.line >= lineNumber) ?? lines[lines.length - 1];
  };

  const buildVisualAnchor = (start: DiffCursorPosition, end: DiffCursorPosition, visualMode: DiffCursorMode): ReviewAnchor | undefined => {
    const lines = sideLines(start.side);
    const startIndex = lineIndex(lines, start);
    const endIndex = lineIndex(lines, end);
    if (startIndex === -1 || endIndex === -1) return undefined;

    const firstIndex = Math.min(startIndex, endIndex);
    const lastIndex = Math.max(startIndex, endIndex);
    const first = lines[firstIndex];
    const last = lines[lastIndex];
    const forward = startIndex <= endIndex;

    const startColumn = visualMode === 'visual-line' ? 0 : forward ? start.column : end.column;
    const endColumn = visualMode === 'visual-line' ? last.text.length : (forward ? end.column : start.column) + 1;
    const normalizedStartColumn = Math.max(0, Math.min(first.text.length, startColumn));
    const normalizedEndColumn = Math.max(0, Math.min(last.text.length, endColumn));
    const selectedText = selectedTextForLines(lines.slice(firstIndex, lastIndex + 1), normalizedStartColumn, normalizedEndColumn);

    return {
      side: start.side,
      startLine: first.line,
      endLine: last.line,
      startColumn: normalizedStartColumn,
      endColumn: normalizedEndColumn,
      selectedText,
      lineText: first.text,
      diffTargetFingerprint: options.diffTargetFingerprint(),
    };
  };

  const selectedTextForLines = (lines: DiffCursorLine[], startColumn: number, endColumn: number) => {
    if (lines.length === 0) return '';
    if (lines.length === 1) return lines[0].text.slice(startColumn, Math.max(startColumn, endColumn));

    return lines
      .map((line, index) => {
        if (index === 0) return line.text.slice(startColumn);
        if (index === lines.length - 1) return line.text.slice(0, endColumn);
        return line.text;
      })
      .join('\n');
  };

  watch(() => [options.model()?.fileId, options.model()?.rows, options.viewMode(), options.syncScroll()] as const, ensureCursor, {
    immediate: true,
  });

  return {
    cursor,
    mode,
    visualAnchor,
    ensureCursor,
    handleAction,
    handleKeyDown,
    currentSurfacePosition,
    moveCursorToSearchMatch,
    moveCursorToLine,
    moveCursorToReviewKey,
    moveCursorToSurfacePosition,
    moveCursorToPane,
    lineStateForLine,
    isReviewFocused,
    currentLineAnchor,
    clearVisual,
    clearPending,
  };
};

const parsedBindings = (keybindings: DiffKeybindingMap): ParsedBinding[] => {
  return Object.entries(keybindings).flatMap(([action, bindings]) => {
    return bindings
      .map((binding) => parseDiffKeybinding(binding))
      .filter((tokens): tokens is string[] => Boolean(tokens && tokens.length > 0))
      .map((tokens) => ({ action: action as DiffKeybindingAction, tokens }));
  });
};

const sameTokens = (first: string[], second: string[]) =>
  first.length === second.length && first.every((token, index) => token === second[index]);

const isTokenPrefix = (prefix: string[], tokens: string[]) => {
  return prefix.length < tokens.length && prefix.every((token, index) => token === tokens[index]);
};

const lineIndex = (lines: DiffCursorLine[], position: Pick<DiffCursorPosition, 'side' | 'line' | 'rowIndex'>) => {
  return lines.findIndex((line) => line.side === position.side && line.line === position.line && line.rowIndex === position.rowIndex);
};

const rowIndexFromDisplayKey = (key: string) => {
  const value = Number(key.slice('diff:'.length));
  return Number.isInteger(value) ? value : undefined;
};

const sameCursorPosition = (first: DiffCursorPosition | undefined, second: DiffCursorPosition | undefined) => {
  if (!first || !second) return false;
  return (
    first.target === second.target &&
    first.fileId === second.fileId &&
    first.side === second.side &&
    first.line === second.line &&
    first.column === second.column &&
    first.reviewKey === second.reviewKey
  );
};

const clampColumn = (column: number, text: string) => Math.max(0, Math.min(maxCursorColumn(text), column));

const maxCursorColumn = (text: string) => Math.max(0, text.length - 1);

const repeat = (count: number, action: () => void) => {
  for (let index = 0; index < count; index += 1) action();
};

const firstNonWhitespace = (text: string) => {
  const column = text.search(/\S/);
  return column === -1 ? undefined : column;
};

const nextWordStart = (text: string, column: number) => {
  let index = Math.min(text.length, column + 1);
  while (index < text.length && !isWhitespace(text[index])) index += 1;
  while (index < text.length && isWhitespace(text[index])) index += 1;
  return index < text.length ? index : undefined;
};

const previousWordStart = (text: string, column: number) => {
  let index = Math.min(text.length - 1, column - 1);
  while (index >= 0 && isWhitespace(text[index])) index -= 1;
  while (index > 0 && !isWhitespace(text[index - 1])) index -= 1;
  return index >= 0 ? index : undefined;
};

const lastWordStart = (text: string) => previousWordStart(text, text.length);

const wordEnd = (text: string, column: number) => {
  let index = Math.min(text.length - 1, column + 1);
  while (index < text.length && isWhitespace(text[index])) index += 1;
  if (index >= text.length) return undefined;
  while (index + 1 < text.length && !isWhitespace(text[index + 1])) index += 1;
  return index;
};

const firstWordEnd = (text: string) => wordEnd(text, -1);

const isWhitespace = (value: string) => /\s/.test(value);

const lastIndexOf = <T>(items: T[], predicate: (item: T) => boolean) => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
};
