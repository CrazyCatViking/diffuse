import { computed, ref, type Ref } from 'vue';
import type { ChangedFile, ReviewAnchor, SyntaxSide } from '../../lib/protocol';

type SelectionDraft = { file: ChangedFile; anchor: ReviewAnchor };

export const useDiffSelection = (options: {
  rootRef: Ref<HTMLElement | null>;
  scrollContainerRef?: Ref<HTMLElement | null>;
  selector: string;
  fileForElement: (element: HTMLElement) => ChangedFile | undefined;
  diffTargetFingerprint: () => string;
  requireSameFile?: boolean;
  lockSide?: boolean;
}) => {
  const selectionBubblePosition = ref({ left: 18, top: 52 });
  const selectionDraft = ref<SelectionDraft>();
  const nativeSelectionRange = ref<Range>();
  const selectionSideLock = ref<SyntaxSide>();
  const selectionBubbleStyle = computed(() => ({
    left: `${selectionBubblePosition.value.left}px`,
    top: `${selectionBubblePosition.value.top}px`,
  }));
  const selectionSideClass = computed(() => ({
    'selecting-old-side': selectionSideLock.value === 'old',
    'selecting-new-side': selectionSideLock.value === 'new',
  }));

  const captureSelectionComment = () => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (!selection || !selectedText || selection.rangeCount === 0) {
      selectionDraft.value = undefined;
      return;
    }

    const range = selection.getRangeAt(0);
    nativeSelectionRange.value = range.cloneRange();
    const start = reviewElementForNode(range.startContainer);
    const end = reviewElementForNode(range.endContainer);
    if (!start || !end) {
      selectionDraft.value = undefined;
      return;
    }

    const side = start.dataset.reviewSide;
    const startFileId = start.dataset.reviewFileId;
    if (
      (side !== 'old' && side !== 'new') ||
      end.dataset.reviewSide !== side ||
      (options.requireSameFile && end.dataset.reviewFileId !== startFileId)
    ) {
      selectionDraft.value = undefined;
      return;
    }

    const file = options.fileForElement(start);
    if (!file) {
      selectionDraft.value = undefined;
      return;
    }

    const startLine = Number(start.dataset.reviewLine);
    const endLine = Number(end.dataset.reviewLine);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
      selectionDraft.value = undefined;
      return;
    }

    const startColumn = textOffsetWithinElement(start, range.startContainer, range.startOffset);
    const endColumn = textOffsetWithinElement(end, range.endContainer, range.endOffset);
    const normalizedStartLine = Math.min(startLine, endLine);
    const normalizedEndLine = Math.max(startLine, endLine);
    const normalizedStartColumn = startLine <= endLine ? startColumn : endColumn;
    const normalizedEndColumn = startLine <= endLine ? endColumn : startColumn;

    const rect = selectionTextRect(range, side);
    if (!rect) {
      selectionDraft.value = undefined;
      return;
    }

    positionSelectionToolbar(rect.right, rect.top);
    selectionDraft.value = {
      file,
      anchor: {
        side,
        startLine: normalizedStartLine,
        endLine: normalizedEndLine,
        startColumn:
          normalizedStartLine === normalizedEndLine ? Math.min(normalizedStartColumn, normalizedEndColumn) : normalizedStartColumn,
        endColumn: normalizedStartLine === normalizedEndLine ? Math.max(normalizedStartColumn, normalizedEndColumn) : normalizedEndColumn,
        selectedText,
        lineText: start.dataset.reviewText,
        diffTargetFingerprint: options.diffTargetFingerprint(),
      },
    };
  };

  const lockSelectionSide = (event: PointerEvent) => {
    if (!options.lockSide) return;
    if (event.button !== 0 || !(event.target instanceof Node)) {
      selectionSideLock.value = undefined;
      return;
    }

    const element = reviewElementForNode(event.target);
    const side = element?.dataset.reviewSide;
    selectionSideLock.value = side === 'old' || side === 'new' ? side : undefined;
  };

  const reviewElementForNode = (node: Node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentNode instanceof Element ? node.parentNode : null;
    return element?.closest<HTMLElement>(options.selector);
  };

  const textOffsetWithinElement = (element: HTMLElement, node: Node, offset: number) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(node, offset);
    return range.toString().length;
  };

  const selectionTextRect = (range: Range, side?: SyntaxSide) => {
    const selectableRects = side ? reviewElementRectsForSide(side) : [];
    const rects = [...range.getClientRects()]
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .filter((rect) => selectableRects.length === 0 || selectableRects.some((selectableRect) => rectsIntersect(rect, selectableRect)));
    if (rects.length === 0) return undefined;
    return rects.sort((first, second) => first.top - second.top || second.right - first.right)[0];
  };

  const reviewElementRectsForSide = (side: SyntaxSide) => {
    const root = options.rootRef.value;
    if (!root) return [];

    return [...root.querySelectorAll<HTMLElement>(`[data-review-side="${side}"]`)]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
  };

  const rectsIntersect = (first: DOMRect, second: DOMRect) => {
    return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
  };

  const positionSelectionToolbar = (clientX: number, clientY: number) => {
    const container = options.scrollContainerRef?.value ?? options.rootRef.value;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const toolbarWidth = 34;
    const toolbarHeight = 30;
    const gap = 6;
    selectionBubblePosition.value = {
      left: container.scrollLeft + Math.max(12, Math.min(clientX - rect.left + gap, rect.width - toolbarWidth - 12)),
      top: container.scrollTop + Math.max(48, Math.min(clientY - rect.top - toolbarHeight - gap, rect.height - toolbarHeight - 12)),
    };
  };

  const clearNativeSelection = () => {
    nativeSelectionRange.value = undefined;
    window.getSelection()?.removeAllRanges();
  };

  const clearSelectionDraftWhenSelectionEnds = () => {
    if (!selectionDraft.value) return;
    if (window.getSelection()?.toString().trim()) return;
    selectionDraft.value = undefined;
    nativeSelectionRange.value = undefined;
  };

  return {
    selectionBubblePosition,
    selectionDraft,
    nativeSelectionRange,
    selectionBubbleStyle,
    selectionSideLock,
    selectionSideClass,
    captureSelectionComment,
    lockSelectionSide,
    reviewElementForNode,
    textOffsetWithinElement,
    clearNativeSelection,
    clearSelectionDraftWhenSelectionEnds,
  };
};
