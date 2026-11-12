import { EVERY_FOLDABLE_ACTION, foldedAlbumActions, isWideAlbumHeader } from './album-header-folds';

describe('album header folds (prototype CollectionHeader.jsx)', () => {
  it('folds nothing before the header has been measured', () => {
    expect(foldedAlbumActions(0)).toEqual([]);
    expect(isWideAlbumHeader(0)).toBe(false);
  });

  // 1440px of window leaves the header 1212px with its gutters: beside the title, with
  // Add photos, Share, Slideshow and Comments left in the row.
  it('puts the actions beside the title from 1180px and folds by the room left after the title', () => {
    expect(isWideAlbumHeader(1212)).toBe(true);
    expect(foldedAlbumActions(1212)).toEqual(['links', 'map', 'movie', 'download']);
    expect(isWideAlbumHeader(1180)).toBe(true);
    expect(foldedAlbumActions(1180)).toEqual(['links', 'map', 'movie', 'download']);
    // 560px of title leaves 841px to 1060px: only Links and Map fold
    expect(foldedAlbumActions(1401)).toEqual(['links', 'map']);
    expect(foldedAlbumActions(1620)).toEqual(['links', 'map']);
    expect(foldedAlbumActions(1621)).toEqual([]);
  });

  it('keeps a narrower header’s actions on their own row and folds at 1060px, then 840px', () => {
    expect(isWideAlbumHeader(1179)).toBe(false);
    expect(foldedAlbumActions(1179)).toEqual([]);
    expect(foldedAlbumActions(1061)).toEqual([]);
    expect(foldedAlbumActions(1060)).toEqual(['links', 'map']);
    expect(foldedAlbumActions(841)).toEqual(['links', 'map']);
    expect(foldedAlbumActions(840)).toEqual(['links', 'map', 'movie', 'download']);
    expect(foldedAlbumActions(701)).toEqual(['links', 'map', 'movie', 'download']);
  });

  // FL-1457 (N5): the header's own width, not only the window's, puts everything in "…".
  it('folds every secondary action when the header is 700px or narrower', () => {
    expect(foldedAlbumActions(700)).toEqual(EVERY_FOLDABLE_ACTION);
    expect(foldedAlbumActions(500)).toEqual(EVERY_FOLDABLE_ACTION);
  });
});
