/**
 * FL-176 setup motion through the Web Animations API, as the prototype does it. Svelte transitions
 * and WAAPI ignore the CSS reduced-motion kill switch, so every animation here is gated on
 * `mediaQueryManager.reducedMotion` explicitly and falls back to a plain fade.
 */
import { DURATION, EASE, SNAPPY, STAGGER_LIMIT, STAGGER_MS } from '$lib/frameleaf/tokens';
import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';

/** Movement inside setup uses the shared small-move curve (tokens.css `--fl-snappy`). */
export const SETUP_EASE = SNAPPY;

export const animate = (node: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions) =>
  node && typeof node.animate === 'function'
    ? node.animate(frames, { fill: 'both', easing: SETUP_EASE, ...options })
    : undefined;

/** Slides a step in from the direction of travel; a plain fade when motion is reduced. */
export const stepIn = (node: HTMLElement, direction: number) => {
  const reduced = mediaQueryManager.reducedMotion;
  const run = animate(
    node,
    reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: `translateX(${direction * 36}px)` },
          { opacity: 1, transform: 'none' },
        ],
    { duration: reduced ? DURATION.reduced : DURATION.sheet },
  );
  return { destroy: () => run?.cancel() };
};

/** Staggers a list's rows in (the Ready checklist). */
export const staggerIn = (node: HTMLElement) => {
  const reduced = mediaQueryManager.reducedMotion;
  const runs = [...node.querySelectorAll('li')].map((item, index) =>
    animate(
      item,
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: 'translateY(8px)' },
            { opacity: 1, transform: 'none' },
          ],
      { duration: reduced ? DURATION.reduced : DURATION.dock, delay: DURATION.fast + index * DURATION.base },
    ),
  );
  return {
    destroy: () => {
      for (const run of runs) {
        run?.cancel();
      }
    },
  };
};

/**
 * The welcome arrival. The logo fades in by itself (`Logo arrive`, CSS); once it has shown,
 * every `[data-intro]` element is revealed in turn (the Reveal pattern: a fade with the shared
 * stagger). Reduced motion: the same fades with no stagger. Calls `onSettled` when the last one
 * lands. Any click or key press finishes whatever is still running, so nobody waits for it.
 */
export const logoIntro = (node: HTMLElement, onSettled?: () => void) => {
  const reduced = mediaQueryManager.reducedMotion;
  const after = [...node.querySelectorAll('[data-intro]')];
  // Reveal starts as the mark lands, so the two read as one movement.
  const start = reduced ? 0 : DURATION.slow;
  const running = after.map((element, index) =>
    animate(element, [{ opacity: 0 }, { opacity: 1 }], {
      duration: reduced ? DURATION.reduced : DURATION.base,
      delay: reduced ? 0 : start + Math.min(index, STAGGER_LIMIT) * STAGGER_MS,
      easing: EASE,
    }),
  );
  // The skip listeners live until the intro settles or the element goes away.
  const listening = new AbortController();
  let settled = false;
  const settle = () => {
    if (settled) {
      return;
    }
    settled = true;
    listening.abort();
    onSettled?.();
  };
  // Jumps every animation to its end state, then settles the intro.
  const skip = () => {
    for (const run of running) {
      try {
        run?.finish();
      } catch {
        // an animation that cannot be finished is left to end by itself
      }
    }
    settle();
  };
  const last = running.findLast(Boolean);
  if (last) {
    last.onfinish = settle;
    addEventListener('pointerdown', skip, { capture: true, signal: listening.signal });
    addEventListener('keydown', skip, { capture: true, signal: listening.signal });
  } else {
    settle();
  }
  return {
    destroy: () => {
      settled = true;
      listening.abort();
      for (const run of running) {
        run?.cancel();
      }
    },
  };
};

/**
 * The hand-off out of setup: the stage fades while the logo grows a touch, then `done` runs (the
 * navigation to the library, which the app crossfades). Reduced motion: a short fade, no scale.
 * Resolves at once where the Web Animations API is missing.
 */
export const stageOut = async (stage: HTMLElement | null | undefined, logo?: Element | null): Promise<void> => {
  if (!stage || typeof stage.animate !== 'function') {
    return;
  }
  const reduced = mediaQueryManager.reducedMotion;
  const duration = reduced ? DURATION.reduced : DURATION.spring;
  const fade = animate(stage, [{ opacity: 1 }, { opacity: 0 }], { duration, fill: 'forwards' });
  if (!reduced) {
    animate(logo, [{ transform: 'none' }, { transform: 'scale(1.04)' }], { duration, fill: 'forwards' });
  }
  try {
    await fade?.finished;
  } catch {
    // cancelled: carry on to the library
  }
};
