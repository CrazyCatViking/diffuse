import type { SyntaxSide } from '../../lib/protocol';
import type { DiffScrollMarker } from './DiffScrollbar.vue';

type DiffScrollMarkerRange = {
  kind: 'added' | 'deleted';
  top: number;
  bottom: number;
};

export const buildDiffScrollMarkers = <T>(items: T[], options: {
  estimateSize: (item: T) => number;
  kindForItem: (item: T) => 'added' | 'deleted' | undefined;
  side?: SyntaxSide;
}): DiffScrollMarker[] => {
  const totalSize = items.reduce((sum, item) => sum + options.estimateSize(item), 0);
  if (totalSize <= 0) return [];

  const markerRanges: DiffScrollMarkerRange[] = [];
  let offset = 0;
  items.forEach((item) => {
    const size = options.estimateSize(item);
    const kind = options.kindForItem(item);
    if (kind && markerVisibleForSide(kind, options.side)) {
      const top = offset / totalSize * 100;
      const bottom = Math.max((offset + size) / totalSize * 100, top + 0.45);
      markerRanges.push({ kind, top, bottom });
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
  const sorted = [...ranges].sort((first, second) => first.kind.localeCompare(second.kind) || first.top - second.top);
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous?.kind === range.kind && range.top <= previous.bottom + 0.15) {
      previous.bottom = Math.max(previous.bottom, range.bottom);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.sort((first, second) => first.top - second.top || first.kind.localeCompare(second.kind));
};

const markerVisibleForSide = (kind: 'added' | 'deleted', side?: SyntaxSide) => {
  if (side === 'old') return kind === 'deleted';
  if (side === 'new') return kind === 'added';
  return true;
};
