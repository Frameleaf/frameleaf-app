/**
 * Which of an album header's actions sit in its "…" menu at a given width (prototype
 * `CollectionHeader.jsx`: `WIDE`, `WIDE_TITLE`, `WIDTH_FOLDS`; UI review 2026-11-10, A2).
 *
 * The width is the header's with the page gutters on both sides, as the prototype's padded header
 * measures itself, so the same numbers give the same row: 1440px of window leaves 1212px, which
 * shows Add photos, Share, Slideshow and Comments.
 */
export type FoldableAction = 'matching' | 'links' | 'map' | 'slideshow' | 'movie' | 'download' | 'activity';

/** Phones, and Boards collections, keep every secondary action in the menu. */
export const EVERY_FOLDABLE_ACTION: readonly FoldableAction[] = [
  'matching',
  'links',
  'map',
  'slideshow',
  'movie',
  'download',
  'activity',
];

const WIDTH_FOLDS: readonly (readonly [number, readonly FoldableAction[]])[] = [
  [840, ['links', 'map', 'movie', 'download']],
  [1060, ['links', 'map']],
];

/** A header this wide puts its actions beside the title; the title keeps about `WIDE_TITLE` px. */
const WIDE = 1180;
const WIDE_TITLE = 560;

export const isWideAlbumHeader = (width: number) => width >= WIDE;

/** The folded actions for a header `width` px wide. 0 means not measured yet: nothing folds. */
export const foldedAlbumActions = (width: number): readonly FoldableAction[] => {
  if (width <= 0) {
    return [];
  }
  const room = isWideAlbumHeader(width) ? width - WIDE_TITLE : width;
  return WIDTH_FOLDS.find(([max]) => room <= max)?.[1] ?? [];
};
