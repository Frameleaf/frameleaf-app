import {
  getAllAlbums,
  getAllPeople,
  getAllPets,
  getSearchSuggestions,
  getUserPlaces,
  getVisitedLandmarks,
  ImageEnrichmentFilter,
  searchAssets,
  searchAssetStatistics,
  searchFacets,
  SearchFacetField,
  searchHistogram,
  SearchHistogramGranularity,
  searchSmart,
  searchSmartStatistics,
  SearchSuggestionType,
  type AssetResponseDto,
  LibraryViewScope,
  LibraryItemSearchMode,
  searchLibraryItems,
  type PersonResponseDto,
  type PetResponseDto,
  type SearchHistogramBucketDto,
} from '@frameleaf/sdk';
import type { DiscoverySearchDto } from '$lib/components/discovery/query';
import { albumSelectionOptions } from '$lib/frameleaf/album-tree';
import { sortPets } from '$lib/frameleaf/pets';
import {
  bucketsByYear,
  facetsByField,
  histogramUnitFor,
  paletteStatisticsBody,
  type HistogramUnit,
  type PaletteFacets,
} from '$lib/frameleaf/search-palette';
import { sessionCache } from '$lib/frameleaf/session-cache';
import { loadAllTags } from '$lib/frameleaf/tag-store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

export type FilterPanelOptions = {
  people: PersonResponseDto[];
  pets: PetResponseDto[];
  tags: { value: string; label: string }[];
  albums: { value: string; label: string }[];
  cities: string[];
  /** The landmarks the account has photos at, with how many (FL-354). */
  landmarks: { id: string; name: string; count: number }[];
  /** FL-1019: the places this person named; `place:` offers them first. Never on a shared link. */
  namedPlaces: { id: string; name: string }[];
  states: string[];
  countries: string[];
  makes: string[];
  models: string[];
  lenses: string[];
};

/**
 * Option lists, counts, facets, the date histogram and live results for the Frameleaf search palette
 * and its embedded filter panel (FL-49).
 *
 * Vocabularies are the ones the server publishes for the signed-in account:
 *
 * - people from `/people`, pets from `/pets` (FL-58, the account's own), tags from `/tags`,
 *   albums from `/albums`
 * - cities, states, countries, camera makes, models and lenses from `/search/suggestions`,
 *   which returns the distinct values in the signed-in account's own library
 *
 * Counts come from real access-scoped aggregates over the same structured body the results page
 * sends: `POST /search/statistics` (metadata), `POST /search/smart/statistics` (smart search, capped
 * at 1,000), `POST /search/facets` and `POST /search/histogram`. The server leaves Locked items out of
 * all of them unless the session is unlocked; callers must not keep answers across a lock change.
 * Facets and the histogram take the filter only, so in smart mode they describe the filters the
 * smart text ranks within, never the ranking itself.
 */

export const emptyFilterPanelOptions = (): FilterPanelOptions => ({
  people: [],
  pets: [],
  tags: [],
  albums: [],
  cities: [],
  landmarks: [],
  namedPlaces: [],
  states: [],
  countries: [],
  makes: [],
  models: [],
  lenses: [],
});

/**
 * Every visible person, page by page. `/people` pages rather than returning the whole set, and
 * the panel needs the complete list to resolve an id that arrives in a shared URL. Hidden people
 * are excluded: hiding is the account's own display choice and the filter list honours it.
 */
const loadAllPeople = async (signal?: AbortSignal): Promise<PersonResponseDto[]> => {
  const first = await getAllPeople({ withHidden: false, page: 1 }, { signal });
  const people: PersonResponseDto[] = [...first.people];
  if (!first.hasNextPage || first.people.length === 0) {
    return people;
  }
  // FL-1802: the first page says how many there are, so the rest are asked for together instead of
  // one after another (ten requests in a row for 5,000 people). `total` may count hidden people too;
  // a page past the end answers empty.
  const pages = Math.ceil(first.total / first.people.length);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      getAllPeople({ withHidden: false, page: index + 2 }, { signal }),
    ),
  );
  for (const response of rest) {
    people.push(...response.people);
  }
  // Someone was added while the pages were read: carry on one at a time, as before.
  for (let page = pages + 1; rest.at(-1)?.hasNextPage; page++) {
    signal?.throwIfAborted();
    const response = await getAllPeople({ withHidden: false, page }, { signal });
    people.push(...response.people);
    if (!response.hasNextPage) {
      break;
    }
  }
  return people;
};

/**
 * FL-1802: each vocabulary is kept for the session on its own (`sessionCache`: dropped on a lock,
 * unlock or account change, and after five minutes), the albums per workspace. Opening the filter
 * panel or the search palette a second time asks the server nothing. One that cannot be read is
 * left out of the panel and asked for again next time; the others are still kept.
 */
const VOCABULARIES = {
  people: () => loadAllPeople(),
  // Hidden pets are left out for the same reason hidden people are: hiding is a display choice
  pets: () => getAllPets({ withHidden: false }),
  albums: (scope: string) => getAllAlbums(scope ? { libraryScope: scope as LibraryViewScope } : {}),
  suggestions: async (type: string) => (await getSearchSuggestions({ $type: type as SearchSuggestionType })) ?? [],
  landmarks: () => getVisitedLandmarks(),
  places: () => getUserPlaces(),
};
type Vocabulary = keyof typeof VOCABULARIES;
type VocabularyOf<K extends Vocabulary> = Awaited<ReturnType<(typeof VOCABULARIES)[K]>>;

const vocabularies = sessionCache<unknown>((key) => {
  const [name, argument] = key.split('|', 2);
  return VOCABULARIES[name as Vocabulary](argument);
});
const vocabulary = <K extends Vocabulary>(name: K, argument = ''): Promise<VocabularyOf<K> | undefined> =>
  // One unavailable vocabulary must not empty the whole panel.
  (vocabularies.get(`${name}|${argument}`) as Promise<VocabularyOf<K>>).catch(() => undefined);
/**
 * One suggestion list, shared: opening the palette loads the filter panel's places and the command
 * palette's places at the same moment, and both get the one request. The answer is kept with the
 * other vocabularies (FL-1802), so only the first opening asks. A caller whose signal aborts stops
 * waiting at once; the request carries on and its answer is kept for the next caller.
 */
export const sharedSearchSuggestions = (type: SearchSuggestionType, signal?: AbortSignal): Promise<string[]> => {
  const answer = vocabularies.get(`suggestions|${type}`) as Promise<string[]>;
  if (!signal) {
    return answer;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<string[]>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    answer
      .then(resolve)
      .catch(reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
};

let dropsOnChange = false;

export const loadFilterPanelOptions = async (
  signal?: AbortSignal,
  libraryScope?: LibraryViewScope,
): Promise<FilterPanelOptions> => {
  signal?.throwIfAborted();
  if (!dropsOnChange) {
    dropsOnChange = true;
    // a person renamed, or an album created, renamed or deleted here
    const dropAlbums = () => {
      vocabularies.invalidate('albums|');
      for (const scope of Object.values(LibraryViewScope)) {
        vocabularies.invalidate(`albums|${scope}`);
      }
    };
    eventManager.on({
      AlbumCreate: dropAlbums,
      AlbumUpdate: dropAlbums,
      AlbumDelete: dropAlbums,
      PersonUpdate: () => vocabularies.invalidate('people|'),
    });
  }
  const suggestions = (type: SearchSuggestionType) => vocabulary('suggestions', type);
  const [people, pets, tags, albums, cities, states, countries, makes, models, lenses, landmarks, places] =
    await Promise.all([
      vocabulary('people'),
      vocabulary('pets'),
      loadAllTags().catch(() => []),
      vocabulary('albums', libraryScope),
      suggestions(SearchSuggestionType.City),
      suggestions(SearchSuggestionType.State),
      suggestions(SearchSuggestionType.Country),
      suggestions(SearchSuggestionType.CameraMake),
      suggestions(SearchSuggestionType.CameraModel),
      suggestions(SearchSuggestionType.CameraLensModel),
      vocabulary('landmarks'),
      authManager.isSharedLink ? [] : vocabulary('places'),
    ]);
  // A caller that has gone (a closed panel) gets its abort, as it did when each request carried the signal.
  signal?.throwIfAborted();

  return {
    people: people ?? [],
    // Favorites first, then by name, as the Pets page lists them
    pets: sortPets(pets ?? []),
    tags: tags.map((tag) => ({ value: tag.id, label: tag.value })),
    albums: albumSelectionOptions(albums ?? []),
    cities: (cities ?? []).filter(Boolean),
    landmarks: (landmarks ?? []).map(({ id, name, assetCount }) => ({ id, name, count: assetCount })),
    namedPlaces: (places ?? []).map(({ id, name }) => ({ id, name })),
    states: (states ?? []).filter(Boolean),
    countries: (countries ?? []).filter(Boolean),
    makes: (makes ?? []).filter(Boolean),
    models: (models ?? []).filter(Boolean),
    lenses: (lenses ?? []).filter(Boolean),
  };
};

const isAbort = (error: unknown, signal?: AbortSignal) =>
  signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');

/** Every facet the palette refines by (`SearchPalette.jsx` side panel and typeahead). */
export const PALETTE_FACET_FIELDS: readonly SearchFacetField[] = Object.values(SearchFacetField);

/** Facet counts for a search body; `limit` is values per facet (the typeahead asks for more). */
export const loadPaletteFacets = async (
  body: DiscoverySearchDto,
  signal?: AbortSignal,
  limit = 10,
): Promise<PaletteFacets> => {
  const response = await searchFacets(
    { searchFacetsDto: { ...paletteStatisticsBody(body), facets: [...PALETTE_FACET_FIELDS], facetLimit: limit } },
    { signal },
  );
  return facetsByField(response);
};

/**
 * The date histogram at the prototype's adaptive granularity: months first, then days for a span of
 * two months or less, or years (folded from the months) for more than three years.
 */
export const loadPaletteHistogram = async (
  body: DiscoverySearchDto,
  signal?: AbortSignal,
): Promise<{ unit: HistogramUnit; buckets: SearchHistogramBucketDto[] }> => {
  const dto = paletteStatisticsBody(body);
  const months = await searchHistogram(
    { searchHistogramDto: { ...dto, granularity: SearchHistogramGranularity.Month } },
    { signal },
  );
  const unit = histogramUnitFor(months.buckets);
  if (unit === 'year') {
    return { unit, buckets: bucketsByYear(months.buckets) };
  }
  if (unit === 'day') {
    const days = await searchHistogram(
      { searchHistogramDto: { ...dto, granularity: SearchHistogramGranularity.Day } },
      { signal },
    );
    return { unit, buckets: days.buckets };
  }
  return { unit, buckets: months.buckets };
};

/** Years with matches, for `year:` suggestions. */
export const loadPaletteYears = async (body: DiscoverySearchDto, signal?: AbortSignal) => {
  const years = await searchHistogram(
    { searchHistogramDto: { ...paletteStatisticsBody(body), granularity: SearchHistogramGranularity.Year } },
    { signal },
  );
  return years.buckets;
};

export type PaletteCount = { total: number; capped: boolean };

/** Mixed palettes count both real kinds; media-only refinements do not pretend to include links. */
export const isMixedPaletteSearch = (body: DiscoverySearchDto) =>
  body.filter?.libraryScope === LibraryViewScope.Design || !!body.filter?.text;

/**
 * How many items a body matches. Smart search ranks every eligible item, so its count comes from the
 * smart statistics endpoint and stops at the cap (`capped`), shown as "1,000+".
 */
export const loadPaletteCount = async (
  body: DiscoverySearchDto,
  smart: boolean,
  signal?: AbortSignal,
): Promise<PaletteCount> => {
  if (isMixedPaletteSearch(body)) {
    const response = await searchLibraryItems(
      {
        libraryItemSearchDto: {
          filter: body.filter,
          mode: smart ? LibraryItemSearchMode.Smart : LibraryItemSearchMode.Text,
          ...(body.query && { query: body.query }),
          ...(body.queryAssetId && { queryAssetId: body.queryAssetId }),
          limit: 1,
        },
      },
      { signal },
    );
    return { total: response.count, capped: response.countCapped };
  }
  if (smart) {
    const { total, capped } = await searchSmartStatistics(
      {
        smartSearchDto: {
          ...paletteStatisticsBody(body),
          ...(body.query && { query: body.query }),
          ...(body.queryAssetId && { queryAssetId: body.queryAssetId }),
        },
      },
      { signal },
    );
    return { total, capped };
  }
  const { total } = await searchAssetStatistics({ statisticsSearchDto: paletteStatisticsBody(body) }, { signal });
  return { total, capped: false };
};

/** The palette's top hits: the first page the results page itself would show. */
export const loadPaletteResults = async (
  body: DiscoverySearchDto,
  smart: boolean,
  size: number,
  signal?: AbortSignal,
): Promise<AssetResponseDto[]> => {
  const common = { ...paletteStatisticsBody(body), withExif: true, size };
  const response = smart
    ? await searchSmart(
        {
          smartSearchDto: {
            ...common,
            ...(body.query && { query: body.query }),
            ...(body.queryAssetId && { queryAssetId: body.queryAssetId }),
          },
        },
        { signal },
      )
    : await searchAssets({ metadataSearchDto: common }, { signal });
  return response.assets.items;
};

/**
 * Counts for the enrichment filters: the same body with each enrichment value in turn. The body's
 * own enrichment value is replaced, as picking a quick filter would. `POST /search/facets` has no
 * enrichment facet — enrichment state is derived from the machine-learning metadata and its review
 * records per value, not a column the facet query can group by — so each value is one statistics
 * count, sent together and debounced with the palette's other requests.
 */
export const loadEnrichmentCounts = async (
  body: DiscoverySearchDto,
  values: readonly ImageEnrichmentFilter[],
  signal?: AbortSignal,
): Promise<Partial<Record<ImageEnrichmentFilter, number>>> => {
  const { filter } = paletteStatisticsBody(body);
  const totals = await Promise.all(
    values.map((imageEnrichment) =>
      searchAssetStatistics({ statisticsSearchDto: { ...(filter && { filter }), imageEnrichment } }, { signal })
        .then((result) => result.total)
        .catch((error: unknown) => {
          if (isAbort(error, signal)) {
            throw error;
          }
          return undefined;
        }),
    ),
  );
  const result: Partial<Record<ImageEnrichmentFilter, number>> = {};
  for (const [index, value] of values.entries()) {
    const total = totals[index];
    if (total !== undefined) {
      result[value] = total;
    }
  }
  return result;
};
