/**
 * The Library View menu's choices (FL-1398), ported from the prototype's `LibraryViewMenu.jsx`.
 *
 * Everything about how the library looks lives in one menu. The choices are kept with the account
 * (`preferences.libraryView`), so they follow the person between devices; Thumbnail size stays per
 * device, since it depends on the screen. Time and file name are kept per layout, because Browse is
 * a bare grid and Timeline and Work are not.
 */
import { AssetVisibility, type LibraryViewResponse } from '@frameleaf/sdk';
import type { TimelineGrouping, TimelineManagerOptions } from '$lib/managers/timeline-manager/types';

export const LIBRARY_GROUPS = ['none', 'day', 'month', 'year'] as const;
export type LibraryGroupBy = (typeof LIBRARY_GROUPS)[number];
export type LibraryViewOptions = Omit<LibraryViewResponse, 'groupBy'> & { groupBy: LibraryGroupBy };
/** The layouts that keep their own captions; the List view follows the layout it belongs to. */
export type LibraryCaptionLayout = 'timeline' | 'browse' | 'work';

/** What a page lets the View menu change; without it the menu is the Information panel switch alone. */
export type LibraryViewMenuOptions = {
  /** The layout whose captions the switches set. */
  layout: LibraryCaptionLayout;
  /** Browse or Work drawn as a grid: "Crop photos to fit" and "Group by" apply. */
  grid: boolean;
  /** The Timeline's year scrubber is offered. */
  scrubber: boolean;
  /** The page collapses stacks, so it can show every photo instead. */
  stacks: boolean;
  /** The Library root: "Also show". */
  libraryRoot: boolean;
};

export const DEFAULT_LIBRARY_VIEW: LibraryViewOptions = Object.freeze({
  scrubber: true,
  crop: true,
  groupBy: 'none',
  stacksTogether: true,
  partnerPhotos: true,
  archived: false,
  ratings: true,
  favorites: true,
  badges: true,
  timelineTime: true,
  timelineNames: false,
  browseTime: false,
  browseNames: false,
  workTime: true,
  workNames: false,
});

/** The stored choices over the defaults; an unknown grouping (a newer client's) reads as none. */
export const libraryViewFrom = (stored?: Partial<LibraryViewResponse>): LibraryViewOptions => ({
  ...DEFAULT_LIBRARY_VIEW,
  ...stored,
  groupBy: (LIBRARY_GROUPS as readonly string[]).includes(stored?.groupBy ?? '')
    ? (stored!.groupBy as LibraryGroupBy)
    : DEFAULT_LIBRARY_VIEW.groupBy,
});

export const captionsFor = (view: LibraryViewOptions, layout: LibraryCaptionLayout) => ({
  time: view[`${layout}Time`],
  names: view[`${layout}Names`],
});

export const captionPatch = (
  layout: LibraryCaptionLayout,
  patch: { time?: boolean; names?: boolean },
): Partial<LibraryViewOptions> => ({
  ...(patch.time !== undefined && { [`${layout}Time`]: patch.time }),
  ...(patch.names !== undefined && { [`${layout}Names`]: patch.names }),
});

/** Small / Medium / Large set the same value the Thumbnail size slider does (stops on its scale). */
export const VIEW_SIZES = [
  { id: 'small', size: 140 },
  { id: 'medium', size: 200 },
  { id: 'large', size: 260 },
] as const;

export const nearestViewSize = (size: number) =>
  VIEW_SIZES.toSorted((a, b) => Math.abs(a.size - size) - Math.abs(b.size - size))[0].id;

/**
 * What the page asks the timeline for, with the menu's "Stacks" and "Also show" applied. Each uses
 * what the timeline queries already take:
 * - a page that collapses stacks (`withStacked`) shows every photo when stacks are not kept together;
 * - the Library root leaves out partner copies (`withPartners: false`), and names no visibility to
 *   add archived items: the server's default is the timeline and the archive, never Locked.
 */
export const viewTimelineOptions = <T extends TimelineManagerOptions>(
  options: T,
  view: LibraryViewOptions,
  libraryRoot: boolean,
): T => {
  const next = { ...options };
  if (!view.stacksTogether) {
    delete next.withStacked;
  }
  if (libraryRoot) {
    if (!view.partnerPhotos) {
      next.withPartners = false;
    }
    if (view.archived && next.visibility === AssetVisibility.Timeline) {
      delete next.visibility;
    }
  }
  return next;
};

/**
 * "Group by" for Browse and Work: the timeline grouping that draws its sections, or `null` for one
 * bare grid. Sections follow the date the photos are sorted by, so an order with no dates (file
 * name, rating, Best first) has none; neither has the List view.
 */
export const sectionGrouping = (
  view: LibraryViewOptions,
  { layout, ordered }: { layout: 'timeline' | 'browse' | 'work' | 'list'; ordered: boolean },
): Exclude<TimelineGrouping, 'all'> | null => {
  if ((layout !== 'browse' && layout !== 'work') || ordered || view.groupBy === 'none') {
    return null;
  }
  return `${view.groupBy}s`;
};

/** What the tiles hide, as a space-separated list for one data attribute (`[data-view-hide~=…]`). */
export const hiddenParts = (view: LibraryViewOptions) =>
  [!view.ratings && 'ratings', !view.favorites && 'favorites', !view.badges && 'badges'].filter(Boolean).join(' ');
