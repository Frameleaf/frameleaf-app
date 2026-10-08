import { canAnimate, prefersReducedMotion, REDUCED_MOTION_FADE_MS } from '$lib/frameleaf/motion';
import { DURATION, EASE } from '$lib/frameleaf/tokens';

/** What a change of grouping or layout replaces: the Years and Months cards, or the rows of photos. */
export const VIEW_CONTENT_SELECTOR = '[data-testid="frameleaf-timeline-cards"], .fl-month';

/**
 * Years, Months, Days and All, and Timeline, Browse and Work, dissolve in rather than cut: the new
 * content fades up in place. Nothing moves, so Reduce Motion keeps the fade at its shorter length.
 *
 * This is not a page view transition on purpose. While one runs the browser hit-tests nothing on
 * the page, so a click on a photo, a jump on the scrubber or the next step of a pinch that lands
 * within its 300 ms is lost; the library must take input the moment it has changed.
 */
export const dissolveView = (root: ParentNode | null | undefined): void => {
  if (!root) {
    return;
  }
  const duration = prefersReducedMotion() ? REDUCED_MOTION_FADE_MS : DURATION.fade;
  for (const node of root.querySelectorAll(VIEW_CONTENT_SELECTOR)) {
    if (canAnimate(node)) {
      node.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE });
    }
  }
};
