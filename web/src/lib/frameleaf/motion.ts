import { flushSync, tick } from 'svelte';
import { flip, type AnimationConfig, type FlipParams } from 'svelte/animate';
import {
  fade,
  fly,
  scale,
  slide,
  type FlyParams,
  type ScaleParams,
  type SlideParams,
  type TransitionConfig,
} from 'svelte/transition';
import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';

/**
 * Motion helpers shared by the library, viewer and panels, ported from the September 24
 * template's interactions.js. Every helper checks Reduce Motion in JavaScript as well as the
 * CSS clamp in tokens.css: Svelte transitions and the Web Animations API run outside CSS
 * `animation-duration`, so movement is turned into a crossfade (or an instant change) here.
 */

/** The crossfade that replaces a moving transition under Reduce Motion (apple-style.css:473-490). */
export const REDUCED_MOTION_FADE_MS = 150;

/** The FLIP reflow length and the most tiles it animates (interactions.js animateGridChange). */
export const FLIP_DURATION_MS = 420;
export const FLIP_TILE_LIMIT = 120;

export const prefersReducedMotion = (): boolean => mediaQueryManager.reducedMotion;

type Transition<P> = (node: Element, params?: P) => TransitionConfig;

const crossfade = (node: Element, delay?: number) => fade(node, { delay, duration: REDUCED_MOTION_FADE_MS });

const gated =
  <P extends { delay?: number }>(move: Transition<P>): Transition<P> =>
  (node, params) =>
    prefersReducedMotion() ? crossfade(node, params?.delay) : move(node, params);

/** `fly`, or a crossfade under Reduce Motion. */
export const motionFly: Transition<FlyParams> = gated((node, params) => fly(node, params));
/** `slide`, or a crossfade under Reduce Motion. */
export const motionSlide: Transition<SlideParams> = gated((node, params) => slide(node, params));
/** `scale`, or a crossfade under Reduce Motion. */
export const motionScale: Transition<ScaleParams> = gated((node, params) => scale(node, params));

/** `animate:flip`, or no movement under Reduce Motion (items take their new place at once). */
export const motionFlip = (
  node: Element,
  boxes: { from: DOMRect; to: DOMRect },
  params?: FlipParams,
): AnimationConfig => (prefersReducedMotion() ? { duration: 0 } : flip(node, boxes, params));

type ViewTransitionStarter = (update: () => Promise<void>) => unknown;

/**
 * Runs `update` inside a view transition (apple-style.css:332-349, interactions.js
 * viewerTransition) where the browser supports one and motion is allowed; otherwise it just
 * runs the update. Resolves once the update has been applied; the browser always runs the
 * callback, even when it skips the animation.
 */
export const withViewTransition = async (update: () => Promise<void> | void): Promise<void> => {
  const start =
    typeof document === 'undefined'
      ? undefined
      : (Reflect.get(document, 'startViewTransition') as ViewTransitionStarter | undefined);
  if (!start || prefersReducedMotion()) {
    await update();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    start.call(document, async () => {
      try {
        await update();
        await tick();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
};

/**
 * Grid zoom (interactions.js animateGridChange): applies a new layout, then slides the
 * visible tiles from their old boxes to their new ones (FLIP), so the reflow reads as one
 * continuous zoom. Under Reduce Motion, or without the Web Animations API, the change is instant.
 */
export const animateFlip = (
  container: Element | null | undefined,
  apply: () => void,
  { selector = '[data-asset-id]', duration = FLIP_DURATION_MS } = {},
): void => {
  const tiles = container ? [...container.querySelectorAll<HTMLElement>(selector)].slice(0, FLIP_TILE_LIMIT) : [];
  const before = new Map(tiles.map((tile) => [tile, tile.getBoundingClientRect()]));
  flushSync(apply);
  if (!container || prefersReducedMotion()) {
    return;
  }
  const easing = getComputedStyle(container).getPropertyValue('--fl-spring').trim() || 'ease-out';
  for (const [tile, from] of before) {
    const to = tile.getBoundingClientRect();
    if (!to.width || !tile.isConnected || typeof tile.animate !== 'function') {
      continue;
    }
    tile.animate(
      [
        {
          transformOrigin: '0 0',
          transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})`,
        },
        { transformOrigin: '0 0', transform: 'none' },
      ],
      { duration, easing },
    );
  }
};
