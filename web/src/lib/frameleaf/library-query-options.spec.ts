import { AssetTypeEnum, AssetVisibility } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
import { searchQueryForTimeline, timelineQueryOptions, viewInLibraryHref } from './library-query-options';
import { readLibraryView } from './library-session';

const query = (filter: DiscoveryQuery['filter'], text = ''): DiscoveryQuery => ({
  ...emptyDiscoveryQuery(),
  text,
  filter,
});
const base = { visibility: AssetVisibility.Timeline, withStacked: true };

describe('timelineQueryOptions (FL-30, M3)', () => {
  it('applies a media type without dropping other conditions or replacing the page type (FL-40)', () => {
    for (const assetType of [AssetTypeEnum.Image, AssetTypeEnum.Video]) {
      expect(timelineQueryOptions(query({ type: { eq: assetType } }), base)).toEqual({
        options: { ...base, assetType },
        unapplied: [],
      });
      expect(timelineQueryOptions(query({ type: { eq: assetType } }), { ...base, assetType }).unapplied).toEqual([]);
    }
    for (const type of [
      { ne: AssetTypeEnum.Video },
      { eq: AssetTypeEnum.Audio },
      { eq: AssetTypeEnum.Image, notIn: [AssetTypeEnum.Image] },
      { in: [AssetTypeEnum.Image, AssetTypeEnum.Video] },
      { eq: AssetTypeEnum.Video },
    ]) {
      expect(timelineQueryOptions(query({ type }), { ...base, assetType: AssetTypeEnum.Image })).toEqual({
        options: { ...base, assetType: AssetTypeEnum.Image },
        unapplied: ['type'],
      });
    }
  });

  it('applies a single tag, person, pet or album to the time buckets', () => {
    expect(timelineQueryOptions(query({ tagIds: { any: ['t1'] } }), base)).toEqual({
      options: { ...base, tagId: 't1' },
      unapplied: [],
    });
    expect(
      timelineQueryOptions(query({ personIds: { all: ['p1'] }, petIds: { any: ['pet'] } }), base).options,
    ).toMatchObject({ personId: 'p1', petId: 'pet' });
    expect(timelineQueryOptions(query({ albumIds: { any: ['a1'] } }), base).options.albumId).toBe('a1');
  });

  it("applies favourites to the time buckets: a view holds only the viewer's own items (FL-326)", () => {
    const own = timelineQueryOptions(query({ isFavorite: { eq: true } }), base);
    expect(own.options).toEqual({ ...base, isFavorite: true });
    expect(own.unapplied).toEqual([]);
    expect(viewInLibraryHref(query({ isFavorite: { eq: true } })).startsWith('/photos?')).toBe(true);
  });

  it('reports what the buckets cannot express instead of pretending to apply it', () => {
    const result = timelineQueryOptions(
      query({ tagIds: { any: ['t1', 't2'] }, originalPath: { startsWith: '/photos' } }, 'beach'),
      base,
    );
    expect(result.options).toEqual(base);
    expect([...result.unapplied].sort()).toEqual(['originalPath', 'tagIds', 'text']);
    expect(timelineQueryOptions(query({ tagIds: { none: ['t1'] } }), base).unapplied).toEqual(['tagIds']);
  });

  it('never replaces the page’s own person with another one', () => {
    const result = timelineQueryOptions(query({ personIds: { any: ['other'] } }), { ...base, personId: 'p1' });
    expect(result.options.personId).toBe('p1');
    expect(result.unapplied).toEqual(['personIds']);
  });
});

describe('searchQueryForTimeline (LIB-P1)', () => {
  it('carries the page’s own scope into the search, beside the panel’s conditions', () => {
    const narrowed = query({ make: { eq: 'Canon' } });
    expect(searchQueryForTimeline(narrowed, base)?.filter).toEqual({ make: { eq: 'Canon' } });
    expect(searchQueryForTimeline(narrowed, { ...base, isFavorite: true })?.filter).toEqual({
      make: { eq: 'Canon' },
      isFavorite: { eq: true },
    });
    expect(searchQueryForTimeline(narrowed, { visibility: AssetVisibility.Archive })?.filter).toEqual({
      make: { eq: 'Canon' },
      visibility: { eq: AssetVisibility.Archive },
    });
    expect(
      searchQueryForTimeline(query({ personIds: { any: ['p2', 'p3'] } }), { ...base, personId: 'p1' })?.filter,
    ).toEqual({ personIds: { any: ['p2', 'p3'], all: ['p1'] } });
    // The query it was given is left as it was.
    expect(narrowed.filter).toEqual({ make: { eq: 'Canon' } });
  });

  it('refuses a page a search cannot stand for', () => {
    for (const options of [
      { ...base, userId: 'partner' },
      { ...base, bbox: '1,2,3,4' },
      { visibility: AssetVisibility.Locked },
      { ...base, suppressedOnly: true },
    ]) {
      expect(searchQueryForTimeline(query({}), options)).toBeNull();
    }
  });
});

describe('viewInLibraryHref (M3)', () => {
  it('opens the Photos page when the buckets apply the whole query', () => {
    const href = viewInLibraryHref(query({ tagIds: { any: ['t1'] } }));
    expect(href.startsWith('/photos?')).toBe(true);
    expect(readLibraryView(new URL(href, 'http://localhost'))?.query.filter).toEqual({ tagIds: { any: ['t1'] } });
  });

  it('opens the search results for a folder path, several tags or search text', () => {
    for (const unsupported of [
      query({ originalPath: { startsWith: '/photos/2024' } }),
      query({ tagIds: { any: ['t1', 't2'] } }),
      query({}, 'beach'),
    ]) {
      const href = viewInLibraryHref(unsupported);
      expect(href.startsWith('/search?dq=')).toBe(true);
      expect(JSON.parse(new URL(href, 'http://localhost').searchParams.get('dq')!)).toEqual(unsupported);
    }
  });
});
