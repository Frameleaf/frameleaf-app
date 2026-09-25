import { AssetVisibility } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
import { timelineQueryOptions, viewInLibraryHref } from './library-query-options';
import { readLibraryView } from './library-session';

const query = (filter: DiscoveryQuery['filter'], text = ''): DiscoveryQuery => ({
  ...emptyDiscoveryQuery(),
  text,
  filter,
});
const base = { visibility: AssetVisibility.Timeline, withStacked: true, withPartners: true };

describe('timelineQueryOptions (FL-30, M3)', () => {
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

  it('applies favourites where the view has no partners, and leaves them to search where it does', () => {
    const own = timelineQueryOptions(query({ isFavorite: { eq: true } }), { visibility: AssetVisibility.Timeline });
    expect(own.options.isFavorite).toBe(true);
    expect(own.unapplied).toEqual([]);
    const shared = timelineQueryOptions(query({ isFavorite: { eq: true } }), base);
    expect(shared.options).toEqual(base);
    expect(shared.unapplied).toEqual(['isFavorite']);
    expect(viewInLibraryHref(query({ isFavorite: { eq: true } })).startsWith('/search?')).toBe(true);
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
