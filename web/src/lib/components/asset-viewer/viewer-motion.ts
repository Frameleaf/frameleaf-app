import { AssetMediaSize } from '@frameleaf/sdk';
import {
  canAnimate,
  dock,
  motionFly,
  prefersReducedMotion,
  REDUCED_MOTION_FADE_MS,
  springEasing,
} from '$lib/frameleaf/motion';
import { DURATION, EASE, SNAPPY } from '$lib/frameleaf/tokens';
import { languageManager } from '$lib/managers/language-manager.svelte';
import { getAssetMediaUrl } from '$lib/utils';

/**
 * Motion for moving between items in the viewer.
 *
 * - The holdover: the photo that was on screen stays, as a still, over the incoming one and fades
 *   away, so the canvas never goes black between two items or when a finished edit arrives.
 * - The swipe: a sideways drag at normal zoom moves the photo with the finger, shows the neighbour
 *   beside it, and moves on past a quarter of the width or on a flick. It is the horizontal twin
 *   of the drag-to-close in `$lib/frameleaf/viewer-gesture`.
 *
 * Every animation here is script-driven, so each one checks Reduce Motion itself: movement
 * becomes the short crossfade.
 */

/** The information card is a bottom sheet at this width and below (AssetViewer's phone rules). */
export const isPhoneSheet = (): boolean => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;

/**
 * The information card arriving (`in:infoCardIn`): from its side on the spring as a card, rising as a
 * phone sheet. A crossfade under Reduce Motion, like every gated transition.
 */
export const infoCardIn = (node: Element) =>
  isPhoneSheet()
    ? dock(node, { y: 24 })
    : motionFly(node, { x: languageManager.rtl ? -16 : 16, duration: DURATION.dock, easing: springEasing });

/** The thumbnail the grid already loaded for an item, shown beside the photo while a swipe drags it. */
export const neighbourThumbnail = (target: { id: string; thumbhash?: string | null } | undefined) =>
  target ? getAssetMediaUrl({ id: target.id, cacheKey: target.thumbhash, size: AssetMediaSize.Thumbnail }) : undefined;

export type HoldoverBox = { src: string; left: number; top: number; width: number; height: number };

/** Where a painted image sits inside `frame`, with the address it shows; null when it has nothing painted. */
export const captureHoldover = (
  image: HTMLImageElement | null | undefined,
  frame: HTMLElement | null | undefined,
): HoldoverBox | null => {
  if (!image || !frame || !image.isConnected || !image.complete || image.naturalWidth === 0) {
    return null;
  }
  const src = image.currentSrc || image.src;
  const box = image.getBoundingClientRect();
  if (!src || box.width <= 0 || box.height <= 0) {
    return null;
  }
  const outer = frame.getBoundingClientRect();
  return { src, left: box.left - outer.left, top: box.top - outer.top, width: box.width, height: box.height };
};

/**
 * Fades `node` out, then calls `done`. `done` runs at once where nothing can animate. Returns a
 * function that stops the fade without calling `done`.
 */
export const fadeAway = (
  node: Element | null | undefined,
  done: () => void,
  duration: number = DURATION.slow,
): (() => void) => {
  if (!canAnimate(node) || !node.isConnected) {
    done();
    return () => {};
  }
  const animation = node.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: prefersReducedMotion() ? REDUCED_MOTION_FADE_MS : duration,
    easing: EASE,
    fill: 'forwards',
  });
  let cancelled = false;
  void animation.finished
    .then(() => {
      if (!cancelled) {
        done();
      }
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    animation.cancel();
  };
};

/** How far, in px, an item arriving by arrow key or button travels. */
export const ARRIVE_OFFSET = 16;

/** A short settle from the side the new item came from (1: the right, -1: the left). Nothing under Reduce Motion. */
export const arriveFrom = (node: Element | null | undefined, side: 1 | -1): void => {
  if (!canAnimate(node) || prefersReducedMotion()) {
    return;
  }
  node.animate([{ translate: `${side * ARRIVE_OFFSET}px 0` }, { translate: '0 0' }], {
    duration: DURATION.slow,
    easing: SNAPPY,
  });
};

/** Sideways travel (px) before the photo starts to follow. */
export const SWIPE_THRESHOLD = 8;
/** Share of the width past which a release moves on. */
export const SWIPE_COMMIT_RATIO = 0.25;
/** A flick: at least this fast (px per ms) over at least this far (px). */
export const SWIPE_FLICK_VELOCITY = 0.5;
export const SWIPE_FLICK_DISTANCE = 30;
/** How much of the finger's travel the photo follows when there is nothing on that side. */
export const SWIPE_RUBBER_BAND = 0.3;
/** The gap (px) between the photo and the neighbour shown beside it. */
export const SWIPE_GAP = 16;

export type SwipeOrder = 'previous' | 'next';

export type ViewerSwipeHandlers = {
  /** Whether there is an item on that side. */
  canGo: (order: SwipeOrder) => boolean;
  /** The drag took over the pointer (once per drag). */
  onEngage?: () => void;
  /** The photo's sideways offset, in px. */
  onDrag: (x: number) => void;
  /** The drag ended without moving on: put the photo back. */
  onRelease: () => void;
  onCommit: (order: SwipeOrder) => void;
};

type SwipeStart = {
  pointerId: number;
  x: number;
  y: number;
  width: number;
  engaged: boolean;
  lastX: number;
  lastTime: number;
  velocity: number;
};

/** Dragging towards the left shows what comes next. */
const orderFor = (dx: number): SwipeOrder => (dx < 0 ? 'next' : 'previous');

export class ViewerSwipe {
  #start: SwipeStart | null = null;
  #handlers: ViewerSwipeHandlers;
  #now: () => number;

  constructor(handlers: ViewerSwipeHandlers, now: () => number = () => performance.now()) {
    this.#handlers = handlers;
    this.#now = now;
  }

  get active() {
    return this.#start !== null;
  }

  get engaged() {
    return !!this.#start?.engaged;
  }

  /** The pointer being followed, if any. */
  get pointerId(): number | undefined {
    return this.#start?.pointerId;
  }

  /** A pointer went down on the photo; `width` is the width the photo can travel. */
  start(pointerId: number, x: number, y: number, width: number) {
    if (this.#start) {
      this.cancel();
      return;
    }
    this.#start = { pointerId, x, y, width, engaged: false, lastX: x, lastTime: this.#now(), velocity: 0 };
  }

  /** Returns true once the drag owns the pointer. */
  move(pointerId: number, x: number, y: number): boolean {
    const start = this.#start;
    if (!start || start.pointerId !== pointerId) {
      return false;
    }
    const dx = x - start.x;
    if (!start.engaged) {
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(y - start.y)) {
        return false;
      }
      start.engaged = true;
      this.#handlers.onEngage?.();
    }
    const now = this.#now();
    if (now > start.lastTime) {
      start.velocity = (x - start.lastX) / (now - start.lastTime);
      start.lastX = x;
      start.lastTime = now;
    }
    this.#handlers.onDrag(this.#handlers.canGo(orderFor(dx)) ? dx : dx * SWIPE_RUBBER_BAND);
    return true;
  }

  end(pointerId: number, x: number) {
    const start = this.#start;
    if (!start || start.pointerId !== pointerId) {
      return;
    }
    this.#start = null;
    if (!start.engaged) {
      return;
    }
    const dx = x - start.x;
    const order = orderFor(dx);
    const far = Math.abs(dx) > start.width * SWIPE_COMMIT_RATIO;
    const flicked =
      Math.abs(dx) > SWIPE_FLICK_DISTANCE &&
      Math.abs(start.velocity) > SWIPE_FLICK_VELOCITY &&
      Math.sign(start.velocity) === Math.sign(dx);
    if ((far || flicked) && this.#handlers.canGo(order)) {
      this.#handlers.onCommit(order);
    } else {
      this.#handlers.onRelease();
    }
  }

  cancel() {
    const wasEngaged = this.engaged;
    this.#start = null;
    if (wasEngaged) {
      this.#handlers.onRelease();
    }
  }
}
