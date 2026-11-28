/**
 * Which of an album header's actions sit in its "…" menu at a given width (prototype
 * `CollectionHeader.jsx`: `WIDE`, `WIDE_TITLE`, `WIDTH_FOLDS`; UI review 2026-11-10, A2).
 *
 * The width is the header's with the page gutters on both sides, as the prototype's padded header
 * measures itself, so the same numbers give the same row: 1440px of window leaves 1212px, which
 * shows Add photos, Share, Slideshow and Comments.
 */
export type FoldableAction = 'matching' | 'map' | 'slideshow' | 'movie' | 'download' | 'activity' | 'folders';

/** Phones, and Boards collections, keep every secondary action in the menu. */
export const EVERY_FOLDABLE_ACTION: readonly FoldableAction[] = [
  'matching',
  'map',
  'slideshow',
  'movie',
  'download',
  'activity',
  // FL-1838: "Folders in this album", on an album made from a folder
  'folders',
];

const WIDTH_FOLDS: readonly (readonly [number, readonly FoldableAction[]])[] = [
  [840, ['map', 'movie', 'download']],
  [1060, ['map']],
];

/** A header this wide puts its actions beside the title; the title keeps about `WIDE_TITLE` px. */
const WIDE = 1180;
const WIDE_TITLE = 560;
/**
 * FL-1457 (N5): a header this narrow (the filter or information panel open on a small window) folds everything, as a
 * phone does.
 */
const FOLD_ALL = 700;

export const isWideAlbumHeader = (width: number) => width >= WIDE;

/** The folded actions for a header `width` px wide. 0 means not measured yet: nothing folds. */
export const foldedAlbumActions = (width: number): readonly FoldableAction[] => {
  if (width <= 0) {
    return [];
  }
  if (width <= FOLD_ALL) {
    return EVERY_FOLDABLE_ACTION;
  }
  const wide = isWideAlbumHeader(width);
  const room = wide ? width - WIDE_TITLE : width;
  const folds = WIDTH_FOLDS.find(([max]) => room <= max)?.[1] ?? [];
  // FL-1838: beside the title, a fifth button ("Folders in this album", the longest) took the title's room and cut
  // the album's name short at 1440px. While anything folds there it goes in "…" too; on its own row below the title
  // it has the room.
  return wide && folds.length > 0 ? [...folds, 'folders'] : folds;
};
