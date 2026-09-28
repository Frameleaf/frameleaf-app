import { AssetTypeEnum, AssetVisibility, SearchFacetField } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  BEST_PHOTOS_QUALITY_MIN_SCORE,
  buildExplorePeople,
  buildExplorePlaces,
  buildExploreShortcuts,
  buildExploreThings,
  captureDay,
  emptyExploreShortcutCounts,
  EXPLORE_FACETS,
  exploreFacetsBody,
  facetCounts,
  isVideoAsset,
} from '$lib/frameleaf/explore';
import { personFactory } from '@test-data/factories/person-factory';

const searchOf = (href: string) => JSON.parse(new URL(href, 'http://localhost').searchParams.get('query') ?? '{}');

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

  describe('facetCounts', () => {
    const facets = [
      {
        fieldName: SearchFacetField.City,
        counts: [
          { value: 'Paris', count: 4 },
          { value: 'Nowhere', count: 0 },
        ],
      },
      { fieldName: SearchFacetField.Tags, counts: [{ value: 'tag-1', label: 'beach', count: 2 }] },
    ];

    it('reads one facet, dropping values nothing matches', () => {
      expect(facetCounts(facets, SearchFacetField.City)).toEqual([{ value: 'Paris', count: 4 }]);
    });

    it('is empty for a missing facet or a failed request', () => {
      expect(facetCounts(facets, SearchFacetField.People)).toEqual([]);
      expect(facetCounts(null, SearchFacetField.City)).toEqual([]);
    });

    it('asks only for the people, places and tags Explore counts, with covers, in the Timeline scope', () => {
      expect(EXPLORE_FACETS).toEqual([SearchFacetField.People, SearchFacetField.City, SearchFacetField.Tags]);
      expect(exploreFacetsBody).toMatchObject({
        visibility: AssetVisibility.Timeline,
        facets: EXPLORE_FACETS,
        facetCovers: true,
      });
    });
  });

  describe('buildExplorePeople', () => {
    const jamie = personFactory.build({ id: 'jamie', name: 'Jamie', isHidden: false });
    const unnamed = personFactory.build({ id: 'unnamed', name: '', isHidden: false });
    const hidden = personFactory.build({ id: 'hidden', name: 'Hidden', isHidden: true });

    it('keeps the facet order and count, and opens the search the count was taken from', () => {
      const [card] = buildExplorePeople([{ value: 'jamie', count: 12 }], [jamie]);
      expect(card).toMatchObject({ id: 'jamie', label: 'Jamie', count: 12, person: jamie });
      expect(searchOf(card.href)).toEqual({ personIds: ['jamie'] });
    });

    it('never shows a hidden, unnamed or unknown person, whatever the count', () => {
      const cards = buildExplorePeople(
        [
          { value: 'hidden', count: 50 },
          { value: 'unnamed', count: 40 },
          { value: 'someone-else', count: 30 },
          { value: 'jamie', count: 3 },
        ],
        [jamie, unnamed, hidden],
      );
      expect(cards.map(({ id }) => id)).toEqual(['jamie']);
    });

    it('stops at the limit', () => {
      const people = Array.from({ length: 20 }, (_, index) =>
        personFactory.build({ id: `p${index}`, name: `P${index}`, isHidden: false }),
      );
      const cards = buildExplorePeople(
        people.map(({ id }) => ({ value: id, count: 1 })),
        people,
      );
      expect(cards).toHaveLength(12);
    });
  });

  describe('buildExplorePlaces and buildExploreThings', () => {
    it('turns city counts into place cards that open the city search, covered by the facet cover', () => {
      const [place, other] = buildExplorePlaces([
        { value: 'Paris', count: 4, coverAssetId: 'cover' },
        { value: 'Rome', count: 1 },
      ]);
      expect(place).toMatchObject({ label: 'Paris', count: 4, coverAssetId: 'cover' });
      expect(searchOf(place.href)).toEqual({ city: 'Paris' });
      expect(other.coverAssetId).toBeNull();
    });

    it('names things by the tag label and opens the tag search by id', () => {
      const [thing] = buildExploreThings([{ value: 'tag-1', label: 'beach', count: 2, coverAssetId: 'cover' }]);
      expect(thing).toMatchObject({ id: 'tag-1', label: 'beach', count: 2, coverAssetId: 'cover' });
      expect(searchOf(thing.href)).toEqual({ tagIds: ['tag-1'] });
    });

    it('limits things to ten and places to eight', () => {
      const counts = Array.from({ length: 20 }, (_, index) => ({ value: `v${index}`, count: 1 }));
      expect(buildExploreThings(counts)).toHaveLength(10);
      expect(buildExplorePlaces(counts)).toHaveLength(8);
    });
  });

  describe('captureDay', () => {
    it('keeps the recorded local day, whatever the browser time zone', () => {
      expect(captureDay({ localDateTime: '2024-03-01T23:30:00.000Z' })).toBe('2024-03-01');
    });

    it('is null when the capture date is unknown or impossible', () => {
      expect(captureDay({ localDateTime: '' })).toBeNull();
      expect(captureDay({ localDateTime: '0000-01-01T00:00:00.000Z' })).toBeNull();
      expect(captureDay({ localDateTime: '2024-02-31T10:00:00.000Z' })).toBeNull();
      expect(captureDay({ localDateTime: '2023-13-01T10:00:00.000Z' })).toBeNull();
      expect(captureDay({ localDateTime: '2024-02-29T10:00:00.000Z' })).toBe('2024-02-29');
    });
  });

  it('recognises videos', () => {
    expect(isVideoAsset({ type: AssetTypeEnum.Video })).toBe(true);
    expect(isVideoAsset({ type: AssetTypeEnum.Image })).toBe(false);
  });
});
