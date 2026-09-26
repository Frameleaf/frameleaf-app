import { AssetVisibility } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  activeFilterFields,
  activeFilterSections,
  contextDiscoveryQuery,
  DEFAULT_DISCOVERY_PAGE_SIZE,
  destinationFilterFields,
  discoveryChipFields,
  discoveryPageSummary,
  discoveryPaging,
  discoveryUrl,
  emptyDiscoveryQuery,
  fieldsInFilterSection,
  filterSectionForField,
  fromLegacySearch,
  isDiscoveryFilterActive,
  readDiscoveryQuery,
  structuredSearchRequest,
  withDiscoveryFacet,
  withoutDiscoveryFilter,
  withoutDiscoveryFilters,
  type DiscoveryQuery,
} from '$lib/components/discovery/query';

const albumId = '11111111-2222-3333-4444-555555555555';
const spaceId = '66666666-7777-8888-9999-aaaaaaaaaaaa';

const query = (filter: DiscoveryQuery['filter']): DiscoveryQuery => ({ ...emptyDiscoveryQuery(), filter });

describe('discovery query', () => {
  it('starts empty and portable', () => {
    expect(emptyDiscoveryQuery()).toEqual({
      version: 1,
      text: '',
      mode: 'text',
      filter: {},
      grouping: 'all',
      view: 'photos',
    });
  });

  it('round-trips through a URL', () => {
    const source = query({ isFavorite: { eq: true } });
    const url = new URL(`http://localhost${discoveryUrl(source)}`);
    expect(readDiscoveryQuery(url)).toEqual(source);
  });

  it('falls back to the empty query for a missing, unversioned or unparsable value', () => {
    expect(readDiscoveryQuery(new URL('http://localhost/discover'))).toEqual(emptyDiscoveryQuery());
    expect(readDiscoveryQuery(new URL('http://localhost/discover?dq=not-json'))).toEqual(emptyDiscoveryQuery());
    const unversioned = new URL('http://localhost/discover');
    unversioned.searchParams.set('dq', JSON.stringify({ version: 2, filter: {} }));
    expect(readDiscoveryQuery(unversioned)).toEqual(emptyDiscoveryQuery());
    const arrayFilter = new URL('http://localhost/discover');
    arrayFilter.searchParams.set('dq', JSON.stringify({ version: 1, filter: [] }));
    expect(readDiscoveryQuery(arrayFilter)).toEqual(emptyDiscoveryQuery());
  });

  it('derives the query from the route a view was opened on', () => {
    expect(contextDiscoveryQuery(new URL(`http://localhost/albums/${albumId}`)).filter).toEqual({
      albumIds: { any: [albumId] },
    });
    expect(contextDiscoveryQuery(new URL(`http://localhost/spaces/${spaceId}`)).spaceId).toBe(spaceId);
    // FL-48: shared spaces live under /sharing/{id}
    expect(contextDiscoveryQuery(new URL(`http://localhost/sharing/${spaceId}`)).spaceId).toBe(spaceId);
    expect(contextDiscoveryQuery(new URL(`http://localhost/sharing/${spaceId}/photos/${albumId}`)).spaceId).toBe(
      spaceId,
    );
    // FL-48 map/space follow-ups: the map page contributes no scope. The prototype always lands a
    // submitted search on the plain grid results (App.jsx `exploreQuery`/`MapView`'s "Search this
    // area"), so a search opened from /map is unscoped, exactly like /photos.
    expect(contextDiscoveryQuery(new URL('http://localhost/map'))).toEqual(emptyDiscoveryQuery());
    expect(contextDiscoveryQuery(new URL('http://localhost/photos'))).toEqual(emptyDiscoveryQuery());
  });

  it('reads an existing discovery query back off the discover route rather than rebuilding it', () => {
    const source = query({ rating: { gte: 4 } });
    expect(contextDiscoveryQuery(new URL(`http://localhost${discoveryUrl(source)}`))).toEqual(source);
  });

  it('adds a facet without dropping the other selections on the same field', () => {
    const one = withDiscoveryFacet(emptyDiscoveryQuery(), 'personIds', 'a');
    const two = withDiscoveryFacet(one, 'personIds', 'b');
    expect(two.filter.personIds).toEqual({ any: ['a', 'b'] });
    expect(withDiscoveryFacet(two, 'personIds', 'b').filter.personIds).toEqual({ any: ['a', 'b'] });
    expect(one.filter.personIds).toEqual({ any: ['a'] });
  });

  it('sets a scalar facet by equality and removes a single field', () => {
    const withCity = withDiscoveryFacet(emptyDiscoveryQuery(), 'city', 'Banff');
    expect(withCity.filter.city).toEqual({ eq: 'Banff' });
    expect(withoutDiscoveryFilter(withCity, 'city').filter).toEqual({});
  });

  it('clears every structured filter but keeps the text query and presentation', () => {
    const source: DiscoveryQuery = {
      ...query({ city: { eq: 'Banff' }, isFavorite: { eq: true } }),
      text: 'lake',
      mode: 'smart',
      grouping: 'months',
      view: 'moments',
    };
    expect(withoutDiscoveryFilters(source)).toEqual({ ...source, filter: {} });
  });
});

describe('legacy search migration', () => {
  it('keeps a structured filter as it is', () => {
    const filter = { tagIds: { all: ['t1'] } };
    expect(fromLegacySearch({ filter }).filter).toEqual(filter);
  });

  it('maps scalar, list and flag fields', () => {
    const result = fromLegacySearch({
      city: 'Banff',
      isFavorite: true,
      personIds: ['p1', 'p2'],
      isNotInAlbum: true,
      tagIds: null,
    });
    expect(result.filter).toEqual({
      city: { eq: 'Banff' },
      isFavorite: { eq: true },
      personIds: { all: ['p1', 'p2'] },
      hasAlbums: { eq: false },
      hasTags: { eq: false },
    });
  });

  it('writes only the capture-date bound that was supplied', () => {
    expect(fromLegacySearch({ takenAfter: '2026-01-01' }).filter.takenAt).toEqual({ gte: '2026-01-01' });
    expect(fromLegacySearch({ takenBefore: '2026-02-01' }).filter.takenAt).toEqual({ lte: '2026-02-01' });
    expect(fromLegacySearch({}).filter.takenAt).toBeUndefined();
  });

  it('turns free text into a smart query and leaves an empty one as text', () => {
    expect(fromLegacySearch({ query: 'sunset' })).toMatchObject({ text: 'sunset', mode: 'smart' });
    expect(fromLegacySearch({})).toMatchObject({ text: '', mode: 'text' });
  });

  it('maps the pattern and similarity fields the fork already searches', () => {
    // FL-48: the first text field becomes the query's own text, so the search dialog shows it where
    // it was typed; the rest keep the flat fields' "contains" meaning as conditions.
    const result = fromLegacySearch({
      originalFileName: 'IMG',
      description: 'lake',
      originalPath: '/mnt/library',
      ocr: 'menu',
    });
    expect(result).toMatchObject({ text: 'IMG', mode: 'text', textField: 'originalFileName' });
    expect(result.filter).toEqual({
      description: { like: 'lake' },
      originalPath: { like: '/mnt/library' },
      ocr: { matches: 'menu' },
    });
  });
});

describe('the single Filter control', () => {
  it('counts one active filter per narrowed field for the badge', () => {
    expect(activeFilterCount(emptyDiscoveryQuery())).toBe(0);
    expect(isDiscoveryFilterActive(emptyDiscoveryQuery())).toBe(false);
    const active = query({ city: { eq: 'Banff' }, personIds: { any: ['p1', 'p2'] } });
    expect(activeFilterCount(active)).toBe(2);
    expect(isDiscoveryFilterActive(active)).toBe(true);
  });

  it('counts an or branch once however many operands it holds', () => {
    expect(activeFilterCount(query({ or: [{ city: { eq: 'Banff' } }, { city: { eq: 'Jasper' } }] }))).toBe(1);
  });

  it('ignores an emptied condition so the badge disappears with its chip', () => {
    expect(activeFilterFields(query({ city: {}, or: [] }))).toEqual([]);
  });

  it('does not count free text; the top bar is its own entry point', () => {
    expect(activeFilterCount({ ...emptyDiscoveryQuery(), text: 'lake', mode: 'smart' })).toBe(0);
  });

  it('deep-links each field into its filter panel section', () => {
    expect(filterSectionForField('personIds')).toBe('people');
    expect(filterSectionForField('takenAt')).toBe('date');
    expect(filterSectionForField('country')).toBe('places');
    expect(filterSectionForField('rating')).toBe('media');
    expect(filterSectionForField('tagIds')).toBe('tags');
    expect(filterSectionForField('albumIds')).toBe('all');
    expect(filterSectionForField('somethingNew')).toBe('all');
  });

  it('reports the active sections in menu order', () => {
    const active = query({ tagIds: { any: ['t1'] }, city: { eq: 'Banff' }, personIds: { any: ['p1'] } });
    expect(activeFilterSections(active)).toEqual(['people', 'places', 'tags']);
  });

  it('lists a section content, with All filters holding everything', () => {
    const active = query({ personIds: { any: ['p1'] }, rating: { gte: 4 } });
    expect(fieldsInFilterSection(active, 'people')).toEqual(['personIds']);
    expect(fieldsInFilterSection(active, 'date')).toEqual([]);
    expect(fieldsInFilterSection(active, 'all')).toEqual(['personIds', 'rating']);
  });
});

describe('filter chips', () => {
  it('shows a chip only while a filter is active', () => {
    expect(discoveryChipFields(emptyDiscoveryQuery())).toEqual([]);
    expect(discoveryChipFields(query({ city: { eq: 'Banff' } }))).toEqual(['city']);
  });

  it('never restates the destination', () => {
    const favorites = query({ isFavorite: { eq: true }, city: { eq: 'Banff' } });
    expect(discoveryChipFields(favorites, { kind: 'favorites' })).toEqual(['city']);

    const person = query({ personIds: { any: ['p1'] }, rating: { gte: 4 } });
    expect(discoveryChipFields(person, { kind: 'person', id: 'p1' })).toEqual(['rating']);

    const album = query({ albumIds: { any: [albumId] } });
    expect(discoveryChipFields(album, { kind: 'album', id: albumId })).toEqual([]);

    const tag = query({ tagIds: { any: ['t1'] } });
    expect(discoveryChipFields(tag, { kind: 'tag', id: 't1' })).toEqual([]);
  });

  it('keeps the same filter as a chip on a destination that does not state it', () => {
    const person = query({ personIds: { any: ['p1'] } });
    expect(discoveryChipFields(person, { kind: 'library' })).toEqual(['personIds']);
    expect(destinationFilterFields()).toEqual([]);
    expect(destinationFilterFields({ kind: 'place' })).toEqual(['city', 'state', 'country']);
  });
});

describe('cumulative paging', () => {
  it('accumulates every loaded page instead of replacing the page', () => {
    expect(discoveryPaging(1, 500, 60)).toMatchObject({ shown: 60, total: 500, hasMore: true, remaining: 440 });
    expect(discoveryPaging(3, 500, 60)).toMatchObject({ shown: 180, total: 500, hasMore: true, remaining: 320 });
  });

  it('clamps the last page to the total and closes Show more', () => {
    const paging = discoveryPaging(4, 200, 60);
    expect(paging).toMatchObject({ shown: 200, hasMore: false, remaining: 0, page: 4 });
  });

  it('clamps a page beyond the end and keeps the default size for an unusable one', () => {
    expect(discoveryPaging(99, 100, 60).page).toBe(2);
    expect(discoveryPaging(0, 100, 0).pageSize).toBe(DEFAULT_DISCOVERY_PAGE_SIZE);
    expect(discoveryPaging(1, 0, 60)).toMatchObject({ shown: 0, hasMore: false, page: 1 });
  });

  it('keeps Show more available while the total is unknown', () => {
    expect(discoveryPaging(2, null, 60)).toMatchObject({ shown: 120, total: null, hasMore: true, remaining: null });
  });

  it('summarises cumulatively as Showing n of m', () => {
    expect(discoveryPageSummary(discoveryPaging(3, 500, 60))).toEqual({
      key: 'frameleaf_library_showing_of',
      values: { shown: 180, total: 500 },
      hasMore: true,
    });
  });

  it('summarises a complete and an empty result', () => {
    expect(discoveryPageSummary(discoveryPaging(1, 12, 60))).toEqual({
      key: 'frameleaf_library_showing_all',
      values: { shown: 12, total: 12 },
      hasMore: false,
    });
    expect(discoveryPageSummary(discoveryPaging(1, 0, 60))).toEqual({
      key: 'no_results',
      values: { shown: 0, total: 0 },
      hasMore: false,
    });
  });
});

describe('pets as a filter (FL-58)', () => {
  const petId = '99999999-8888-4777-8666-555555555555';

  it('searches a pet page by that pet', () => {
    expect(contextDiscoveryQuery(new URL(`http://localhost/pets/${petId}`)).filter).toEqual({
      petIds: { any: [petId] },
    });
    expect(contextDiscoveryQuery(new URL(`http://localhost/pets/${petId}/photos/${albumId}`)).filter).toEqual({
      petIds: { any: [petId] },
    });
    expect(contextDiscoveryQuery(new URL('http://localhost/pets'))).toEqual(emptyDiscoveryQuery());
  });

  it('adds pet facets like people facets, keeping earlier picks', () => {
    const one = withDiscoveryFacet(emptyDiscoveryQuery(), 'petIds', 'a');
    expect(withDiscoveryFacet(one, 'petIds', 'b').filter.petIds).toEqual({ any: ['a', 'b'] });
    expect(one.filter.petIds).toEqual({ any: ['a'] });
  });

  it('migrates a flat petIds search to an all-of condition, like personIds', () => {
    expect(fromLegacySearch({ petIds: ['a', 'b'], personIds: ['p'] }).filter).toEqual({
      petIds: { all: ['a', 'b'] },
      personIds: { all: ['p'] },
    });
    expect(fromLegacySearch({ petIds: [] }).filter).toEqual({});
  });

  it('has its own filter panel section, after People', () => {
    expect(filterSectionForField('petIds')).toBe('pets');
    expect(activeFilterSections(query({ petIds: { any: ['a'] }, personIds: { any: ['p'] } }))).toEqual([
      'people',
      'pets',
    ]);
    expect(fieldsInFilterSection(query({ petIds: { none: ['a'] } }), 'pets')).toEqual(['petIds']);
  });

  it('counts, chips and removes a pet condition like any other', () => {
    const withPet = query({ petIds: { any: ['a'] }, rating: { gte: 4 } });
    expect(activeFilterCount(withPet)).toBe(2);
    expect(discoveryChipFields(withPet)).toEqual(['petIds', 'rating']);
    expect(withoutDiscoveryFilter(withPet, 'petIds').filter).toEqual({ rating: { gte: 4 } });
  });

  it('does not restate the pet on its own page', () => {
    const onPetPage = query({ petIds: { any: ['a'] }, rating: { gte: 4 } });
    expect(discoveryChipFields(onPetPage, { kind: 'pet', id: 'a' })).toEqual(['rating']);
    expect(destinationFilterFields({ kind: 'pet', id: 'a' })).toEqual(['petIds']);
  });
});

describe('structured search results request (FL-58)', () => {
  it('sends a dialog filter without any flat field the server refuses beside it', () => {
    const request = structuredSearchRequest({ filter: { petIds: { any: ['a'] } } });
    expect(request).toEqual({
      filter: {
        petIds: { any: ['a'] },
        visibility: { eq: AssetVisibility.Timeline },
        trashedAt: { eq: null },
      },
      withExif: true,
    });
    expect(request).not.toHaveProperty('page');
    expect(request).not.toHaveProperty('visibility');
  });

  it('folds the text modes into the filter the way a legacy search is migrated', () => {
    const filter = { petIds: { any: ['a'] } };
    // The server's `like` already matches text anywhere, exactly as the flat fields do (FL-48).
    expect(structuredSearchRequest({ filter, originalFileName: 'IMG' }).filter?.originalFileName).toEqual({
      like: 'IMG',
    });
    expect(structuredSearchRequest({ filter, description: 'lake' }).filter?.description).toEqual({ like: 'lake' });
    expect(structuredSearchRequest({ filter, ocr: 'exit' }).filter?.ocr).toEqual({ matches: 'exit' });
    expect(structuredSearchRequest({ filter, originalPath: '/2026' }).filter?.originalPath).toEqual({
      like: '/2026',
    });
    expect(structuredSearchRequest({ filter, originalFileName: 'IMG' })).not.toHaveProperty('originalFileName');
  });

  it('keeps smart text and the cursor, and an explicit visibility or trash condition', () => {
    const request = structuredSearchRequest(
      {
        filter: { visibility: { eq: AssetVisibility.Archive }, trashedAt: { gte: '2026-01-01' } },
        query: 'dog on the beach',
      },
      'cursor-2',
    );
    expect(request).toEqual({
      // FL-48: a calendar day reaches the server as the datetime the DTO accepts
      filter: { visibility: { eq: AssetVisibility.Archive }, trashedAt: { gte: '2026-01-01T00:00:00.000Z' } },
      withExif: true,
      query: 'dog on the beach',
      cursor: 'cursor-2',
    });
  });

  it('does not alias the filter it is given', () => {
    const filter = { petIds: { any: ['a'] } };
    structuredSearchRequest({ filter });
    expect(filter).toEqual({ petIds: { any: ['a'] } });
  });
});
