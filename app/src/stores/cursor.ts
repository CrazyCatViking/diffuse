import { defineStore } from 'pinia';
import { computed, type Ref, ref, toRaw } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { diffKeyTokenForEvent, parseDiffKeybinding, type DiffKeybindingAction } from '../lib/diffKeybindings';
import { diffRoute } from '../lib/workspaceRoutes';
import { useSettingsStore } from './settings';

export type CursorMotion = DiffKeybindingAction;
export type CursorCommand = DiffKeybindingAction | 'activate';
export type CursorSurface = FileTreeSurface | DiffSurface | PinnedResultsSurface | ReviewOverviewSurface | FolderDiffSurface;
export type DiffSurfacePane = 'old' | 'new' | 'inline';
export type CursorDirection = 'left' | 'right' | 'up' | 'down';
export type CursorActivationReason = 'default' | 'surface-move' | 'history';

export type CursorActionContext = {
  count: number;
  hasCount: boolean;
  event: KeyboardEvent;
};

export type CursorActionResult = boolean | void | { handled: boolean; significant?: boolean };

export type CursorSurfaceMount = {
  id: string;
  getRect: () => DOMRect | undefined;
  activate?: (reason: CursorActivationReason) => void;
  isEligible?: () => boolean;
  onMotion?: (motion: CursorMotion, context: CursorActionContext) => CursorActionResult;
  onCommand?: (command: CursorCommand, context: CursorActionContext) => CursorActionResult;
};

export type FileTreeSurface = {
  id: typeof fileTreeSurfaceId;
  type: 'file-tree';
  position: { key: string; target: 'overview' | 'folder' | 'file'; fileId?: string; folderPath?: string };
};

export type DiffSurface = {
  id: string;
  type: 'diff';
  position: {
    fileId: string;
    pane: DiffSurfacePane;
    side: 'old' | 'new';
    line: number;
    column: number;
    rowIndex: number;
    displayIndex: number;
    target: 'code' | 'review';
    reviewKey?: string;
  };
};

export type PinnedResultsSurface = {
  id: typeof pinnedResultsSurfaceId;
  type: 'pinned-results';
  position: Record<string, never>;
};

export type ReviewOverviewSurface = {
  id: typeof reviewOverviewSurfaceId;
  type: 'review-overview';
  position: Record<string, never>;
};

export type FolderDiffSurface = {
  id: string;
  type: 'folder-diff';
  position: Record<string, never>;
};

type CursorHistoryEntry = {
  surfaceId: string;
  surface: CursorSurface;
};

type ParsedBinding = {
  action: DiffKeybindingAction;
  tokens: string[];
};

type CursorNavigator = (route: RouteLocationRaw) => void | Promise<void>;

export const fileTreeSurfaceId = 'file-tree';
export const pinnedResultsSurfaceId = 'pinned-results';
export const reviewOverviewSurfaceId = 'review-overview';

export const diffSurfaceId = (fileId: string, side: 'old' | 'new') => `diff:${encodeURIComponent(fileId)}:${side}`;
export const folderDiffSurfaceId = (folderPath: string) => `folder-diff:${encodeURIComponent(folderPath)}`;

export const useCursorStore = defineStore('cursor', () => {
  const settings = useSettingsStore();
  const activeSurfaceId = ref<string>();
  const surfaces = new Map<string, Ref<CursorSurface>>();
  const openSurfaceIds = new Set<string>();
  const surfaceMounts = new Map<string, CursorSurfaceMount>();
  const pendingActivationReasons = new Map<string, CursorActivationReason>();
  const surfacePositionHistory: CursorHistoryEntry[] = [];
  const parsedBindings = computed<ParsedBinding[]>(() => {
    return Object.entries(settings.diffKeybindings).flatMap(([action, bindings]) => {
      return bindings
        .map((binding) => parseDiffKeybinding(binding))
        .filter((tokens): tokens is string[] => Boolean(tokens && tokens.length > 0))
        .map((tokens) => ({ action: action as DiffKeybindingAction, tokens }));
    });
  });
  let surfacePositionHistoryIndex = -1;
  let pendingTokens: string[] = [];
  let countDigits = '';
  let navigator: CursorNavigator | undefined;
  let restoringHistory = false;

  const registerSurface = <T extends CursorSurface>(surface: T, mount: CursorSurfaceMount): Ref<T> => {
    let surfaceRef = surfaces.get(surface.id) as Ref<T> | undefined;

    if (surfaceRef) {
      surfaceRef.value = { ...surface, position: surfaceRef.value.position } as T;
    } else {
      surfaceRef = ref(cloneSurface(surface)) as Ref<T>;
      surfaces.set(surface.id, surfaceRef as Ref<CursorSurface>);
    }

    openSurfaceIds.add(surface.id);
    surfaceMounts.set(surface.id, mount);
    if (!activeSurfaceId.value && canDefaultToSurface(surface.id)) activeSurfaceId.value = surface.id;
    if (activeSurfaceId.value === surface.id) {
      const reason = pendingActivationReasons.get(surface.id) ?? 'default';
      requestSurfaceActivation(surface.id, reason);
    }

    return surfaceRef;
  };

  const unregisterSurface = (surfaceId: string) => {
    openSurfaceIds.delete(surfaceId);
    surfaceMounts.delete(surfaceId);
  };

  const setNavigator = (nextNavigator: CursorNavigator | undefined) => {
    navigator = nextNavigator;
  };

  const surface = <T extends CursorSurface = CursorSurface>(surfaceId: string): Ref<T> | undefined => {
    return surfaces.get(surfaceId) as Ref<T> | undefined;
  };

  const isActiveSurface = (surfaceId: string) => activeSurfaceId.value === surfaceId;

  const setActiveSurface = (surfaceId: string, options: { activate?: boolean; reason?: CursorActivationReason } = {}) => {
    activeSurfaceId.value = surfaceId;
    if (options.activate !== false) requestSurfaceActivation(surfaceId, options.reason ?? 'default');
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return false;

    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const handled = runCommand('activate', { count: 1, hasCount: false, event });
      if (handled) event.preventDefault();
      return handled;
    }

    const token = diffKeyTokenForEvent(event);
    if (!token) {
      clearPending();
      return false;
    }

    if (token === '<Esc>') return executeBindingToken(token, event);

    if (pendingTokens.length === 0 && /^[1-9]$/.test(token)) {
      countDigits += token;
      event.preventDefault();
      return true;
    }

    if (pendingTokens.length === 0 && token === '0' && countDigits.length > 0) {
      countDigits += token;
      event.preventDefault();
      return true;
    }

    return executeBindingToken(token, event);
  };

  const moveSurface = (direction: CursorDirection) => {
    const activeId = activeSurfaceId.value;
    const activeMount = activeId ? surfaceMounts.get(activeId) : undefined;
    const activeRect = activeMount?.getRect();
    if (!activeId || !activeRect) return activateFirstOpenSurface();

    const candidates = [...openSurfaceIds]
      .filter((surfaceId) => surfaceId !== activeId)
      .filter((surfaceId) => !sameDiffSurfaceGroup(activeId, surfaceId))
      .map((surfaceId) => {
        const mount = surfaceMounts.get(surfaceId);
        const rect = mount?.getRect();
        return mount && rect && (mount.isEligible?.() ?? true) ? { surfaceId, rect } : undefined;
      })
      .filter((candidate): candidate is { surfaceId: string; rect: DOMRect } => Boolean(candidate));

    const next = candidates
      .map((candidate) => ({ ...candidate, score: surfaceDirectionScore(activeRect, candidate.rect, direction) }))
      .filter((candidate): candidate is { surfaceId: string; rect: DOMRect; score: number[] } => candidate.score !== undefined)
      .sort(compareSurfaceScores)[0];

    if (!next) return false;
    setActiveSurface(next.surfaceId, { reason: 'surface-move' });
    return true;
  };

  const recordSurfacePosition = (surfaceId: string) => {
    const surfaceRef = surfaces.get(surfaceId);
    if (!surfaceRef || !shouldRecordSurface(surfaceRef.value)) return;
    pushHistoryEntry({ surfaceId, surface: cloneSurface(surfaceRef.value) });
  };

  const moveHistory = (direction: -1 | 1) => {
    if (direction < 0) recordCurrentHistoryPosition();

    const nextIndex = surfacePositionHistoryIndex + direction;
    const entry = surfacePositionHistory[nextIndex];
    if (!entry) return false;

    restoringHistory = true;
    surfacePositionHistoryIndex = nextIndex;
    restoreSurfaceEntry(entry);
    restoringHistory = false;
    return true;
  };

  const isRestoringHistory = () => restoringHistory || pendingActivationReasons.size > 0;

  const executeBindingToken = (token: string, event: KeyboardEvent) => {
    const nextTokens = [...pendingTokens, token];
    const bindings = parsedBindings.value;
    const exact = bindings.find((binding) => sameTokens(binding.tokens, nextTokens));
    const hasPrefix = bindings.some((binding) => isTokenPrefix(nextTokens, binding.tokens));

    if (exact) {
      const count = countDigits ? Number(countDigits) : 1;
      const hasCount = countDigits.length > 0;
      clearPending();
      const handled = runAction(exact.action, { count: Math.max(1, count), hasCount, event });
      if (handled) event.preventDefault();
      return handled;
    }

    if (hasPrefix) {
      pendingTokens = nextTokens;
      event.preventDefault();
      return true;
    }

    clearPending();
    return false;
  };

  const runAction = (action: DiffKeybindingAction, context: CursorActionContext) => {
    if (action === 'previousCursorPosition') return moveHistory(-1);
    if (action === 'nextCursorPosition') return moveHistory(1);
    if (action === 'splitLeft') return moveSurface('left');
    if (action === 'splitRight') return moveSurface('right');
    if (commandActions.has(action)) return runCommand(action, context);
    return runMotion(action, context);
  };

  const runMotion = (motion: CursorMotion, context: CursorActionContext) => {
    const mount = activeMotionMount();
    const significantByAction = significantMotionActions.has(motion);
    const before = significantByAction ? activeSurfaceSnapshot() : undefined;
    const result = mount?.onMotion?.(motion, context);
    return finishSurfaceAction(result, before, significantByAction);
  };

  const runCommand = (command: CursorCommand, context: CursorActionContext) => {
    const mount = activeCommandMount();
    const before = activeSurfaceSnapshot();
    const result = mount?.onCommand?.(command, context);
    return finishSurfaceAction(result, before, false);
  };

  const finishSurfaceAction = (result: CursorActionResult, before: CursorHistoryEntry | undefined, significantByAction: boolean) => {
    const handled = actionHandled(result);
    if (!handled || restoringHistory) return handled;

    const after = activeSurfaceSnapshot();
    if (!after) return handled;

    const significant = actionSignificant(result) || significantByAction;
    if (significant && before) {
      pushHistoryEntry(before);
      pushHistoryEntry(after);
    }

    return handled;
  };

  const activeMount = () => {
    const activeId = activeSurfaceId.value;
    return activeId ? surfaceMounts.get(activeId) : undefined;
  };

  const activeMotionMount = () => {
    const mount = activeMount();
    if (mount?.onMotion && eligibleMount(mount)) return mount;
    const surfaceId = firstFallbackSurfaceId((candidate) => Boolean(candidate.onMotion));
    if (!surfaceId) return mount;
    setActiveSurface(surfaceId, { activate: false });
    return surfaceMounts.get(surfaceId);
  };

  const activeCommandMount = () => {
    const mount = activeMount();
    if (mount?.onCommand && eligibleMount(mount)) return mount;
    const surfaceId = firstFallbackSurfaceId((candidate) => Boolean(candidate.onCommand));
    if (!surfaceId) return mount;
    setActiveSurface(surfaceId, { activate: false });
    return surfaceMounts.get(surfaceId);
  };

  const activeSurfaceSnapshot = (): CursorHistoryEntry | undefined => {
    const activeId = activeSurfaceId.value;
    const surfaceRef = activeId ? surfaces.get(activeId) : undefined;
    if (!activeId || !surfaceRef || !shouldRecordSurface(surfaceRef.value)) return undefined;
    return { surfaceId: activeId, surface: cloneSurface(surfaceRef.value) };
  };

  const pushHistoryEntry = (entry: CursorHistoryEntry) => {
    const current = surfacePositionHistory[surfacePositionHistoryIndex];
    if (sameHistoryEntry(current, entry)) return;

    surfacePositionHistory.splice(surfacePositionHistoryIndex + 1);
    surfacePositionHistory.push({ surfaceId: entry.surfaceId, surface: cloneSurface(entry.surface) });
    surfacePositionHistoryIndex = surfacePositionHistory.length - 1;
  };

  const restoreSurfaceEntry = (entry: CursorHistoryEntry) => {
    const restoredSurface = cloneSurface(entry.surface);
    const existing = surfaces.get(entry.surfaceId);
    if (existing) existing.value = restoredSurface;
    else surfaces.set(entry.surfaceId, ref(restoredSurface) as Ref<CursorSurface>);

    activeSurfaceId.value = entry.surfaceId;
    if (openSurfaceIds.has(entry.surfaceId)) {
      pendingActivationReasons.set(entry.surfaceId, 'history');
      requestSurfaceActivation(entry.surfaceId, 'history');
      return;
    }

    const route = routeForSurfaceId(entry.surfaceId);
    pendingActivationReasons.set(entry.surfaceId, 'history');
    if (route) void navigator?.(route);
  };

  const requestSurfaceActivation = (surfaceId: string, reason: CursorActivationReason) => {
    window.requestAnimationFrame(() => {
      try {
        if (activeSurfaceId.value === surfaceId) surfaceMounts.get(surfaceId)?.activate?.(reason);
      } finally {
        if (pendingActivationReasons.get(surfaceId) === reason) pendingActivationReasons.delete(surfaceId);
      }
    });
  };

  const recordCurrentHistoryPosition = () => {
    const snapshot = activeSurfaceSnapshot();
    if (snapshot) pushHistoryEntry(snapshot);
  };

  const activateFirstOpenSurface = () => {
    const firstOpenSurfaceId =
      firstFallbackSurfaceId((mount) => Boolean(mount.onMotion || mount.onCommand)) ?? firstFallbackSurfaceId(() => true);
    if (!firstOpenSurfaceId) return false;
    setActiveSurface(firstOpenSurfaceId);
    return true;
  };

  const canDefaultToSurface = (surfaceId: string) => {
    const mount = surfaceMounts.get(surfaceId);
    return Boolean(mount && eligibleMount(mount) && (mount.onMotion || mount.onCommand));
  };

  const firstFallbackSurfaceId = (predicate: (mount: CursorSurfaceMount) => boolean) => {
    const diffSurfaceId = firstOpenSurfaceId((surfaceId, mount) => surface(surfaceId)?.value.type === 'diff' && predicate(mount));
    if (diffSurfaceId) return diffSurfaceId;

    const fileTreeMount = surfaceMounts.get(fileTreeSurfaceId);
    if (openSurfaceIds.has(fileTreeSurfaceId) && fileTreeMount && eligibleMount(fileTreeMount) && predicate(fileTreeMount)) {
      return fileTreeSurfaceId;
    }

    return firstOpenSurfaceId((_, mount) => predicate(mount));
  };

  const firstOpenSurfaceId = (predicate: (surfaceId: string, mount: CursorSurfaceMount) => boolean) => {
    return [...openSurfaceIds].find((surfaceId) => {
      const mount = surfaceMounts.get(surfaceId);
      return Boolean(mount && eligibleMount(mount) && predicate(surfaceId, mount));
    });
  };

  const eligibleMount = (mount: CursorSurfaceMount) => {
    return mount.isEligible?.() ?? true;
  };

  const clearPending = () => {
    pendingTokens = [];
    countDigits = '';
  };

  return {
    activeSurfaceId,
    handleKeyDown,
    isActiveSurface,
    recordSurfacePosition,
    isRestoringHistory,
    registerSurface,
    setActiveSurface,
    setNavigator,
    surface,
    unregisterSurface,
  };
});

const commandActions = new Set<DiffKeybindingAction>(['openSearch', 'clear', 'hover', 'comment', 'askAi']);

const significantMotionActions = new Set<DiffKeybindingAction>([
  'fileStart',
  'fileEnd',
  'searchNext',
  'searchPrevious',
  'previousChange',
  'nextChange',
  'previousDiagnostic',
  'nextDiagnostic',
  'previousReview',
  'nextReview',
  'diffSideLeft',
  'diffSideRight',
]);

const shouldRecordSurface = (surface: CursorSurface) => surface.type === 'diff';

const cloneSurface = <T extends CursorSurface>(surface: T): T => {
  const raw = toRaw(surface);
  return { ...raw, position: { ...toRaw(raw.position) } } as T;
};

const actionHandled = (result: CursorActionResult) => {
  if (typeof result === 'boolean') return result;
  if (result && typeof result === 'object') return result.handled;
  return false;
};

const actionSignificant = (result: CursorActionResult) => {
  return Boolean(result && typeof result === 'object' && result.significant);
};

const sameHistoryEntry = (first: CursorHistoryEntry | undefined, second: CursorHistoryEntry | undefined) => {
  return Boolean(
    first && second && first.surfaceId === second.surfaceId && JSON.stringify(first.surface) === JSON.stringify(second.surface),
  );
};

const routeForSurfaceId = (surfaceId: string): RouteLocationRaw | undefined => {
  const diff = parseDiffSurfaceId(surfaceId);
  return diff ? diffRoute(diff.fileId) : undefined;
};

const parseDiffSurfaceId = (surfaceId: string): { fileId: string; side: 'old' | 'new' } | undefined => {
  const match = surfaceId.match(/^diff:(.+):(old|new)$/);
  if (!match) return undefined;
  return { fileId: decodeSurfaceIdPart(match[1]), side: match[2] as 'old' | 'new' };
};

const sameDiffSurfaceGroup = (firstSurfaceId: string, secondSurfaceId: string) => {
  const first = parseDiffSurfaceId(firstSurfaceId);
  const second = parseDiffSurfaceId(secondSurfaceId);
  return Boolean(first && second && first.fileId === second.fileId);
};

const decodeSurfaceIdPart = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const sameTokens = (first: string[], second: string[]) =>
  first.length === second.length && first.every((token, index) => token === second[index]);

const isTokenPrefix = (prefix: string[], tokens: string[]) => {
  return prefix.length < tokens.length && prefix.every((token, index) => token === tokens[index]);
};

const surfaceDirectionScore = (active: DOMRect, candidate: DOMRect, direction: CursorDirection) => {
  const activeCenter = rectCenter(active);
  const candidateCenter = rectCenter(candidate);
  const verticalOverlap = overlap(active.top, active.bottom, candidate.top, candidate.bottom);
  const horizontalOverlap = overlap(active.left, active.right, candidate.left, candidate.right);

  if (direction === 'left' && candidateCenter.x >= activeCenter.x) return undefined;
  if (direction === 'right' && candidateCenter.x <= activeCenter.x) return undefined;
  if (direction === 'up' && candidateCenter.y >= activeCenter.y) return undefined;
  if (direction === 'down' && candidateCenter.y <= activeCenter.y) return undefined;

  if (direction === 'left')
    return [verticalOverlap > 0 ? 0 : 1, Math.max(0, active.left - candidate.right), Math.abs(activeCenter.y - candidateCenter.y)];
  if (direction === 'right')
    return [verticalOverlap > 0 ? 0 : 1, Math.max(0, candidate.left - active.right), Math.abs(activeCenter.y - candidateCenter.y)];
  if (direction === 'up')
    return [horizontalOverlap > 0 ? 0 : 1, Math.max(0, active.top - candidate.bottom), Math.abs(activeCenter.x - candidateCenter.x)];
  return [horizontalOverlap > 0 ? 0 : 1, Math.max(0, candidate.top - active.bottom), Math.abs(activeCenter.x - candidateCenter.x)];
};

const compareSurfaceScores = (first: { score: number[] }, second: { score: number[] }) => {
  for (let index = 0; index < first.score.length; index += 1) {
    const delta = first.score[index] - second.score[index];
    if (delta !== 0) return delta;
  }
  return 0;
};

const rectCenter = (rect: DOMRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
const overlap = (firstStart: number, firstEnd: number, secondStart: number, secondEnd: number) =>
  Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
