import { createZoomImageWheel } from '@zoom-image/core';
import { prefersReducedMotion } from '$lib/frameleaf/motion';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';

// Minimal touch shape — avoids importing DOM TouchEvent which isn't available in all TS targets.
type TouchEventLike = {
  touches: Iterable<{ clientX: number; clientY: number }> & { length: number };
  targetTouches: ArrayLike<unknown>;
};
const asTouchEvent = (event: Event) => event as unknown as TouchEventLike;

const MAX_ZOOM = 10;
/** The zoom a double-click or double-tap goes to from the fitted photo; a second one goes back. */
export const POINT_ZOOM = 2;
const POINT_ZOOM_MS = 300;
// Two taps this close together, in time and place, are a double-tap.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 32;
// The share of the current zoom one wheel unit adds, and the most the wheel handler takes from one event.
const WHEEL_ZOOM_RATIO = 0.1;
const WHEEL_DELTA_LIMIT = 0.5;

/**
 * The wheel `deltaY` values that take the zoom from `from` to `to`. The zoom library only zooms
 * about a point for wheel input, and takes at most half a unit from each event, so a zoom toward
 * the pointer is played to it as a run of small wheel steps at that point. Each step multiplies
 * the zoom by the same factor, and together they land on `to` exactly.
 */
export const wheelDeltasForZoom = (from: number, to: number): number[] => {
  if (!(from > 0) || !(to > 0) || Math.abs(to - from) < 1e-6) {
    return [];
  }
  const ratio = to / from;
  const zoomingIn = ratio > 1;
  const largestStep = 1 + (zoomingIn ? 1 : -1) * WHEEL_DELTA_LIMIT * WHEEL_ZOOM_RATIO;
  const steps = Math.max(1, Math.ceil(Math.log(ratio) / Math.log(largestStep) - 1e-9));
  const factor = Math.pow(ratio, 1 / steps);
  // A negative deltaY zooms in.
  const deltaY = -(factor - 1) / WHEEL_ZOOM_RATIO;
  return Array.from({ length: steps }, () => deltaY);
};

const pointZoomEase = (t: number): number => 1 - Math.pow(1 - t, 4);

export const zoomImageAction = (node: HTMLElement, options?: { zoomTarget?: HTMLElement }) => {
  const zoomInstance = createZoomImageWheel(node, {
    maxZoom: MAX_ZOOM,
    wheelZoomRatio: WHEEL_ZOOM_RATIO,
    initialState: assetViewerManager.zoomState,
    zoomTarget: options?.zoomTarget,
  });

  const unsubscribes = [
    assetViewerManager.on({ ZoomChange: (state) => zoomInstance.setState(state) }),
    zoomInstance.subscribe(({ state }) => assetViewerManager.onZoomChange(state)),
  ];

  const controller = new AbortController();
  const { signal } = controller;

  // Zoom toward a point (finding 44): a double-click or double-tap zooms in on what is under the
  // pointer, where the keyboard and toolbar steps zoom about the middle.
  let pointZoomFrame: number | null = null;
  let playingPointZoom = false;
  const cancelPointZoom = () => {
    if (pointZoomFrame === null) {
      return;
    }
    cancelAnimationFrame(pointZoomFrame);
    pointZoomFrame = null;
  };
  const zoomAtPoint = (zoom: number, clientX: number, clientY: number) => {
    playingPointZoom = true;
    try {
      for (const deltaY of wheelDeltasForZoom(zoomInstance.getState().currentZoom, zoom)) {
        node.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX, clientY, cancelable: true }));
      }
    } finally {
      playingPointZoom = false;
    }
  };
  const togglePointZoom = (clientX: number, clientY: number) => {
    assetViewerManager.cancelZoomAnimation();
    cancelPointZoom();
    const start = zoomInstance.getState().currentZoom;
    const target = start > 1 ? 1 : POINT_ZOOM;
    // Reduce Motion: a zoom step is a scaling photo, so it lands at once (as the keyboard steps do).
    if (prefersReducedMotion()) {
      zoomAtPoint(target, clientX, clientY);
      return;
    }
    const startTime = performance.now();
    const frame = (now: number) => {
      const progress = Math.min((now - startTime) / POINT_ZOOM_MS, 1);
      zoomAtPoint(progress < 1 ? start + (target - start) * pointZoomEase(progress) : target, clientX, clientY);
      pointZoomFrame = progress < 1 ? requestAnimationFrame(frame) : null;
    };
    pointZoomFrame = requestAnimationFrame(frame);
  };
  unsubscribes.push(assetViewerManager.on({ ZoomChange: cancelPointZoom }));

  node.addEventListener(
    'pointerdown',
    () => {
      assetViewerManager.cancelZoomAnimation();
      cancelPointZoom();
    },
    { capture: true, signal },
  );

  // Intercept events in capture phase to prevent zoom-image from seeing interactions on
  // overlay elements (e.g. OCR text boxes), preserving browser defaults like text selection.
  const isOverlayEvent = (event: Event) => !!(event.target as HTMLElement).closest('[data-overlay-interactive]');
  const isOverlayAtPoint = (x: number, y: number) =>
    !!document.elementFromPoint(x, y)?.closest('[data-overlay-interactive]');

  // Pointer event interception: track pointers that start on overlays and intercept the entire gesture.
  const overlayPointers = new Set<number>();
  const interceptedPointers = new Set<number>();
  const interceptOverlayPointerDown = (event: PointerEvent) => {
    if (isOverlayEvent(event) || isOverlayAtPoint(event.clientX, event.clientY)) {
      overlayPointers.add(event.pointerId);
      interceptedPointers.add(event.pointerId);
      event.stopPropagation();
    } else if (overlayPointers.size > 0) {
      // Split gesture (e.g. pinch with one finger on overlay) — intercept entirely.
      interceptedPointers.add(event.pointerId);
      event.stopPropagation();
    }
  };
  const interceptOverlayPointerEvent = (event: PointerEvent) => {
    if (interceptedPointers.has(event.pointerId)) {
      event.stopPropagation();
    }
  };
  const interceptOverlayPointerEnd = (event: PointerEvent) => {
    overlayPointers.delete(event.pointerId);
    if (interceptedPointers.delete(event.pointerId)) {
      event.stopPropagation();
    }
  };
  node.addEventListener('pointerdown', interceptOverlayPointerDown, { capture: true, signal });
  node.addEventListener('pointermove', interceptOverlayPointerEvent, { capture: true, signal });
  node.addEventListener('pointerup', interceptOverlayPointerEnd, { capture: true, signal });
  node.addEventListener('pointerleave', interceptOverlayPointerEnd, { capture: true, signal });

  // Touch event interception for overlay touches or split gestures (pinch across container boundary).
  // Once intercepted, stays intercepted until all fingers are lifted.
  let touchGestureIntercepted = false;
  const interceptOverlayTouchEvent = (event: Event) => {
    if (touchGestureIntercepted) {
      event.stopPropagation();
      return;
    }
    const { touches, targetTouches } = asTouchEvent(event);
    if (touches && targetTouches) {
      if (touches.length > targetTouches.length) {
        touchGestureIntercepted = true;
        event.stopPropagation();
        return;
      }
      for (const touch of touches) {
        if (isOverlayAtPoint(touch.clientX, touch.clientY)) {
          touchGestureIntercepted = true;
          event.stopPropagation();
          return;
        }
      }
    } else if (isOverlayEvent(event)) {
      event.stopPropagation();
    }
  };
  const resetTouchGesture = (event: Event) => {
    const { touches } = asTouchEvent(event);
    if (touches.length === 0) {
      touchGestureIntercepted = false;
    }
  };
  node.addEventListener('touchstart', interceptOverlayTouchEvent, { capture: true, signal });

  // Double-tap. The library's own double-tap runs to the maximum zoom, so the second tap is kept
  // from it and zooms to the same level as a double-click, toward the finger.
  let lastTap: { time: number; x: number; y: number } | null = null;
  node.addEventListener(
    'touchstart',
    (event: Event) => {
      const { touches } = asTouchEvent(event);
      const [touch] = touches;
      if (touchGestureIntercepted || touches.length !== 1 || !touch) {
        lastTap = null;
        return;
      }
      const tap = { time: event.timeStamp, x: touch.clientX, y: touch.clientY };
      const isDoubleTap =
        lastTap !== null &&
        tap.time - lastTap.time <= DOUBLE_TAP_MS &&
        Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) <= DOUBLE_TAP_SLOP_PX;
      // Every single-finger touch is kept from the library's double-tap timer; panning and
      // pinching use its pointer and touchmove handlers, which still see their events.
      event.stopImmediatePropagation();
      if (!isDoubleTap) {
        lastTap = tap;
        return;
      }
      lastTap = null;
      togglePointZoom(tap.x, tap.y);
    },
    { capture: true, signal },
  );
  node.addEventListener('touchmove', interceptOverlayTouchEvent, { capture: true, signal });
  node.addEventListener('touchend', resetTouchGesture, { capture: true, signal });

  // Wheel and dblclick interception on overlay elements.
  // Dblclick also intercepted for all touch double-taps (Safari fires synthetic dblclick
  // on double-tap, which conflicts with zoom-image's touch zoom handler).
  let lastPointerWasTouch = false;
  node.addEventListener('pointerdown', (event) => (lastPointerWasTouch = event.pointerType === 'touch'), {
    capture: true,
    signal,
  });
  node.addEventListener(
    'wheel',
    (event) => {
      if (playingPointZoom) {
        return;
      }
      cancelPointZoom();
      if (isOverlayEvent(event)) {
        event.stopPropagation();
      }
    },
    { capture: true, signal },
  );
  node.addEventListener(
    'dblclick',
    (event) => {
      if (lastPointerWasTouch || isOverlayEvent(event)) {
        event.stopImmediatePropagation();
        return;
      }
      togglePointZoom(event.clientX, event.clientY);
    },
    { capture: true, signal },
  );

  node.style.overflow = 'visible';
  node.style.touchAction = 'none';
  return {
    update(newOptions?: { zoomTarget?: HTMLElement }) {
      options = newOptions;
      if (newOptions?.zoomTarget !== undefined) {
        zoomInstance.setState({ zoomTarget: newOptions.zoomTarget });
      }
    },
    destroy() {
      cancelPointZoom();
      controller.abort();
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      zoomInstance.cleanup();
    },
  };
};
