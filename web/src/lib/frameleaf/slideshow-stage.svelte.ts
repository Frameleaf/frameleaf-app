import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import { prefersReducedMotion } from '$lib/frameleaf/motion';
import { effectiveTransition, kenBurnsMove, SlideshowTransition } from '$lib/frameleaf/slideshow-transitions';

/**
 * The slideshow's stage motion (FL-36): how each new item arrives while a slideshow plays,
 * ported from the template's `.mv-stage-item` classes (media-viewer.css:264-306) and the
 * Ken Burns / Memories rule (apple-style.css:408-420). It runs through the Web Animations
 * API on the item the viewer already renders, so the viewer's own markup stays unchanged,
 * and Reduce Motion is checked in JavaScript (`effectiveTransition`) as well as in CSS.
 */

export type SlideshowDirection = 'previous' | 'next';

export type SlideshowStageOptions = {
  /** A slideshow is running (playing or paused). */
  active: boolean;
  assetId: string;
  transition: SlideshowTransition;
  /** Seconds each photo stays on screen. */
  intervalSeconds: number;
  direction: SlideshowDirection;
  /** Videos only crossfade: they are never panned or zoomed. */
  video: boolean;
};

export type StageAnimation = { keyframes: Keyframe[]; options: KeyframeAnimationOptions };

/** --fl-motion-slow and --fl-ease (tokens.css). */
const MOTION_SLOW_MS = 240;
const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
/** The Ken Burns and Memories crossfade (apple-style.css:410). */
const KEN_BURNS_FADE_MS = 900;
/** The distance a slide travels (media-viewer.css:288-306). */
const SLIDE_PX = 48;

const fadeIn = (duration: number, easing: string): StageAnimation => ({
  keyframes: [{ opacity: 0 }, { opacity: 1 }],
  options: { duration, easing, fill: 'backwards' },
});

/**
 * The animations for one item. `transition` must already be the effective one (Reduce Motion
 * applied); `rtl` mirrors the slide so "next" still arrives from the reading direction.
 */
export const slideshowStageAnimations = ({
  transition,
  direction,
  intervalSeconds,
  assetId,
  video,
  rtl = false,
}: {
  transition: SlideshowTransition;
  direction: SlideshowDirection;
  intervalSeconds: number;
  assetId: string;
  video: boolean;
  rtl?: boolean;
}): StageAnimation[] => {
  switch (transition) {
    case SlideshowTransition.None: {
      return [];
    }
    case SlideshowTransition.Slide: {
      const sign = (direction === 'previous' ? -1 : 1) * (rtl ? -1 : 1);
      return [
        {
          keyframes: [
            { opacity: 0, transform: `translateX(${sign * SLIDE_PX}px)` },
            { opacity: 1, transform: 'none' },
          ],
          options: { duration: MOTION_SLOW_MS, easing: EASE, fill: 'backwards' },
        },
      ];
    }
    case SlideshowTransition.KenBurns:
    case SlideshowTransition.Memories: {
      const fade = fadeIn(KEN_BURNS_FADE_MS, 'ease');
      if (video) {
        return [fade];
      }
      const { from, to } = kenBurnsMove(assetId);
      return [
        fade,
        {
          keyframes: [{ transform: from }, { transform: to }],
          options: { duration: (Math.max(0, intervalSeconds) + 1) * 1000, easing: 'ease-in-out', fill: 'both' },
        },
      ];
    }
    default: {
      return [fadeIn(MOTION_SLOW_MS, EASE)];
    }
  }
};

/**
 * Attach to the element whose first child is the item on stage. `options` is re-read when the
 * item, the transition or the direction changes (which restarts the motion); `paused` only
 * pauses and resumes the motion in place.
 */
export const slideshowStage =
  (options: () => SlideshowStageOptions, paused: () => boolean): Attachment<HTMLElement> =>
  (node) => {
    let animations: Animation[] = [];

    $effect(() => {
      const { active, assetId, transition, intervalSeconds, direction, video } = options();
      const target = node.firstElementChild;
      if (!active || !(target instanceof HTMLElement) || typeof target.animate !== 'function') {
        return;
      }

      const specs = slideshowStageAnimations({
        transition: effectiveTransition(transition, prefersReducedMotion()),
        direction,
        intervalSeconds,
        assetId,
        video,
        rtl: getComputedStyle(node).direction === 'rtl',
      });
      animations = specs.map(({ keyframes, options }) => target.animate(keyframes, options));
      if (untrack(paused)) {
        for (const animation of animations) {
          animation.pause();
        }
      }

      return () => {
        for (const animation of animations) {
          animation.cancel();
        }
        animations = [];
      };
    });

    $effect(() => {
      const isPaused = paused();
      for (const animation of animations) {
        if (isPaused && animation.playState === 'running') {
          animation.pause();
        } else if (!isPaused && animation.playState === 'paused') {
          animation.play();
        }
      }
    });
  };
