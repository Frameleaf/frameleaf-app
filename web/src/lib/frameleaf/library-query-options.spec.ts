import { AssetTypeEnum, AssetVisibility, ImageEnrichmentFilter } from '@frameleaf/sdk';
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
    // FL-425: any other media type condition rides in the buckets' search filter, beside the page type
    for (const type of [
      { ne: AssetTypeEnum.Video },
      { eq: AssetTypeEnum.Audio },
      { eq: AssetTypeEnum.Image, notIn: [AssetTypeEnum.Image] },
      { in: [AssetTypeEnum.Image, AssetTypeEnum.Video] },
      { eq: AssetTypeEnum.Video },
    ]) {
      expect(timelineQueryOptions(query({ type }), { ...base, assetType: AssetTypeEnum.Image })).toEqual({
        options: { ...base, assetType: AssetTypeEnum.Image, filter: JSON.stringify({ type }) },
        unapplied: [],
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

  it('sends every other condition to the buckets as the search filter, and reports only search text', () => {
    const conditions = {
      tagIds: { any: ['t1', 't2'] },
      originalPath: { startsWith: '/photos' },
      takenAt: { gte: '2024-01-01T00:00:00.000Z' },
      city: { eq: 'Banff' },
      make: { like: 'Canon' },
      rating: { gte: 4 },
      personIds: { all: ['p1', 'p2'] },
      or: [{ country: { eq: 'Canada' } }, { isMotion: { eq: true } }],
    } as DiscoveryQuery['filter'];
    const result = timelineQueryOptions(query(conditions, 'beach'), base);
    expect(result.unapplied).toEqual(['text']);
    expect(result.options).toEqual({ ...base, filter: expect.any(String) });
    expect(JSON.parse(result.options.filter!)).toEqual(conditions);
    expect(timelineQueryOptions(query({ tagIds: { none: ['t1'] } }), base)).toEqual({
      options: { ...base, filter: JSON.stringify({ tagIds: { none: ['t1'] } }) },
      unapplied: [],
    });
  });

  it('keeps the bucket options it can name and sends the rest in the filter', () => {
    const result = timelineQueryOptions(query({ tagIds: { any: ['t1'] }, make: { eq: 'Canon' } }), base);
    expect(result.options).toEqual({ ...base, tagId: 't1', filter: JSON.stringify({ make: { eq: 'Canon' } }) });
    expect(timelineQueryOptions(query({}), base).options).toEqual(base);
  });

  it('sends the panel’s calendar days as the datetime bounds search takes', () => {
    const days = query({ localDateTime: { gte: '2024-01-01', lte: '2024-01-31' } });
    expect(JSON.parse(timelineQueryOptions(days, base).options.filter!)).toEqual({
      localDateTime: { gte: '2024-01-01T00:00:00.000Z', lt: '2024-02-01T00:00:00.000Z' },
    });
    // the session keeps the days the panel shows
    expect(days.filter.localDateTime).toEqual({ gte: '2024-01-01', lte: '2024-01-31' });
  });

  it('applies the enrichment state beside the filter', () => {
    const result = timelineQueryOptions(
      { ...query({}), imageEnrichment: ImageEnrichmentFilter.MissingImageDescription },
      base,
    );
    expect(result).toEqual({
      options: { ...base, imageEnrichment: ImageEnrichmentFilter.MissingImageDescription },
      unapplied: [],
    });
  });

  it('never replaces the page’s own person with another one: the other narrows it further', () => {
    const result = timelineQueryOptions(query({ personIds: { any: ['other'] } }), { ...base, personId: 'p1' });
    expect(result.options).toEqual({
      ...base,
      personId: 'p1',
      filter: JSON.stringify({ personIds: { any: ['other'] } }),
    });
    expect(result.unapplied).toEqual([]);
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

  it('opens the Photos page for a folder path or several tags too (FL-425)', () => {
    for (const filter of [{ originalPath: { startsWith: '/photos/2024' } }, { tagIds: { any: ['t1', 't2'] } }]) {
      const href = viewInLibraryHref(query(filter));
      expect(href.startsWith('/photos?')).toBe(true);
      expect(readLibraryView(new URL(href, 'http://localhost'))?.query.filter).toEqual(filter);
    }
  });

  it('opens the search results for search text', () => {
    const text = query({ tagIds: { any: ['t1'] } }, 'beach');
    const href = viewInLibraryHref(text);
    expect(href.startsWith('/search?dq=')).toBe(true);
    expect(JSON.parse(new URL(href, 'http://localhost').searchParams.get('dq')!)).toEqual(text);
  });
});
