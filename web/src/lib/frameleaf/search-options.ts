import {
  getAllAlbums,
  getAllPeople,
  getAllPets,
  getAllTags,
  getSearchSuggestions,
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
import { eventManager } from '$lib/managers/event-manager.svelte';

export type FilterPanelOptions = {
  people: PersonResponseDto[];
  pets: PetResponseDto[];
  tags: { value: string; label: string }[];
  albums: { value: string; label: string }[];
  cities: string[];
  /** The landmarks the account has photos at, with how many (FL-354). */
  landmarks: { id: string; name: string; count: number }[];
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
  const people: PersonResponseDto[] = [];
  for (let page = 1; ; page++) {
    signal?.throwIfAborted();
    const response = await getAllPeople({ withHidden: false, page }, { signal });
    people.push(...response.people);
    if (!response.hasNextPage) {
      return people;
    }
  }
};

type SharedSuggestions = { request: Promise<string[]>; controller: AbortController; callers: number };
const inFlightSuggestions = new Map<SearchSuggestionType, SharedSuggestions>();

let clearsOnLogout = false;

/**
 * One request per suggestion list while it is in flight: opening the palette loads the filter panel's
 * places and the command palette's places at the same moment. Not cached once settled. A caller whose
 * signal aborts stops waiting at once, and the request is aborted when its last caller has left.
 */
export const sharedSearchSuggestions = (type: SearchSuggestionType, signal?: AbortSignal): Promise<string[]> => {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  if (!clearsOnLogout) {
    clearsOnLogout = true;
    // a request started for one account must never answer the next one
    eventManager.on({
      AuthLogout: () => {
        for (const { controller } of inFlightSuggestions.values()) {
          controller.abort();
        }
        inFlightSuggestions.clear();
      },
    });
  }
  let shared = inFlightSuggestions.get(type);
  if (!shared) {
    const controller = new AbortController();
    const entry: SharedSuggestions = {
      controller,
      callers: 0,
      // never throws synchronously: a caller's Promise.all must receive every request it started
      request: (async () =>
        (await getSearchSuggestions({ $type: type }, { signal: controller.signal })) ?? [])().finally(() => {
        if (inFlightSuggestions.get(type) === entry) {
          inFlightSuggestions.delete(type);
        }
      }),
    };
    inFlightSuggestions.set(type, entry);
    shared = entry;
  }
  const entry = shared;
  entry.callers++;
  return new Promise<string[]>((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) {
        return false;
      }
      left = true;
      entry.callers--;
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = () => {
      if (!leave()) {
        return;
      }
      if (entry.callers === 0) {
        if (inFlightSuggestions.get(type) === entry) {
          inFlightSuggestions.delete(type);
        }
        entry.controller.abort(signal?.reason);
      }
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.request
      .then((value) => {
        if (leave()) {
          resolve(value);
        }
      })
      .catch((error: unknown) => {
        if (leave()) {
          reject(error);
        }
      });
  });
};

const settle = async <T>(work: Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error;
    }
    // One unavailable vocabulary must not empty the whole panel.
    return fallback;
  }
};

export const loadFilterPanelOptions = async (
  signal?: AbortSignal,
  libraryScope?: LibraryViewScope,
): Promise<FilterPanelOptions> => {
  const [people, pets, tags, albums, cities, states, countries, makes, models, lenses, landmarks] = await Promise.all([
    settle<PersonResponseDto[]>(loadAllPeople(signal), [], signal),
    // Hidden pets are left out for the same reason hidden people are: hiding is a display choice
    settle<PetResponseDto[]>(getAllPets({ withHidden: false }, { signal }), [], signal),
    settle(getAllTags({ signal }), [], signal),
    settle(getAllAlbums(libraryScope ? { libraryScope } : {}, { signal }), [], signal),
    settle(sharedSearchSuggestions(SearchSuggestionType.City, signal), [], signal),
    settle(sharedSearchSuggestions(SearchSuggestionType.State, signal), [], signal),
    settle(sharedSearchSuggestions(SearchSuggestionType.Country, signal), [], signal),
    settle(getSearchSuggestions({ $type: SearchSuggestionType.CameraMake }, { signal }), [], signal),
    settle(getSearchSuggestions({ $type: SearchSuggestionType.CameraModel }, { signal }), [], signal),
    settle(getSearchSuggestions({ $type: SearchSuggestionType.CameraLensModel }, { signal }), [], signal),
    settle(getVisitedLandmarks({ signal }), [], signal),
  ]);

  return {
    people,
    // Favorites first, then by name, as the Pets page lists them
    pets: sortPets(pets),
    tags: tags.map((tag) => ({ value: tag.id, label: tag.value })),
    albums: albumSelectionOptions(albums),
    cities: cities.filter(Boolean),
    landmarks: landmarks.map(({ id, name, assetCount }) => ({ id, name, count: assetCount })),
    states: states.filter(Boolean),
    countries: countries.filter(Boolean),
    makes: makes.filter(Boolean),
    models: models.filter(Boolean),
    lenses: lenses.filter(Boolean),
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
