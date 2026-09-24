import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';

/**
 * Viewport-relative scroll anchoring across the Timeline, Browse and Work layouts (FL-33, ported
 * from PR #133's `captureLibraryAnchor` / `restoreLibraryAnchor`).
 *
 * Restoring by asset id alone brings the asset into view but lands it at whichever edge is nearer.
 * An anchor also keeps how far below the top of the viewport the asset was, so a layout switch
 * leaves the same asset at the same height on screen.
 */
export type LibraryAnchor = {
  assetId: string;
  /** Distance from the top of the viewport to the top of the asset, before the switch. */
  offset: number;
};

/**
 * The asset to hold still across a layout switch: `preferredId` (the session's focused asset) when
 * it is on screen, otherwise the first asset the viewport shows. Only laid-out, loaded assets are
 * read; nothing is fetched.
 */
export function captureLibraryAnchor(manager: TimelineManager, preferredId?: string | null): LibraryAnchor | undefined {
  const viewportTop = manager.scrollTop;
  const viewportBottom = viewportTop + manager.viewportHeight;
  let first: LibraryAnchor | undefined;

  for (const month of manager.months) {
    for (const day of month.timelineDays) {
      for (const viewer of day.activeViewerAssets) {
        const position = viewer.position;
        if (!position) {
          continue;
        }
        const top = month.top + day.top + month.groupHeaderHeight + position.top;
        const visible = top + position.height > viewportTop && (manager.viewportHeight === 0 || top < viewportBottom);
        if (!visible) {
          continue;
        }
        const anchor = { assetId: viewer.id, offset: top - viewportTop };
        if (!preferredId || viewer.id === preferredId) {
          return anchor;
        }
        first ??= anchor;
      }
    }
  }

  return first;
}

/**
 * Put the anchored asset back at the same height in the viewport. An asset that is no longer
 * loaded — the scope was replaced, or it was deleted or revoked — is never fetched or resurrected
 * by a layout change: the answer is `false` and the caller falls back to its own restoration.
 */
export function restoreLibraryAnchor(manager: TimelineManager, anchor: LibraryAnchor | undefined): boolean {
  if (!anchor) {
    return false;
  }
  const month = manager.getTimelineMonthByAssetId(anchor.assetId);
  const position = month?.findAssetAbsolutePosition(anchor.assetId);
  if (!position) {
    return false;
  }
  const target = Math.max(0, Math.min(Math.max(0, manager.maxScroll), position.top - anchor.offset));
  manager.scrollTo(target);
  manager.updateSlidingWindow();
  return true;
}
