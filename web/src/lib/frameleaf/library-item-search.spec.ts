import { LibraryViewScope, ColorTolerance } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { libraryItemSearchRequest } from './library-item-search';

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
  it('refuses unsupported enrichment rather than silently dropping it', () => {
    expect(() =>
      libraryItemSearchRequest({ ...emptyDiscoveryQuery(), imageEnrichment: 'nsfw-review' as never }),
    ).toThrow();
  });
});
