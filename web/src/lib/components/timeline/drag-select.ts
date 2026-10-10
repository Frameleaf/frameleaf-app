/**
 * Drag across tiles to extend a touch selection (design review finding 3, follow-up). Press and
 * hold starts the selection on one tile; while the finger stays down, every tile it passes over is
 * added. The tile that took the hold drives it and tells the others through a bubbling event, so
 * no grid has to know about the gesture.
 *
 * A touch keeps its first target for its whole life, so the listeners sit on the element that was
 * pressed. The move listener is not passive: once a selection has begun, the gesture extends it
 * instead of scrolling the page. Until the hold has fired nothing here is attached and the page
 * scrolls as usual.
 */
export const DRAG_SELECT_EVENT = 'fl-drag-select';

export type DragSelectDetail = { assetId: string };

type TouchLike = { touches: ArrayLike<{ clientX: number; clientY: number }> };

/** The tile under a point, if any. */
const tileAt = (x: number, y: number): HTMLElement | null => {
  if (typeof document.elementFromPoint !== 'function') {
    return null;
  }
  const hit = document.elementFromPoint(x, y);
  return hit instanceof Element ? hit.closest<HTMLElement>('[data-asset-id]') : null;
};

/**
 * Begin extending from `origin` (the pressed element inside the first tile). Returns a function
 * that ends the drag; lifting the finger ends it too.
 */
export const beginDragSelect = (origin: HTMLElement, firstAssetId: string): (() => void) => {
  const visited = new Set([firstAssetId]);

  const onMove = (event: Event) => {
    const touch = (event as unknown as TouchLike).touches?.[0];
    if (!touch) {
      return;
    }
    if (event.cancelable) {
      // The finger now paints the selection rather than scrolling the grid.
      event.preventDefault();
    }
    const tile = tileAt(touch.clientX, touch.clientY);
    const assetId = tile?.dataset.assetId;
    if (!tile || !assetId || visited.has(assetId)) {
      return;
    }
    visited.add(assetId);
    tile.dispatchEvent(new CustomEvent<DragSelectDetail>(DRAG_SELECT_EVENT, { bubbles: true, detail: { assetId } }));
  };

  const end = () => {
    origin.removeEventListener('touchmove', onMove);
    origin.removeEventListener('touchend', end);
    origin.removeEventListener('touchcancel', end);
  };

  origin.addEventListener('touchmove', onMove, { passive: false });
  origin.addEventListener('touchend', end);
  origin.addEventListener('touchcancel', end);
  return end;
};
