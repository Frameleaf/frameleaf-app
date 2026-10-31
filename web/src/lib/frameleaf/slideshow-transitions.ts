/**
 * Slideshow transitions (FL-36), ported from the September 24 template's media-viewer.mjs
 * (`SLIDESHOW_TRANSITIONS`, `effectiveTransition`, `kenBurnsMove`, media-viewer.mjs:882-912).
 *
 * The transition used to be a boolean persisted as `slideshow-transition` (on = fade). It is
 * now one of five transitions stored under the same key; `parseSlideshowTransition` reads a
 * stored boolean as the transition it meant, so nobody loses their choice.
 */

export enum SlideshowTransition {
  None = 'none',
  Fade = 'fade',
  Slide = 'slide',
  KenBurns = 'ken-burns',
  Memories = 'memories',
}

/** In the order the settings list them (media-viewer.mjs:883-889). Fade stays the default. */
export const SLIDESHOW_TRANSITIONS: readonly SlideshowTransition[] = Object.freeze([
  SlideshowTransition.None,
  SlideshowTransition.Fade,
  SlideshowTransition.Slide,
  SlideshowTransition.KenBurns,
  SlideshowTransition.Memories,
]);

export const DEFAULT_SLIDESHOW_TRANSITION = SlideshowTransition.Fade;

const isTransition = (value: unknown): value is SlideshowTransition =>
  typeof value === 'string' && (SLIDESHOW_TRANSITIONS as readonly string[]).includes(value);

/**
 * Reads a stored value. The legacy boolean maps true to fade and false to none; anything
 * unknown falls back to the default rather than failing.
 */
export const parseSlideshowTransition = (value: unknown): SlideshowTransition => {
  if (value === true) {
    return SlideshowTransition.Fade;
  }
  if (value === false) {
    return SlideshowTransition.None;
  }
  return isTransition(value) ? value : DEFAULT_SLIDESHOW_TRANSITION;
};

/** The `svelte-persisted-store` serializer that migrates the old boolean in place. */
export const slideshowTransitionSerializer = {
  parse: (raw: string): SlideshowTransition => {
    try {
      return parseSlideshowTransition(JSON.parse(raw));
    } catch {
      return parseSlideshowTransition(raw);
    }
  },
  stringify: (value: SlideshowTransition): string => JSON.stringify(parseSlideshowTransition(value)),
};

const MOVING: ReadonlySet<SlideshowTransition> = new Set([
  SlideshowTransition.Slide,
  SlideshowTransition.KenBurns,
  SlideshowTransition.Memories,
]);

/** Reduce Motion keeps the pacing but swaps moving transitions for a fade (media-viewer.mjs:890-898). */
export const effectiveTransition = (transition: unknown, reducedMotion = false): SlideshowTransition => {
  const known = parseSlideshowTransition(transition);
  return reducedMotion && MOVING.has(known) ? SlideshowTransition.Fade : known;
};

export type KenBurnsMove = { from: string; to: string };

const KEN_BURNS_MOVES: readonly KenBurnsMove[] = Object.freeze([
  { from: 'scale(1) translate(0, 0)', to: 'scale(1.14) translate(-3%, -2%)' },
  { from: 'scale(1.14) translate(3%, 2%)', to: 'scale(1.02) translate(0, 0)' },
  { from: 'scale(1.1) translate(-4%, 0)', to: 'scale(1.1) translate(4%, 0)' },
  { from: 'scale(1.08) translate(0, 3%)', to: 'scale(1.16) translate(0, -3%)' },
]);

/** Deterministic pan and zoom per asset, so the same photo always moves the same way. */
export const kenBurnsMove = (assetId: string | null | undefined): KenBurnsMove => {
  let hash = 0;
  for (const character of assetId ?? '') {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return KEN_BURNS_MOVES[hash % KEN_BURNS_MOVES.length];
};
