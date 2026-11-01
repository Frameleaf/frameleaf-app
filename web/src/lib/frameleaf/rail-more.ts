/**
 * FL-707 B2 (LibraryRail.jsx): on short windows the rail's pinned footer hides the end of the list.
 * A "More below" row names the sections still out of sight, and goes away once the list is at its end.
 * The rail tracks this with IntersectionObservers, so nothing is measured while the list scrolls.
 */
export type RailHeading = {
  label: string;
  /** The heading is past the bottom edge of the visible list (its label is out of sight). */
  below: boolean;
};

/** Within this many px of the end the list counts as scrolled to its end (a root margin). */
export const RAIL_END_SLACK = 4;
/** A heading this close to the visible edge reads as hidden (a negative root margin). */
export const RAIL_HEADING_SLACK = 12;

/**
 * The section names below the visible part of the list, `[]` when the list is at its end (or does
 * not scroll), or `['']` when only rows (no named heading) are hidden. The caller shows "More below"
 * for any non-empty result.
 */
export const railSectionsBelow = (atEnd: boolean, headings: readonly RailHeading[]): string[] => {
  if (atEnd) {
    return [];
  }
  const hidden = headings.filter((heading) => heading.below && heading.label).map((heading) => heading.label);
  return hidden.length > 0 ? hidden : [''];
};

/** Whether an observed element sits below its root's visible area rather than in it or above it. */
export const isBelowRoot = (
  entry: Pick<IntersectionObserverEntry, 'isIntersecting' | 'boundingClientRect' | 'rootBounds'>,
) => !entry.isIntersecting && entry.boundingClientRect.top >= (entry.rootBounds?.top ?? 0);

/** How far one press of "More below" scrolls: most of a screen, so a row stays for context. */
export const railMoreStep = (clientHeight: number) => Math.round(clientHeight * 0.8);
