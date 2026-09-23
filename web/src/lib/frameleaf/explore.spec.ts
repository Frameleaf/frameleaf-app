import { BEST_PHOTOS_QUALITY_MIN_SCORE, buildExploreShortcuts, emptyExploreShortcutCounts } from '$lib/frameleaf/explore';
import { describe, expect, it } from 'vitest';

describe('explore', () => {
  describe('BEST_PHOTOS_QUALITY_MIN_SCORE', () => {
    it('matches the design template threshold on the 0-1 production scale', () => {
      expect(BEST_PHOTOS_QUALITY_MIN_SCORE).toBe(0.9);
    });
  });

  describe('buildExploreShortcuts', () => {
    it('carries the counts through unchanged', () => {
      const shortcuts = buildExploreShortcuts({ favorites: 3, photos: 10, videos: 2, withoutPeople: 5 });
      expect(shortcuts.map((shortcut) => [shortcut.id, shortcut.count])).toEqual([
        ['favorites', 3],
        ['videos', 2],
        ['photos', 10],
        ['withoutPeople', 5],
      ]);
    });

    it('reports null counts while they have not loaded, never a fallback of 0', () => {
      const shortcuts = buildExploreShortcuts(emptyExploreShortcutCounts());
      expect(shortcuts.every((shortcut) => shortcut.count === null)).toBe(true);
    });

    it('points favorites at the dedicated Favorites destination', () => {
      const [favorites] = buildExploreShortcuts(emptyExploreShortcutCounts());
      expect(favorites.href).toBe('/favorites');
    });

    it('points videos and photos at type-filtered search, and without-people at the hasPeople filter', () => {
      const [, videos, photos, withoutPeople] = buildExploreShortcuts(emptyExploreShortcutCounts());
      expect(videos.href).toContain('VIDEO');
      expect(photos.href).toContain('IMAGE');
      expect(withoutPeople.href).toContain('hasPeople');
    });

    it('never repeats a shortcut id', () => {
      const ids = buildExploreShortcuts(emptyExploreShortcutCounts()).map((shortcut) => shortcut.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
