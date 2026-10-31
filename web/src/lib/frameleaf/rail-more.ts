/**
 * FL-707 B2 (LibraryRail.jsx): on short windows the rail's pinned footer hides the end of the list.
 * A "More below" row names the sections still out of sight, and goes away once the list is at its end.
 */
export type RailHeading = {
  /** Top of the heading within the scrolled list, in px from the list's top. */
  top: number;
  label: string;
};

/** Within this many px of the end the list counts as scrolled to its end. */
const END_SLACK = 4;
/** A heading this far past the visible edge reads as hidden (its label is out of sight). */
const HEADING_SLACK = 12;

/**
 * The section names below the visible part of the list, `[]` when nothing is hidden, or `['']` when
 * only rows (no heading) are hidden. The caller shows "More below" for any non-empty result.
 */
export const railSectionsBelow = (
  scroll: { scrollTop: number; clientHeight: number; scrollHeight: number },
  headings: readonly RailHeading[],
): string[] => {
  const edge = scroll.scrollTop + scroll.clientHeight;
  if (edge >= scroll.scrollHeight - END_SLACK) {
    return [];
  }
  const hidden = headings.filter((heading) => heading.top + HEADING_SLACK > edge).map((heading) => heading.label);
  return hidden.length > 0 ? hidden : [''];
};

/** How far one press of "More below" scrolls: most of a screen, so a row stays for context. */
export const railMoreStep = (clientHeight: number) => Math.round(clientHeight * 0.8);
