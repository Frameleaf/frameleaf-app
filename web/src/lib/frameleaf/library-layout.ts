import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import type { TimelineMonth } from '$lib/managers/timeline-manager/timeline-month.svelte';
import type { CommonLayoutOptions, CommonPosition } from '$lib/utils/layout-utils';

export type LibraryLayout = 'timeline' | 'browse' | 'work';
export const libraryLayouts: LibraryLayout[] = ['timeline', 'browse', 'work'];
export const normalizeLibraryLayout = (value: unknown): LibraryLayout =>
  libraryLayouts.includes(value as LibraryLayout) ? (value as LibraryLayout) : 'timeline';

/** Equal contact-sheet cells; only the already loaded day's assets participate. */
export function contactSheetPositions(count: number, options: CommonLayoutOptions): CommonPosition[] {
  const columns = Math.max(
    1,
    Math.floor((options.rowWidth + options.spacing) / (options.rowHeight * 1.5 + options.spacing)),
  );
  const width = Math.max(0, (options.rowWidth - options.spacing * (columns - 1)) / columns);
  const height = width / 1.5;
  return Array.from({ length: count }, (_, index) => ({
    top: Math.floor(index / columns) * (height + options.spacing),
    left: (index % columns) * (width + options.spacing),
    width,
    height,
  }));
}

export type LibraryAnchor = { month: TimelineMonth; assetId: string; offset: number };

export function captureLibraryAnchor(manager: TimelineManager): LibraryAnchor | undefined {
  for (const month of manager.months) {
    for (const day of month.timelineDays) {
      for (const viewer of day.activeViewerAssets) {
        const position = viewer.position;
        if (!position) {
          continue;
        }
        const top = month.top + day.top + manager.headerHeight + position.top;
        if (top + position.height > manager.scrollTop) {
          return { month, assetId: viewer.id, offset: top - manager.scrollTop };
        }
      }
    }
  }
}

export function restoreLibraryAnchor(manager: TimelineManager, anchor: LibraryAnchor | undefined) {
  // A replaced scope or revoked/deleted asset must never be fetched or resurrected by a layout change.
  if (!anchor || !manager.months.includes(anchor.month)) {
    return;
  }
  const position = anchor.month.findAssetAbsolutePosition(anchor.assetId);
  if (position) {
    manager.scrollTo(Math.max(0, Math.min(Math.max(0, manager.maxScroll), position.top - anchor.offset)));
    manager.updateSlidingWindow();
  }
}
