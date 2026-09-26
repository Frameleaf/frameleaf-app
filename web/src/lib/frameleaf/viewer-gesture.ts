/**
 * The hands-on viewer's pointer gesture (FL-35), ported from the September 24 template's
 * `startPan` / `trackDismiss` / `endDismiss` (MediaViewer.jsx:524-578, "#13 tap hides the controls; a
 * downward swipe at normal zoom closes the viewer").
 *
 * - A short, still press toggles the viewer chrome.
 * - A downward drag follows the finger (the photo shrinks and the black fades as it goes) and closes
 *   the viewer once it has travelled far enough; a shorter drag springs back.
 *
 * It follows one pointer. A second finger going down (a pinch) cancels it at once, and moves or
 * releases of any other pointer are ignored, so pinching at normal zoom never closes the viewer.
 *
 * The gesture only starts at normal zoom; the caller decides that, and which targets are exempt
 * (buttons, links, fields, video controls). It follows the vertical movement only once the drag is
 * mostly downward, so a sideways swipe to the next item never starts closing the viewer.
 */

/** Travel (px) before a drag starts to move the photo. */
export const DRAG_THRESHOLD = 8;
/** Downward travel (px) that closes the viewer on release. */
export const DISMISS_DISTANCE = 110;
/** Travel (px) over which the photo shrinks and the backdrop fades completely. */
export const DISMISS_RANGE = 400;
/** A tap moves less than this (px)… */
export const TAP_SLOP = 6;
/** …and is released within this many milliseconds. */
export const TAP_DURATION_MS = 280;

export type DismissDrag = {
  /** Sideways follow, at half the finger's travel as in the template. */
  x: number;
  y: number;
  /** 0 at rest, 1 at `DISMISS_RANGE`. */
  progress: number;
};

export type ViewerGestureHandlers = {
  onDrag: (drag: DismissDrag) => void;
  /** The drag ended without closing: put the photo back. */
  onRelease: () => void;
  onDismiss: () => void;
  onTap: () => void;
};

type Start = { pointerId: number; x: number; y: number; time: number; dragging: boolean };

export class ViewerGesture {
  #start: Start | null = null;
  #handlers: ViewerGestureHandlers;
  #now: () => number;

  constructor(handlers: ViewerGestureHandlers, now: () => number = () => performance.now()) {
    this.#handlers = handlers;
    this.#now = now;
  }

  get active() {
    return this.#start !== null;
  }

  /** The pointer being followed, if any. */
  get pointerId(): number | undefined {
    return this.#start?.pointerId;
  }

  get dragging() {
    return !!this.#start?.dragging;
  }

  /** A pointer went down. A second pointer while one is followed is a pinch: the gesture ends. */
  start(pointerId: number, x: number, y: number) {
    if (this.#start) {
      this.cancel();
      return;
    }
    this.#start = { pointerId, x, y, time: this.#now(), dragging: false };
  }

  /** Returns true while the gesture owns the pointer. */
  move(pointerId: number, x: number, y: number): boolean {
    const start = this.#start;
    if (!start || start.pointerId !== pointerId) {
      return false;
    }
    const dx = x - start.x;
    const dy = Math.max(0, y - start.y);
    if (!start.dragging) {
      if (dy < DRAG_THRESHOLD || dy < Math.abs(dx)) {
        return true;
      }
      start.dragging = true;
    }
    this.#handlers.onDrag({ x: dx * 0.5, y: dy, progress: Math.min(1, dy / DISMISS_RANGE) });
    return true;
  }

  end(pointerId: number, x: number, y: number) {
    const start = this.#start;
    if (!start || start.pointerId !== pointerId) {
      return;
    }
    this.#start = null;
    const dy = y - start.y;
    if (start.dragging) {
      if (dy > DISMISS_DISTANCE) {
        this.#handlers.onDismiss();
      } else {
        this.#handlers.onRelease();
      }
      return;
    }
    if (Math.hypot(x - start.x, dy) < TAP_SLOP && this.#now() - start.time < TAP_DURATION_MS) {
      this.#handlers.onTap();
    }
  }

  cancel() {
    const wasDragging = this.dragging;
    this.#start = null;
    if (wasDragging) {
      this.#handlers.onRelease();
    }
  }
}

/** Targets that keep their own pointer behaviour: controls, fields and video players. */
export const GESTURE_EXEMPT_SELECTOR =
  'button, a, input, select, textarea, video, media-controller, [role="button"], [contenteditable="true"]';

export const isGestureExempt = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest(GESTURE_EXEMPT_SELECTOR);
