/**
 * Grid zoom gestures (FL-33), ported from the template's `App.jsx` "#12 grid zoom": a trackpad
 * pinch (which browsers report as a Ctrl + wheel), a two-finger touch pinch, and the + and − keys
 * step the Thumbnail size in Browse and Work.
 *
 * Browser zoom keeps ⌘/Ctrl + and ⌘/Ctrl −: a key with any modifier is never taken, and neither is
 * a key typed into a field or pressed while a dialog is open. The Timeline keeps pinch and ⌘-scroll
 * for its Years / Months / Days grouping, so the caller turns this off there.
 */

/** Wheel distance per step: a trackpad pinch reports many small Ctrl + wheel events. */
export const ZOOM_WHEEL_STEP = 30;
/** Finger travel per step for a two-finger touch pinch, as the Timeline's grouping pinch uses. */
export const ZOOM_PINCH_STEP = 56;

export type GridZoomOptions = {
  /** Step one size larger (1) or smaller (-1). */
  onZoom: (direction: 1 | -1) => void;
  /** Checked on every event; false leaves the event alone (another surface owns the keys). */
  enabled?: () => boolean;
};

const typingInto = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);

/** The + and − keys, never with a modifier (browser zoom keeps ⌘/Ctrl + and −). */
export const zoomKeyDirection = (event: KeyboardEvent): 1 | -1 | null => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || typingInto(event.target)) {
    return null;
  }
  if (event.key === '+' || event.key === '=') {
    return 1;
  }
  return event.key === '-' ? -1 : null;
};

/**
 * Listen for zoom gestures on `element` (wheel and pinch) and the + / − keys on the window.
 * Returns the cleanup.
 */
export const bindGridZoom = (element: HTMLElement, { onZoom, enabled = () => true }: GridZoomOptions) => {
  let wheelTotal = 0;
  const onWheel = (event: WheelEvent) => {
    // Only Ctrl: a trackpad pinch arrives as Ctrl + wheel; ⌘ + wheel is left to the page.
    if (!event.ctrlKey || event.defaultPrevented || !enabled()) {
      return;
    }
    event.preventDefault();
    wheelTotal += event.deltaY;
    if (Math.abs(wheelTotal) < ZOOM_WHEEL_STEP) {
      return;
    }
    onZoom(wheelTotal < 0 ? 1 : -1);
    wheelTotal = 0;
  };

  const touches = new Map<number, { x: number; y: number }>();
  let pinchStart = 0;
  const distance = () => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') {
      return;
    }
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 2) {
      pinchStart = distance();
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!touches.has(event.pointerId)) {
      return;
    }
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size !== 2 || !pinchStart || !enabled()) {
      return;
    }
    const delta = distance() - pinchStart;
    if (Math.abs(delta) < ZOOM_PINCH_STEP) {
      return;
    }
    onZoom(delta > 0 ? 1 : -1);
    pinchStart = distance();
  };
  const onPointerEnd = (event: PointerEvent) => {
    touches.delete(event.pointerId);
    if (touches.size < 2) {
      pinchStart = 0;
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const direction = zoomKeyDirection(event);
    if (direction === null || !enabled() || document.querySelector('dialog[open], [role="dialog"]')) {
      return;
    }
    event.preventDefault();
    onZoom(direction);
  };

  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerEnd);
  element.addEventListener('pointercancel', onPointerEnd);
  addEventListener('keydown', onKeyDown);
  return () => {
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', onPointerEnd);
    element.removeEventListener('pointercancel', onPointerEnd);
    removeEventListener('keydown', onKeyDown);
  };
};
