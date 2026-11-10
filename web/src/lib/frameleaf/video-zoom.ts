import { prefersReducedMotion } from '$lib/frameleaf/motion';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';

/**
 * FL-801: zoom and pan inside a video (prototype `MediaViewer.jsx`, `zoomable` for a playable video).
 *
 * The picture is moved with a CSS transform on the video element alone, so the playback controls,
 * the seek bar and the captions beside it keep their size and place, and playback is untouched. The
 * zoom is the viewer's own (`assetViewerManager`), so the footer's Zoom out / Fit / Zoom in, the
 * `z`, `+`, `-` and `0` keys and the wheel, pinch, double-click and double-tap all act on it.
 */

/** The same ceiling as the photo zoom (`zoom-image.ts`, `ViewerFooter`). */
export const VIDEO_MAX_ZOOM = 10;
/** A double-click or double-tap goes this far in from fit, and back. */
export const VIDEO_POINT_ZOOM = 2;
// The share of the current zoom one wheel unit adds, and the most taken from one wheel event (photo zoom).
const WHEEL_ZOOM_RATIO = 0.1;
const WHEEL_DELTA_LIMIT = 0.5;
const POINT_ZOOM_MS = 300;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 32;
/** A press that moves further than this is a drag, and its click does not play or pause. */
const DRAG_SLOP_PX = 4;

export interface VideoZoomView {
  zoom: number;
  x: number;
  y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Keeps the zoomed picture over the whole frame: the transform's origin is the top-left corner, so the
 * offset runs from 0 (left or top edge showing) to the frame size times the zoom beyond fit.
 */
export const clampVideoView = (view: VideoZoomView, width: number, height: number): VideoZoomView => {
  const zoom = clamp(Number.isFinite(view.zoom) ? view.zoom : 1, 1, VIDEO_MAX_ZOOM);
  if (zoom === 1) {
    return { zoom, x: 0, y: 0 };
  }
  return {
    zoom,
    x: clamp(view.x, -width * (zoom - 1), 0),
    y: clamp(view.y, -height * (zoom - 1), 0),
  };
};

/** The view at `zoom` that keeps the point (`px`, `py`, relative to the frame) where it is on screen. */
export const zoomVideoAt = (
  view: VideoZoomView,
  zoom: number,
  px: number,
  py: number,
  width: number,
  height: number,
): VideoZoomView => {
  const next = clamp(zoom, 1, VIDEO_MAX_ZOOM);
  const ratio = next / view.zoom;
  return clampVideoView({ zoom: next, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio }, width, height);
};

/** The zoom one wheel event asks for: a negative `deltaY` zooms in. */
export const wheelVideoZoom = (zoom: number, deltaY: number) =>
  zoom + clamp(-deltaY, -WHEEL_DELTA_LIMIT, WHEEL_DELTA_LIMIT) * WHEEL_ZOOM_RATIO * zoom;

export const videoTransform = ({ zoom, x, y }: VideoZoomView) =>
  zoom === 1 ? '' : `translate(${x}px, ${y}px) scale(${zoom})`;

const pointZoomEase = (t: number): number => 1 - Math.pow(1 - t, 4);

export interface VideoZoomOptions {
  /** The video element the transform moves. */
  target: HTMLElement | undefined;
  /** Off for a cast or a video that cannot zoom; the picture returns to fit. */
  enabled: boolean;
}

const clearTransform = (target: HTMLElement | undefined) => {
  if (target) {
    target.style.transform = '';
    target.style.willChange = '';
  }
};

/**
 * On the player's frame (`media-controller`), which is the video's own box. Only presses on the
 * picture count: the controls are children of the frame, and a press on them is theirs.
 */
export const videoZoomAction = (node: HTMLElement, initial: VideoZoomOptions) => {
  let options = initial;
  let view: VideoZoomView = { zoom: 1, x: 0, y: 0 };
  let pointZoomFrame: number | null = null;

  const size = () => ({ width: node.clientWidth, height: node.clientHeight });

  const apply = (next: VideoZoomView) => {
    const { width, height } = size();
    view = clampVideoView(next, width, height);
    const target = options.target;
    if (target) {
      target.style.transformOrigin = '0 0';
      target.style.transform = videoTransform(view);
      target.style.willChange = view.zoom === 1 ? '' : 'transform';
    }
    node.toggleAttribute('data-zoomed', view.zoom > 1);
    // Pinch and drag on the picture are the viewer's, not the page's.
    node.style.touchAction = options.enabled ? 'none' : '';
  };

  /** A gesture here: the viewer's zoom follows without echoing back to this frame. */
  const commit = (next: VideoZoomView) => {
    apply(next);
    assetViewerManager.onZoomChange({
      ...assetViewerManager.zoomState,
      currentZoom: view.zoom,
      currentPositionX: view.x,
      currentPositionY: view.y,
    });
  };

  const cancelPointZoom = () => {
    if (pointZoomFrame !== null) {
      cancelAnimationFrame(pointZoomFrame);
      pointZoomFrame = null;
    }
  };

  const stopAnimations = () => {
    assetViewerManager.cancelZoomAnimation();
    cancelPointZoom();
  };

  const isOnPicture = (event: Event) => options.enabled && (event.target === node || event.target === options.target);

  const pointFor = (clientX: number, clientY: number) => {
    const rect = node.getBoundingClientRect();
    return { px: clientX - rect.left, py: clientY - rect.top };
  };

  /** Double-click or double-tap: in to 2x toward the point, or back to fit. */
  const togglePointZoom = (clientX: number, clientY: number) => {
    stopAnimations();
    const { px, py } = pointFor(clientX, clientY);
    const { width, height } = size();
    const start = view;
    const goal = start.zoom > 1 ? 1 : VIDEO_POINT_ZOOM;
    if (prefersReducedMotion()) {
      commit(zoomVideoAt(start, goal, px, py, width, height));
      return;
    }
    const startTime = performance.now();
    const frame = (now: number) => {
      const progress = Math.min((now - startTime) / POINT_ZOOM_MS, 1);
      const zoom = start.zoom + (goal - start.zoom) * pointZoomEase(progress);
      commit(zoomVideoAt(start, zoom, px, py, width, height));
      pointZoomFrame = progress < 1 ? requestAnimationFrame(frame) : null;
    };
    pointZoomFrame = requestAnimationFrame(frame);
  };

  // The footer, the keys and a reset (a new item) change the zoom through the viewer: they zoom about
  // the middle of the frame, as the photo zoom does.
  const unsubscribe = assetViewerManager.on({
    ZoomChange: (state) => {
      cancelPointZoom();
      if (state.currentZoom === view.zoom) {
        return;
      }
      const { width, height } = size();
      commit(zoomVideoAt(view, options.enabled ? state.currentZoom : 1, width / 2, height / 2, width, height));
    },
  });

  const pointers = new Map<number, { x: number; y: number }>();
  let pan: { x: number; y: number; view: VideoZoomView } | null = null;
  let pinchDistance: number | null = null;
  let pressStart: { x: number; y: number } | null = null;
  let dragged = false;
  let lastPointerType = '';
  let lastTap: { time: number; x: number; y: number } | null = null;

  const startPan = () => {
    const [first] = pointers.values();
    pan = first && view.zoom > 1 ? { x: first.x, y: first.y, view } : null;
  };

  const pinchState = () => {
    const [a, b] = pointers.values();
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      centerX: (a.x + b.x) / 2,
      centerY: (a.y + b.y) / 2,
    };
  };

  const onPointerDown = (event: PointerEvent) => {
    lastPointerType = event.pointerType;
    if (!isOnPicture(event) || event.button > 0) {
      return;
    }
    stopAnimations();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      pressStart = { x: event.clientX, y: event.clientY };
      dragged = false;
      if (event.pointerType === 'touch') {
        const tap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
        const isDoubleTap =
          lastTap !== null &&
          tap.time - lastTap.time <= DOUBLE_TAP_MS &&
          Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) <= DOUBLE_TAP_SLOP_PX;
        lastTap = isDoubleTap ? null : tap;
        if (isDoubleTap) {
          togglePointZoom(tap.x, tap.y);
        }
      }
      startPan();
    } else if (pointers.size === 2) {
      pan = null;
      lastTap = null;
      pinchDistance = pinchState().distance;
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) {
      return;
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (pressStart && Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > DRAG_SLOP_PX) {
      dragged = true;
      lastTap = null;
    }
    if (pinchDistance !== null && pointers.size === 2) {
      const { distance, centerX, centerY } = pinchState();
      if (pinchDistance > 0 && distance > 0) {
        const { px, py } = pointFor(centerX, centerY);
        const { width, height } = size();
        commit(zoomVideoAt(view, view.zoom * (distance / pinchDistance), px, py, width, height));
      }
      pinchDistance = distance;
      return;
    }
    if (pan && pointers.size === 1) {
      event.preventDefault();
      commit({ ...pan.view, x: pan.view.x + event.clientX - pan.x, y: pan.view.y + event.clientY - pan.y });
    }
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) {
      return;
    }
    pinchDistance = null;
    if (pointers.size === 1) {
      // The finger left on the picture after a pinch carries on as a pan.
      startPan();
    } else {
      pan = null;
    }
  };

  // A drag that moved the picture is not a click: the player would otherwise play or pause.
  const onClick = (event: MouseEvent) => {
    if (dragged && isOnPicture(event)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    dragged = false;
  };

  const onDoubleClick = (event: MouseEvent) => {
    // A touch double-tap was handled on its second press; the browser's dblclick after it is not another.
    if (!isOnPicture(event) || lastPointerType === 'touch') {
      return;
    }
    event.preventDefault();
    togglePointZoom(event.clientX, event.clientY);
  };

  const onWheel = (event: WheelEvent) => {
    if (!isOnPicture(event)) {
      return;
    }
    event.preventDefault();
    stopAnimations();
    const { px, py } = pointFor(event.clientX, event.clientY);
    const { width, height } = size();
    commit(zoomVideoAt(view, wheelVideoZoom(view.zoom, event.deltaY), px, py, width, height));
  };

  const controller = new AbortController();
  const { signal } = controller;
  node.addEventListener('pointerdown', onPointerDown, { signal });
  window.addEventListener('pointermove', onPointerMove, { signal, passive: false });
  window.addEventListener('pointerup', onPointerEnd, { signal });
  window.addEventListener('pointercancel', onPointerEnd, { signal });
  node.addEventListener('click', onClick, { capture: true, signal });
  node.addEventListener('dblclick', onDoubleClick, { signal });
  node.addEventListener('wheel', onWheel, { signal, passive: false });

  apply({ zoom: 1, x: 0, y: 0 });

  return {
    update(next: VideoZoomOptions) {
      if (options.target !== next.target) {
        clearTransform(options.target);
      }
      options = next;
      if (!next.enabled && view.zoom !== 1) {
        commit({ zoom: 1, x: 0, y: 0 });
        return;
      }
      apply(view);
    },
    destroy() {
      cancelPointZoom();
      controller.abort();
      unsubscribe();
      clearTransform(options.target);
    },
  };
};
