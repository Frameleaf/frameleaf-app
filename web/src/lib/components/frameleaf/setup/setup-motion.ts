/**
 * FL-176 setup motion through the Web Animations API, as the prototype does it. Svelte transitions
 * and WAAPI ignore the CSS reduced-motion kill switch, so every animation here is gated on
 * `mediaQueryManager.reducedMotion` explicitly and falls back to a plain fade.
 */
import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';

export const SETUP_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

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
    { duration: reduced ? 200 : 460 },
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
      { duration: reduced ? 200 : 420, delay: 120 + index * 170 },
    ),
  );
  return { destroy: () => runs.forEach((run) => run?.cancel()) };
};

/**
 * The logo intro: the symbol draws its outline, fills, the glow rises, then every `[data-intro]`
 * element rises in turn. Reduced motion: fades only. Calls `onSettled` when the last one lands.
 */
export const logoIntro = (node: HTMLElement, onSettled?: () => void) => {
  const reduced = mediaQueryManager.reducedMotion;
  const after = [...node.querySelectorAll('[data-intro]')];
  const running: (Animation | undefined)[] = [];
  if (reduced || typeof node.animate !== 'function') {
    running.push(animate(node.querySelector('svg'), [{ opacity: 0 }, { opacity: 1 }], { duration: 400 }));
    for (const [index, element] of after.entries()) {
      running.push(animate(element, [{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 300 + index * 150 }));
    }
  } else {
    for (const [index, path] of [...node.querySelectorAll('.frs-logo-stroke')].entries()) {
      running.push(
        animate(
          path,
          [
            { strokeDashoffset: 1, opacity: 1 },
            { strokeDashoffset: 0, opacity: 1 },
            { strokeDashoffset: 0, opacity: 0 },
          ],
          { duration: 2000, delay: index * 220, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
        ),
      );
    }
    for (const [index, path] of [...node.querySelectorAll('.frs-logo-fill')].entries()) {
      running.push(
        animate(
          path,
          [
            { opacity: 0, transform: 'scale(0.96)' },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration: 700,
            delay: 1300 + index * 120,
          },
        ),
      );
    }
    running.push(
      animate(node.querySelector('.frs-logo-glow'), [{ opacity: 0 }, { opacity: 1 }], { duration: 1600, delay: 900 }),
    );
    for (const [index, element] of after.entries()) {
      running.push(
        animate(
          element,
          [
            { opacity: 0, transform: 'translateY(10px)' },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration: 700,
            delay: 1900 + index * 380,
          },
        ),
      );
    }
  }
  const last = running.filter(Boolean).at(-1);
  if (last) {
    last.onfinish = () => onSettled?.();
  } else {
    onSettled?.();
  }
  return { destroy: () => running.forEach((run) => run?.cancel()) };
};
