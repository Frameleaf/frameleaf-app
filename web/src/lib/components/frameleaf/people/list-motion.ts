import type { AnimationConfig } from 'svelte/animate';
import type { TransitionConfig } from 'svelte/transition';
import {
  FLIP_DURATION_MS,
  FLIP_TILE_LIMIT,
  motionFade,
  motionFlip,
  motionScale,
  springEasing,
} from '$lib/frameleaf/motion';
import { DURATION } from '$lib/frameleaf/tokens';

/**
 * Reflow for keyed lists of cards (people, pets, albums, shared links): when the list is sorted,
 * filtered, reordered or loses an item, cards slide to their new place instead of jumping, the
 * removed card shrinks away and a new one fades in. All three go through the gated helpers in
 * motion.ts, so Reduce Motion gets no movement and a short crossfade.
 *
 * `count` is the length of the list. Past `FLIP_TILE_LIMIT` nothing animates: a long list changes
 * at once, as the photo grid does.
 */
export type ListMotionParams = { count?: number };

const still = (params?: ListMotionParams) => (params?.count ?? 0) > FLIP_TILE_LIMIT;

/** `animate:listFlip={{ count }}` on the keyed element. */
export const listFlip = (
  node: Element,
  boxes: { from: DOMRect; to: DOMRect },
  params?: ListMotionParams,
): AnimationConfig =>
  still(params) ? { duration: 0 } : motionFlip(node, boxes, { duration: FLIP_DURATION_MS, easing: springEasing });

/** `in:listEnter={{ count }}`: a card that joins the list. */
export const listEnter = (node: Element, params?: ListMotionParams): TransitionConfig =>
  still(params) ? { duration: 0 } : motionFade(node, { duration: DURATION.base });

/** `out:listLeave={{ count }}`: a card that leaves it. */
export const listLeave = (node: Element, params?: ListMotionParams): TransitionConfig =>
  still(params) ? { duration: 0 } : motionScale(node, { start: 0.94, duration: DURATION.base });
