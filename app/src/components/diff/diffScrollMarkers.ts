import type { SyntaxSide } from '../../lib/protocol';
import type { DiffScrollMarker, DiffScrollMarkerKind } from './DiffScrollbar.vue';

type DiffScrollMarkerRange = {
  kind: DiffScrollMarkerKind;
  top: number;
  bottom: number;
};

export const buildDiffScrollMarkers = <T>(
  items: T[],
  options: {
    estimateSize: (item: T) => number;
    kindForItem: (item: T) => DiffScrollMarkerKind | DiffScrollMarkerKind[] | undefined;
    side?: SyntaxSide;
  },
): DiffScrollMarker[] => {
  const totalSize = items.reduce((sum, item) => sum + options.estimateSize(item), 0);
  if (totalSize <= 0) return [];

  const markerRanges: DiffScrollMarkerRange[] = [];
  let offset = 0;
  items.forEach((item) => {
    const size = options.estimateSize(item);
    const kinds = markerKinds(options.kindForItem(item)).filter((kind) => markerVisibleForSide(kind, options.side));
    if (kinds.length > 0) {
      const top = (offset / totalSize) * 100;
      const bottom = Math.max(((offset + size) / totalSize) * 100, top + 0.45);
      markerRanges.push(...kinds.map((kind) => ({ kind, top, bottom })));
    }
    offset += size;
  });

  return mergeMarkerRanges(markerRanges).map((marker, index) => ({
    key: `${marker.kind}:${index}`,
    kind: marker.kind,
    style: {
      top: `${marker.top}%`,
      height: `${marker.bottom - marker.top}%`,
    },
  }));
};

const mergeMarkerRanges = (ranges: DiffScrollMarkerRange[]) => {
  const merged: DiffScrollMarkerRange[] = [];
  const sorted = [...ranges].sort((first, second) => markerPriority(first.kind) - markerPriority(second.kind) || first.top - second.top);
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous?.kind === range.kind && range.top <= previous.bottom + 0.15) {
      previous.bottom = Math.max(previous.bottom, range.bottom);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.sort((first, second) => first.top - second.top || markerPriority(first.kind) - markerPriority(second.kind));
};

const markerKinds = (kind: DiffScrollMarkerKind | DiffScrollMarkerKind[] | undefined): DiffScrollMarkerKind[] => {
  if (!kind) return [];
  return Array.isArray(kind) ? kind : [kind];
};

const markerVisibleForSide = (kind: DiffScrollMarkerKind, side?: SyntaxSide) => {
  if (kind !== 'added' && kind !== 'deleted') return true;
  if (side === 'old') return kind === 'deleted';
  if (side === 'new') return kind === 'added';
  return true;
};

const markerPriority = (kind: DiffScrollMarkerKind) => {
  return {
    added: 1,
    deleted: 1,
    review: 2,
    'diagnostic-error': 3,
    'diagnostic-warning': 4,
    'diagnostic-info': 5,
    search: 6,
    'active-search': 7,
  }[kind];
};
