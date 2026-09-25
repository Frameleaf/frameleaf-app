import { AssetVisibility } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
import { timelineQueryOptions } from './library-query-options';

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

  it('applies favourites and leaves partners out, as the server requires', () => {
    const { options } = timelineQueryOptions(query({ isFavorite: { eq: true } }), base);
    expect(options.isFavorite).toBe(true);
    expect(options.withPartners).toBeUndefined();
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
