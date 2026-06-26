import { computed, ref } from 'vue';
import type { DiffTarget, LspHover, SyntaxSide } from '../../lib/protocol';
import type { useClient } from '../../lib/useClient';

type LspHoverClient = ReturnType<typeof useClient>;

const lspHoverDelayMs = 420;
const maxCachedHovers = 200;

export const supportsLspFile = (fileId: string) => {
  const normalized = fileId.toLowerCase();
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.py', '.go', '.zig', '.lua'].some((extension) =>
    normalized.endsWith(extension),
  );
};

export const useLspHover = (options: {
  client: LspHoverClient;
  target: () => DiffTarget;
  diffTargetFingerprint: () => string;
  reviewElementForNode: (node: Node) => HTMLElement | null | undefined;
  textOffsetWithinElement: (element: HTMLElement, node: Node, offset: number) => number;
  fileIdForElement: (element: HTMLElement) => string | undefined;
  canQueue?: (fileId: string) => boolean;
  afterHoverRequest?: () => void;
}) => {
  let timer: number | undefined;
  let requestId = 0;
  const cache = new Map<string, LspHover>();
  const hover = ref({
    visible: false,
    loading: false,
    contents: '',
    left: 0,
    top: 0,
  });

  const hoverStyle = computed(() => ({
    left: `${hover.value.left}px`,
    top: `${hover.value.top}px`,
  }));

  const queue = (event: PointerEvent) => {
    const target = event.target instanceof Node ? event.target : null;
    const element = target ? options.reviewElementForNode(target) : null;
    if (!element) {
      clear();
      return;
    }

    const fileId = options.fileIdForElement(element);
    const side = element.dataset.reviewSide;
    const line = Number(element.dataset.reviewLine);
    if (
      !fileId ||
      !supportsLspFile(fileId) ||
      (side !== 'old' && side !== 'new') ||
      !Number.isFinite(line) ||
      line <= 0 ||
      options.canQueue?.(fileId) === false
    ) {
      clear();
      return;
    }

    const column = columnAtPoint(element, event.clientX, event.clientY, options.textOffsetWithinElement);
    const cacheKey = `${fileId}:${options.diffTargetFingerprint()}:${side}:${line}:${column}`;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void load({ fileId, side, line, column, cacheKey, clientX: event.clientX, clientY: event.clientY });
    }, lspHoverDelayMs);
  };

  const clear = () => {
    const hadTimer = timer !== undefined;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (!hadTimer && !hover.value.visible && !hover.value.loading) return;
    requestId += 1;
    hover.value = { ...hover.value, visible: false, loading: false };
  };

  const load = async (request: {
    fileId: string;
    side: SyntaxSide;
    line: number;
    column: number;
    cacheKey: string;
    clientX: number;
    clientY: number;
  }) => {
    const currentRequestId = ++requestId;
    const cached = cache.get(request.cacheKey);
    if (cached) {
      show(cached, request.clientX, request.clientY, false);
      return;
    }

    hover.value = { visible: true, loading: true, contents: '', left: request.clientX + 14, top: request.clientY + 16 };
    try {
      const loaded = await options.client.getLspHover(request.fileId, request.side, request.line, request.column, options.target());
      cache.set(request.cacheKey, loaded);
      evictOldCachedHovers();
      if (currentRequestId !== requestId) return;
      show(loaded, request.clientX, request.clientY, false);
    } catch (error) {
      if (currentRequestId !== requestId) return;
      show(
        { status: 'request-failed', message: error instanceof Error ? error.message : String(error) },
        request.clientX,
        request.clientY,
        false,
      );
    } finally {
      if (currentRequestId === requestId) options.afterHoverRequest?.();
    }
  };

  const show = (loaded: LspHover, clientX: number, clientY: number, loading: boolean) => {
    const contents = loaded.status === 'ok' ? (loaded.contents ?? '') : '';
    if (!contents.trim()) {
      hover.value = { ...hover.value, visible: false, loading: false };
      return;
    }
    hover.value = {
      visible: true,
      loading,
      contents,
      left: Math.min(clientX + 14, window.innerWidth - 360),
      top: Math.min(clientY + 16, window.innerHeight - 220),
    };
  };

  const cleanup = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    cache.clear();
  };

  const clearCache = () => {
    cache.clear();
  };

  const evictOldCachedHovers = () => {
    while (cache.size > maxCachedHovers) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) return;
      cache.delete(oldestKey);
    }
  };

  return { hover, hoverStyle, queue, clear, clearCache, cleanup };
};

const columnAtPoint = (
  element: HTMLElement,
  clientX: number,
  clientY: number,
  textOffsetWithinElement: (element: HTMLElement, node: Node, offset: number) => number,
) => {
  const text = element.dataset.reviewText ?? element.textContent ?? '';
  const range = rangeAtPoint(clientX, clientY);
  if (range && element.contains(range.startContainer)) {
    return Math.max(0, Math.min(text.length, textOffsetWithinElement(element, range.startContainer, range.startOffset)));
  }

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const fontSize = Number.parseFloat(style.fontSize) || 12;
  const charWidth = fontSize * 0.62;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  return Math.max(0, Math.min(text.length, Math.round((clientX - rect.left - paddingLeft) / charWidth)));
};

const rangeAtPoint = (clientX: number, clientY: number): Range | undefined => {
  const documentWithCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
  if (position) {
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return documentWithCaret.caretRangeFromPoint?.(clientX, clientY) ?? undefined;
};
