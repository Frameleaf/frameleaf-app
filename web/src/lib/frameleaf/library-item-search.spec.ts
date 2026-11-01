import { LibraryItemSearchKind, LibraryViewScope, ColorTolerance } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { effectiveLibraryItemSort, libraryItemSearchRequest } from './library-item-search';

describe('mixed library request adapter', () => {
  it('keeps Design text, color and unfiled conditions without needing semantic search', () => {
    const query = {
      ...emptyDiscoveryQuery(),
      text: 'packaging',
      filter: {
        libraryScope: LibraryViewScope.Design,
        hasAlbums: { eq: false },
        color: { hex: '#609060', tolerance: ColorTolerance.Normal, minWeight: 0.05 },
      },
    };
    const request = libraryItemSearchRequest(query, 'color');
    expect(request).toMatchObject({
      mode: 'text',
      sort: 'color',
      filter: { ...query.filter, text: { contains: 'packaging' } },
    });
    expect(request.query).toBeUndefined();
    expect(request.filter).not.toHaveProperty('originalFileName');
  });
  it('asks only for the kinds a view wants, and every kind otherwise', () => {
    expect(libraryItemSearchRequest(emptyDiscoveryQuery(), 'added', [LibraryItemSearchKind.Bookmark]).kinds).toEqual([
      LibraryItemSearchKind.Bookmark,
    ]);
    expect(libraryItemSearchRequest(emptyDiscoveryQuery())).not.toHaveProperty('kinds');
  });
  it('refuses unsupported enrichment rather than silently dropping it', () => {
    expect(() =>
      libraryItemSearchRequest({ ...emptyDiscoveryQuery(), imageEnrichment: 'nsfw-review' as never }),
    ).toThrow();
  });
  it('sends name and rating sorts, and falls back to Recently added where the server cannot sort', () => {
    const base = { ...emptyDiscoveryQuery(), filter: { libraryScope: LibraryViewScope.Design } };
    expect(libraryItemSearchRequest(base, 'name').sort).toBe('name');
    expect(libraryItemSearchRequest(base, 'rating').sort).toBe('rating');
    expect(libraryItemSearchRequest(base, 'color').sort).toBe('added');
    expect(effectiveLibraryItemSort({ ...base, mode: 'smart', text: 'chairs' }, 'name')).toBe('added');
  });
});
