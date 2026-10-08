import { flushSync, tick } from 'svelte';
import { flip, type AnimationConfig, type FlipParams } from 'svelte/animate';
import {
  fade,
  fly,
  scale,
  slide,
  type FadeParams,
  type FlyParams,
  type ScaleParams,
  type SlideParams,
  type TransitionConfig,
} from 'svelte/transition';
import { DURATION, EXIT_DURATION, SNAPPY, SPRING_STOPS, STAGGER_LIMIT, STAGGER_MS } from '$lib/frameleaf/tokens';
import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';

/**
 * Motion helpers shared by the library, viewer and panels, ported from the September 24
 * template's interactions.js. Every helper checks Reduce Motion in JavaScript as well as the
 * CSS clamp in tokens.css: Svelte transitions and the Web Animations API run outside CSS
 * `animation-duration`, so movement is turned into a crossfade (or an instant change) here.
 *
 * The motion vocabulary (BRAND.md) has seven patterns. Press is CSS only (base.css). Pop, Sheet,
 * Dock and Reveal exist three ways with the same timing: a CSS class (`fl-pop`, `fl-sheet`,
 * `fl-dock`, `fl-reveal`, plus `fl-leaving` for the exit), a Svelte transition here (`pop`,
 * `sheet`, `dock`, `reveal`, for `in:` and `out:`), and `leave()` for an element that is hidden by
 * script rather than by a Svelte block. Reflow is `animateFlip` / `motionFlip`; Hero is
 * `withViewTransition`, viewer-zoom.ts (a tile and the viewer) and `heroNavigation` (a card and the
 * page it opens).
 */

/** The crossfade that replaces a moving transition under Reduce Motion (apple-style.css:473-490). */
export const REDUCED_MOTION_FADE_MS = DURATION.reduced;

/** The FLIP reflow length and the most tiles it animates (interactions.js animateGridChange). */
export const FLIP_DURATION_MS = DURATION.dock;
export const FLIP_TILE_LIMIT = 120;

/** The Reveal fade: content replacing a skeleton, a section or settings pane arriving. */
export const REVEAL_MS = DURATION.base;

export const prefersReducedMotion = (): boolean => mediaQueryManager.reducedMotion;

/**
 * FL-139: the scroll behaviour for scrollIntoView/scrollTo. A smooth scroll is motion the CSS
 * kill-switch cannot stop (`scroll-behavior` only covers CSS-initiated scrolls), so Reduce Motion jumps.
 */
export const motionScrollBehavior = (): ScrollBehavior => (mediaQueryManager.reducedMotion ? 'auto' : 'smooth');

type Transition<P> = (node: Element, params?: P) => TransitionConfig;

const crossfade = (node: Element, delay?: number) => fade(node, { delay, duration: REDUCED_MOTION_FADE_MS });

const gated =
  <P extends { delay?: number }>(move: Transition<P>): Transition<P> =>
  (node, params) =>
    prefersReducedMotion() ? crossfade(node, params?.delay) : move(node, params);

/**
 * `fade`, and under Reduce Motion the same short crossfade every other helper falls back to. A
 * fade does not move anything, so it stays; it goes through here so every Svelte transition in the
 * app has one Reduce Motion gate (FL-29).
 */
export const motionFade: Transition<FadeParams> = gated((node, params) => fade(node, params));
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

type ViewTransitionLike = {
  ready?: Promise<unknown>;
  finished?: Promise<unknown>;
  updateCallbackDone?: Promise<unknown>;
};
type ViewTransitionStarter = (update: () => Promise<void>) => ViewTransitionLike | undefined;

const viewTransitionStarter = (): ViewTransitionStarter | undefined => {
  if (typeof document === 'undefined') {
    return undefined;
  }
  const start = Reflect.get(document, 'startViewTransition') as ViewTransitionStarter | undefined;
  return typeof start === 'function' ? start.bind(document) : undefined;
};

/** A promise that may be missing (an older engine, a test double) and must never reject unhandled. */
const settled = (promise: Promise<unknown> | undefined): Promise<unknown> =>
  promise ? promise.catch(() => {}) : Promise.resolve();

let viewTransitionRunning = false;

/**
 * Runs `update` inside a view transition (apple-style.css:332-349, interactions.js
 * viewerTransition) where the browser supports one and motion is allowed; otherwise it just
 * runs the update. Resolves once the update has been applied.
 *
 * Three things a real page needs. A second call while a transition is still running applies its
 * update at once instead of cutting the running one short (a pinch or a held key can ask for
 * several changes in a row). A transition the browser skips (a hidden tab, another one starting)
 * rejects its `ready` promise; that is absorbed here, never an unhandled rejection. And if the
 * browser refuses to start at all, the update still runs, exactly once. An error thrown by
 * `update` itself is passed on to the caller.
 */
export const withViewTransition = async (update: () => Promise<void> | void): Promise<void> => {
  const start = viewTransitionStarter();
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (!start || viewTransitionRunning || hidden || prefersReducedMotion()) {
    await update();
    return;
  }
  let applied: Promise<void> | undefined;
  const apply = () =>
    (applied ??= (async () => {
      await update();
      await tick();
    })());
  viewTransitionRunning = true;
  try {
    const transition = start(apply);
    void settled(transition?.ready);
    void settled(transition?.finished).finally(() => (viewTransitionRunning = false));
    if (!transition?.finished) {
      viewTransitionRunning = false;
    }
  } catch {
    // The browser refused the transition before running the callback: the change still happens.
    viewTransitionRunning = false;
  }
  await apply();
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

/** The `--fl-spring` curve as an easing function, for Svelte transitions (tokens.ts SPRING_STOPS). */
export const springEasing = (t: number): number => {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  const next = SPRING_STOPS.findIndex(([at]) => at >= t);
  const [fromAt, from] = SPRING_STOPS[next - 1];
  const [toAt, to] = SPRING_STOPS[next];
  return from + ((to - from) * (t - fromAt)) / (toAt - fromAt);
};

/** An ease-out close to `--fl-snappy`, for exits driven from script. */
const snappyOut = (t: number): number => 1 - Math.pow(1 - t, 4);

export type MotionPattern = 'pop' | 'sheet' | 'dock' | 'reveal';

export type PatternParams = {
  delay?: number;
  /** Pop: the corner the surface grows from, as a CSS `transform-origin` (default: left to the stylesheet). */
  origin?: string;
  /** Dock: how far, in px, the surface travels; negative for a bar docked to the top. Default 12. */
  y?: number;
  /** Reveal: the item's index, for a 30ms stagger that stops growing after eight items. */
  index?: number;
};

type Direction = { direction?: 'in' | 'out' | 'both' };
type PatternTransition = (node: Element, params?: PatternParams, options?: Direction) => TransitionConfig;

/** Opacity reaches 1 after `fadeMs` of a `totalMs` entrance, while the spring is still settling. */
const fadeWithin = (t: number, totalMs: number, fadeMs: number) => Math.min(1, (t * totalMs) / fadeMs);

const pattern =
  (
    enter: (params: PatternParams) => TransitionConfig,
    exit: (params: PatternParams) => TransitionConfig,
  ): PatternTransition =>
  (node, params = {}, options = {}) => {
    if (prefersReducedMotion()) {
      return crossfade(node, params.delay);
    }
    return options.direction === 'out' ? exit(params) : enter(params);
  };

/**
 * POP: menus, popovers, comboboxes. `in:pop` fades in 150ms while the surface grows from 0.9 on
 * the 320ms spring; `out:pop` fades out in 120ms without moving. A crossfade under Reduce Motion.
 */
export const pop: PatternTransition = pattern(
  ({ delay, origin }) => ({
    delay,
    duration: DURATION.pop,
    css: (t) =>
      `${origin ? `transform-origin: ${origin}; ` : ''}opacity: ${fadeWithin(t, DURATION.pop, DURATION.reduced)}; scale: ${0.9 + 0.1 * springEasing(t)}`,
  }),
  ({ delay }) => ({ delay, duration: EXIT_DURATION.pop, css: (t) => `opacity: ${t}` }),
);

/**
 * SHEET: dialogs, palettes, phone sheets. `in:sheet` fades in 200ms while the sheet rises 40px
 * and grows from 0.96 on the 480ms spring; `out:sheet` sinks 12px and fades in 180ms.
 */
export const sheet: PatternTransition = pattern(
  ({ delay }) => ({
    delay,
    duration: DURATION.sheet,
    css: (t) => {
      const settled = springEasing(t);
      return `opacity: ${fadeWithin(t, DURATION.sheet, DURATION.fade)}; translate: 0 ${(1 - settled) * 40}px; scale: ${0.96 + 0.04 * settled}`;
    },
  }),
  ({ delay }) => ({
    delay,
    duration: EXIT_DURATION.sheet,
    easing: snappyOut,
    css: (t, u) => `opacity: ${t}; translate: 0 ${u * 12}px; scale: ${1 - u * 0.02}`,
  }),
);

/**
 * DOCK: the selection bar, status bar, toasts, inspectors. `in:dock` fades in 200ms while the bar
 * rises `y` px (default 12) on the 420ms spring; `out:dock` reverses the move in 200ms.
 */
export const dock: PatternTransition = pattern(
  ({ delay, y = 12 }) => ({
    delay,
    duration: DURATION.dock,
    css: (t) => `opacity: ${fadeWithin(t, DURATION.dock, DURATION.fade)}; translate: 0 ${(1 - springEasing(t)) * y}px`,
  }),
  ({ delay, y = 12 }) => ({
    delay,
    duration: EXIT_DURATION.dock,
    easing: snappyOut,
    css: (t, u) => `opacity: ${t}; translate: 0 ${u * y}px`,
  }),
);

/**
 * REVEAL: content replacing a skeleton, a section arriving. A 180ms fade; pass `index` for the
 * stagger. Under Reduce Motion it is the shared crossfade with no stagger.
 */
export const reveal: PatternTransition = pattern(
  ({ delay = 0, index = 0 }) => ({
    delay: delay + Math.min(Math.max(index, 0), STAGGER_LIMIT) * STAGGER_MS,
    duration: REVEAL_MS,
    css: (t) => `opacity: ${t}`,
  }),
  ({ delay }) => ({ delay, duration: DURATION.fast, css: (t) => `opacity: ${t}` }),
);

const LEAVE_FRAMES: Record<MotionPattern, { duration: number; to: Keyframe }> = {
  pop: { duration: EXIT_DURATION.pop, to: { opacity: 0 } },
  sheet: { duration: EXIT_DURATION.sheet, to: { opacity: 0, translate: '0 12px', scale: 0.98 } },
  dock: { duration: EXIT_DURATION.dock, to: { opacity: 0, translate: '0 12px' } },
  reveal: { duration: DURATION.fast, to: { opacity: 0 } },
};

/**
 * Whether `node` can run a script-driven animation worth waiting for. False without the Web
 * Animations API, and for a stand-in `animate` that says it finishes at once (the unit-test setup
 * marks its own that way), so callers keep their immediate close there.
 */
export const canAnimate = (node: Element | null | undefined): node is Element =>
  !!node &&
  typeof node.animate === 'function' &&
  typeof node.getAnimations === 'function' &&
  Reflect.get(node.animate, 'finishesAtOnce') !== true;

/**
 * Plays a pattern's exit on an element that script is about to hide (a native dialog before
 * `close()`, a popup before it unmounts), then calls `done`. Returns a function that cancels the
 * exit without calling `done`, for a surface that is reopened mid-exit; call it after `done` too if
 * the element stays in the document, to drop the held end state.
 *
 * `done` runs synchronously when nothing can animate (no Web Animations API, a detached node), so
 * callers keep their instant close there. Under Reduce Motion the exit is the shared crossfade.
 * `backdrop` also fades a native dialog's `::backdrop`.
 */
export const leave = (
  node: Element | null | undefined,
  kind: MotionPattern,
  done: () => void,
  { backdrop = false }: { backdrop?: boolean } = {},
): (() => void) => {
  if (!canAnimate(node) || !node.isConnected) {
    done();
    return () => {};
  }
  const reduced = prefersReducedMotion();
  const { duration, to } = reduced ? { duration: REDUCED_MOTION_FADE_MS, to: { opacity: 0 } } : LEAVE_FRAMES[kind];
  const timing: KeyframeAnimationOptions = { duration, easing: SNAPPY, fill: 'forwards' };
  const animations = [node.animate([{}, to], timing)];
  if (backdrop) {
    try {
      animations.push(node.animate([{}, { opacity: 0 }], { ...timing, pseudoElement: '::backdrop' }));
    } catch {
      // No ::backdrop animation in this engine: the backdrop goes when the dialog closes.
    }
  }
  let cancelled = false;
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (!cancelled) {
      done();
    }
  });
  return () => {
    cancelled = true;
    for (const animation of animations) {
      animation.cancel();
    }
  };
};

/**
 * Counts from `from` to `to` over `duration` with an ease-out, calling `onValue` each frame
 * (CountUp.svelte). Under Reduce Motion, or without requestAnimationFrame, it reports `to` once.
 * Returns a function that stops the count.
 */
export const countUp = (
  from: number,
  to: number,
  onValue: (value: number) => void,
  { duration = 900, delay = 0 }: { duration?: number; delay?: number } = {},
): (() => void) => {
  if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function' || from === to) {
    onValue(to);
    return () => {};
  }
  let frame = 0;
  let start: number | undefined;
  const step = (now: number) => {
    start ??= now + delay;
    const progress = Math.min(1, Math.max(0, (now - start) / duration));
    onValue(from + (to - from) * (1 - Math.pow(1 - progress, 3)));
    if (progress < 1) {
      frame = requestAnimationFrame(step);
    }
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
};

type SectionNavigation = {
  from: { route: { id: string | null } } | null;
  to: { route: { id: string | null } } | null;
  complete: Promise<unknown>;
};

/** The top-level section a route belongs to: `/(user)/albums/[albumId=id]` is `albums`. */
export const routeSection = (routeId: string | null | undefined): string =>
  routeId?.split('/').find((segment) => segment !== '' && !segment.startsWith('(')) ?? '';

/** Marks the document while a section crossfade runs, so app.css can give it the short duration. */
export const SECTION_TRANSITION_ATTRIBUTE = 'data-fl-transition';

/**
 * `onNavigate` handler for moving between sections of the app (Photos to Albums, Albums to People):
 * the page crossfades over `--fl-motion` instead of cutting, with no movement. It returns nothing,
 * so the change is instant, when the section is unchanged (opening a photo, changing a filter),
 * under Reduce Motion, or without the View Transitions API. Use it after `viewerZoomTransition`,
 * which owns the navigations that have a Hero pairing.
 */
export const sectionCrossfade = (navigation: SectionNavigation): Promise<void> | undefined => {
  const from = navigation.from?.route.id;
  const to = navigation.to?.route.id;
  if (!from || !to || routeSection(from) === routeSection(to) || prefersReducedMotion()) {
    return;
  }
  const start = viewTransitionStarter();
  if (!start) {
    return;
  }
  const root = document.documentElement;
  const clear = () => root.removeAttribute(SECTION_TRANSITION_ATTRIBUTE);
  root.setAttribute(SECTION_TRANSITION_ATTRIBUTE, 'section');
  return new Promise<void>((resolve) => {
    try {
      const transition = start(async () => {
        resolve();
        try {
          await navigation.complete;
        } catch {
          // A cancelled navigation still has to let the transition finish.
        }
      });
      void settled(transition?.ready);
      void settled(transition?.finished).then(clear);
    } catch {
      clear();
      resolve();
    }
  });
};

/**
 * HERO for a card that opens a page: an album cover into the album, a person card into the
 * person, an Explore card into its destination, and back again.
 *
 * Mark both ends with the same key and nothing else is needed:
 *
 *   <img data-fl-shared="album:{album.id}" ... />                       on the card
 *   <img data-fl-shared="album:{album.id}" data-fl-shared-page ... />   on the page it opens
 *
 * The root layout calls `installHeroIntent()` once and runs `heroNavigation` from `onNavigate`,
 * after the viewer zoom and before `sectionCrossfade`. A press or key on (or inside a link or
 * button around) a marked element arms its key for the navigation that follows; going back, the
 * page being left offers the element it marked `data-fl-shared-page`. When the same key is on
 * screen on the page that arrives, the two are paired under the `fl-hero` name and travel on the
 * Hero spring; when it is not, the page crossfades. Nothing runs, and the navigation is left to
 * `sectionCrossfade`, when no marked element is involved, under Reduce Motion, or without the View
 * Transitions API.
 */
export const HERO_SHARED_ATTRIBUTE = 'data-fl-shared';
export const HERO_PAGE_ATTRIBUTE = 'data-fl-shared-page';
const SHARED_SELECTOR = '[data-fl-shared]';
const SHARED_PAGE_SELECTOR = '[data-fl-shared][data-fl-shared-page]';
const HERO_NAME = 'fl-hero';
const HERO_EASING_PROPERTY = '--fl-hero-easing';
/** How long a press stays armed: a navigation that starts later than this was not caused by it. */
const HERO_INTENT_MS = 1500;

let heroIntent: { key: string; at: number } | undefined;

const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

const onScreen = (element: Element): boolean => {
  const box = element.getBoundingClientRect();
  return (
    box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth
  );
};

/** The first on-screen element marked with `key`. */
export const findShared = (key: string, root: ParentNode = document): HTMLElement | null => {
  for (const element of root.querySelectorAll<HTMLElement>(`[data-fl-shared="${CSS.escape(key)}"]`)) {
    if (onScreen(element)) {
      return element;
    }
  }
  return null;
};

/** Arms `key` for the next navigation; for a navigation started from script rather than a press. */
export const armHero = (key: string): void => {
  heroIntent = { key, at: now() };
};

const sharedKeyFor = (target: EventTarget | null): string | undefined => {
  if (!(target instanceof Element)) {
    return undefined;
  }
  const marked =
    target.closest(SHARED_SELECTOR) ??
    target.closest('a, button, [role="link"], [role="button"]')?.querySelector(SHARED_SELECTOR);
  return marked?.getAttribute(HERO_SHARED_ATTRIBUTE) ?? undefined;
};

/**
 * Listens for the press that starts a card navigation. Call once from the root layout; returns a
 * function that removes the listeners.
 */
export const installHeroIntent = (target?: Document): (() => void) => {
  target ??= typeof document === 'undefined' ? undefined : document;
  if (!target) {
    return () => {};
  }
  const arm = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    const key = sharedKeyFor(event.target);
    if (key) {
      armHero(key);
    }
  };
  const controller = new AbortController();
  for (const type of ['pointerdown', 'keydown', 'click'] as const) {
    target.addEventListener(type, arm, { capture: true, passive: true, signal: controller.signal });
  }
  return () => controller.abort();
};

type HeroNavigation = { complete: Promise<unknown> };

/**
 * `onNavigate` handler for the card-to-page Hero (see `HERO_SHARED_ATTRIBUTE`). Returns a promise
 * for SvelteKit to wait on when it starts a transition, and `undefined` when this navigation is
 * not one it pairs, so the caller can fall through to `sectionCrossfade`.
 */
export const heroNavigation = (navigation: HeroNavigation): Promise<void> | undefined => {
  const intent = heroIntent && now() - heroIntent.at < HERO_INTENT_MS ? heroIntent.key : undefined;
  heroIntent = undefined;
  if (typeof document === 'undefined' || prefersReducedMotion()) {
    return;
  }
  const start = viewTransitionStarter();
  if (!start) {
    return;
  }
  // Going forward the pressed card names the key; going back the page being left offers its own.
  const before = intent
    ? findShared(intent)
    : [...document.querySelectorAll<HTMLElement>(SHARED_PAGE_SELECTOR)].find((element) => onScreen(element));
  const key = before?.getAttribute(HERO_SHARED_ATTRIBUTE);
  if (!before || !key) {
    return;
  }
  const root = document.documentElement;
  const spring = getComputedStyle(before).getPropertyValue('--fl-spring').trim();
  let after: HTMLElement | null = null;
  const clear = () => {
    before.style.removeProperty('view-transition-name');
    after?.style.removeProperty('view-transition-name');
    root.style.removeProperty(HERO_EASING_PROPERTY);
    root.removeAttribute(SECTION_TRANSITION_ATTRIBUTE);
  };
  before.style.setProperty('view-transition-name', HERO_NAME);
  if (spring) {
    root.style.setProperty(HERO_EASING_PROPERTY, spring);
  }
  root.setAttribute(SECTION_TRANSITION_ATTRIBUTE, 'shared');
  return new Promise<void>((resolve) => {
    try {
      const transition = start(async () => {
        resolve();
        try {
          await navigation.complete;
          await tick();
        } catch {
          // A cancelled navigation still has to let the transition finish.
        }
        // One name, one element: the old end gives it up before the new end takes it.
        before.style.removeProperty('view-transition-name');
        after = findShared(key);
        after?.style.setProperty('view-transition-name', HERO_NAME);
      });
      void settled(transition?.ready);
      void settled(transition?.finished).then(clear);
    } catch {
      clear();
      resolve();
    }
  });
};
