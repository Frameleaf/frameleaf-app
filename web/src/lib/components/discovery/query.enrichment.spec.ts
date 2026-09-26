import { ImageEnrichmentFilter } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  activeFilterFields,
  activeFilterSections,
  discoveryChipFields,
  emptyDiscoveryQuery,
  ENRICHMENT_FIELD,
  filterSectionForField,
  toSearchDto,
  withDiscoveryEnrichment,
  withoutDiscoveryFilter,
  withoutDiscoveryFilters,
  type DiscoveryQuery,
} from '$lib/components/discovery/query';

/**
 * FL-49 additions: the enrichment facet, and the mapping from the shared query onto the search
 * DTOs. The facet is a DTO-level enum rather than a `SearchFilter` condition, so these tests pin
 * down that it still behaves like any other active filter everywhere the UI counts, groups,
 * chips and clears filters.
 */

const base = (): DiscoveryQuery => emptyDiscoveryQuery();

describe('enrichment facet', () => {
  it('sets and clears the facet without touching the filter', () => {
    const start = { ...base(), filter: { city: { eq: 'Banff' } } };
    const withFacet = withDiscoveryEnrichment(start, ImageEnrichmentFilter.NsfwReview);
    expect(withFacet.imageEnrichment).toBe(ImageEnrichmentFilter.NsfwReview);
    expect(withFacet.filter).toEqual({ city: { eq: 'Banff' } });
    expect(withDiscoveryEnrichment(withFacet, undefined).imageEnrichment).toBeUndefined();
    // The input is never mutated.
    expect(start.imageEnrichment).toBeUndefined();
  });

  it('counts, groups and chips like any other active filter', () => {
    const query = withDiscoveryEnrichment(base(), ImageEnrichmentFilter.MissingImageDescription);
    expect(activeFilterFields(query)).toEqual([ENRICHMENT_FIELD]);
    expect(activeFilterCount(query)).toBe(1);
    expect(discoveryChipFields(query)).toEqual([ENRICHMENT_FIELD]);
    // It belongs to no named section, so the Filter menu opens it under All filters.
    expect(filterSectionForField(ENRICHMENT_FIELD)).toBe('all');
    expect(activeFilterSections(query)).toEqual(['all']);
  });

  it('is cleared by removing its field and by resetting every filter', () => {
    const query = withDiscoveryEnrichment({ ...base(), filter: { city: { eq: 'Banff' } } }, ImageEnrichmentFilter.Nsfw);
    expect(withoutDiscoveryFilter(query, ENRICHMENT_FIELD).imageEnrichment).toBeUndefined();
    expect(withoutDiscoveryFilter(query, ENRICHMENT_FIELD).filter).toEqual({ city: { eq: 'Banff' } });
    expect(withoutDiscoveryFilters(query).imageEnrichment).toBeUndefined();
    expect(withoutDiscoveryFilters(query).filter).toEqual({});
  });

  it('leaves an empty query at zero active filters', () => {
    expect(activeFilterCount(base())).toBe(0);
    expect(activeFilterFields(base())).toEqual([]);
  });
});

describe('toSearchDto', () => {
  it('passes the structured filter through verbatim', () => {
    const query = { ...base(), filter: { hasAlbums: { eq: false }, hasTags: { eq: false } } };
    expect(toSearchDto(query).filter).toEqual({ hasAlbums: { eq: false }, hasTags: { eq: false } });
  });

  it('writes smart text to query and other text to the mode’s own DTO field', () => {
    expect(toSearchDto({ ...base(), text: 'lake', mode: 'smart' })).toEqual({ query: 'lake' });
    expect(toSearchDto({ ...base(), text: 'IMG_1234', mode: 'text' }, 'originalFileName')).toEqual({
      originalFileName: 'IMG_1234',
    });
    expect(toSearchDto({ ...base(), text: '/photos/2026', mode: 'text' }, 'originalPath')).toEqual({
      originalPath: '/photos/2026',
    });
  });

  it('carries the enrichment facet as the DTO enum', () => {
    const query = withDiscoveryEnrichment(base(), ImageEnrichmentFilter.NsfwReview);
    expect(toSearchDto(query)).toEqual({ imageEnrichment: ImageEnrichmentFilter.NsfwReview });
  });

  it('omits empty text and an empty filter rather than sending empty objects', () => {
    expect(toSearchDto({ ...base(), text: ' '.repeat(3) })).toEqual({});
  });

  it('does not alias the query it is given', () => {
    const query = { ...base(), filter: { city: { eq: 'Banff' } } };
    const dto = toSearchDto(query);
    (dto.filter as Record<string, unknown>).city = { eq: 'Jasper' };
    expect(query.filter).toEqual({ city: { eq: 'Banff' } });
  });
});
