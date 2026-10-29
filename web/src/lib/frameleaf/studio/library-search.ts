/**
 * Add from your library inside Studio (FL-636): the host half of the bin's Library view.
 *
 * The editor has no SDK and no token, so it cannot search. It asks the host through
 * `StudioHostServices.searchLibrary`, and the host runs the same searches the library's Search page
 * runs: smart search for words, the metadata search otherwise, with the person, city, month and
 * photo/video filters. The server scopes both to the person's own library and partners' shared items
 * and applies its own privacy rules; nothing here widens them.
 *
 * Results come back already projected for Studio (`toStudioAsset`, with the bin's authorized URLs)
 * and filtered by `isStudioEligibleAsset`, so trashed, audio and Locked items never cross. Locked
 * items are asked for only while this session is unlocked (the server refuses the Locked visibility
 * otherwise), and the same eligibility check drops them again the moment the session locks.
 *
 * A result the person places is "adopted": the host adds it to the assets it hands the editor, so it
 * becomes an ordinary `StudioAssetRef` in the bin, and the server's resource resolver (FL-90) grants it
 * when the saved project places it, exactly like a handoff item.
 */
import {
  getAssetInfo,
  AssetTypeEnum,
  AssetVisibility,
  SearchFacetField,
  SearchHistogramGranularity,
  searchAssets,
  searchFacets,
  searchHistogram,
  searchSmart,
  type AssetResponseDto,
  type MetadataSearchDto,
  type SearchFacetsResponseDto,
  type SearchHistogramResponseDto,
  type SearchResponseDto,
  type SmartSearchDto,
} from '@frameleaf/sdk';
import { isStudioEligibleAsset, resolveStudioAssets, toStudioAsset } from './assets';
import type {
  StudioAssetRef,
  StudioHostServices,
  StudioLibraryFacets,
  StudioLibraryQuery,
  StudioLibraryResults,
} from './host-contract';

/** One page of results. The bin grid is small; a person refines rather than scrolls far. */
export const STUDIO_LIBRARY_PAGE_SIZE = 60;
/** How many people and places the filters offer, most used first. */
export const STUDIO_LIBRARY_FACET_LIMIT = 24;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** The search API surface this module uses, so tests can answer it without a server. */
export interface StudioLibrarySearchApi {
  searchSmart: typeof searchSmart;
  searchAssets: typeof searchAssets;
  searchFacets: typeof searchFacets;
  searchHistogram: typeof searchHistogram;
}

const sdk: StudioLibrarySearchApi = { searchSmart, searchAssets, searchFacets, searchHistogram };

/** `2026-07` → the first instant of July 2026 and of August 2026, in UTC. */
export const monthRange = (month: string): { takenAfter: string; takenBefore: string } => {
  const [year, number] = month.split('-').map(Number);
  return {
    takenAfter: new Date(Date.UTC(year, number - 1, 1)).toISOString(),
    takenBefore: new Date(Date.UTC(year, number, 1)).toISOString(),
  };
};

/** The search body a query asks for: filters shared by smart and metadata search. */
export const studioLibraryFilters = (query: StudioLibraryQuery) => {
  const type = query.type === 'photo' ? AssetTypeEnum.Image : query.type === 'video' ? AssetTypeEnum.Video : undefined;
  return {
    ...(type && { type }),
    ...(query.personId && { personIds: [query.personId] }),
    ...(query.city && { city: query.city }),
    ...(query.month && monthRange(query.month)),
  };
};

export interface StudioLibrarySearchOptions {
  /** The shell's language, for smart search. */
  language: string;
  /** Whether this session is unlocked now; Locked items are asked for only then. */
  elevated: boolean;
  signal?: AbortSignal;
  api?: StudioLibrarySearchApi;
}

/**
 * Search the whole library for the bin. Returns the projected results plus the raw library items, which
 * the host keeps so adopting a result needs no second read.
 */
export const searchStudioLibrary = async (
  query: StudioLibraryQuery,
  { language, elevated, signal, api = sdk }: StudioLibrarySearchOptions,
): Promise<StudioLibraryResults & { found: AssetResponseDto[] }> => {
  const text = query.text?.trim() ?? '';
  const page = query.page ?? 1;
  const filters = studioLibraryFilters(query);
  const run = (visibility: AssetVisibility, size: number): Promise<SearchResponseDto> => {
    const body = { ...filters, visibility, page, size, withExif: false };
    return text
      ? api.searchSmart({ smartSearchDto: { ...body, query: text, language } satisfies SmartSearchDto }, { signal })
      : api.searchAssets({ metadataSearchDto: body satisfies MetadataSearchDto }, { signal });
  };
  // The library's Search shows the timeline; an unlocked session also shows its Locked items, which the
  // server returns only to the owner of an elevated session.
  const [timeline, locked] = await Promise.all([
    run(AssetVisibility.Timeline, STUDIO_LIBRARY_PAGE_SIZE),
    elevated && page === 1 ? run(AssetVisibility.Locked, STUDIO_LIBRARY_PAGE_SIZE).catch(() => null) : null,
  ]);
  const seen = new Set<string>();
  const found: AssetResponseDto[] = [];
  for (const asset of [...timeline.assets.items, ...(locked?.assets.items ?? [])]) {
    if (!seen.has(asset.id) && isStudioEligibleAsset(asset)) {
      seen.add(asset.id);
      found.push(asset);
    }
  }
  return {
    items: found.map((asset) => toStudioAsset(asset)),
    nextPage: timeline.assets.nextPage ? page + 1 : null,
    found,
  };
};

const facetCounts = (response: SearchFacetsResponseDto, field: SearchFacetField) =>
  response.facets.find((facet) => facet.fieldName === field)?.counts ?? [];

/** Months with something in them, newest first, as `YYYY-MM`. */
export const histogramMonths = (response: SearchHistogramResponseDto) =>
  response.buckets
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => ({ value: bucket.date.slice(0, 7), count: bucket.count }))
    .filter((month) => MONTH.test(month.value))
    .sort((a, b) => b.value.localeCompare(a.value));

/**
 * What the filters offer: named people only (an unnamed face cannot be told apart in a row of avatars),
 * places and months, from the same scope the search covers.
 */
export const studioLibraryFacets = async ({
  signal,
  api = sdk,
  personThumbnailUrl,
}: {
  signal?: AbortSignal;
  api?: StudioLibrarySearchApi;
  personThumbnailUrl: (personId: string) => string;
}): Promise<StudioLibraryFacets> => {
  const scope = { visibility: AssetVisibility.Timeline };
  const [facets, histogram] = await Promise.all([
    api.searchFacets(
      {
        searchFacetsDto: {
          ...scope,
          facets: [SearchFacetField.People, SearchFacetField.City],
          facetLimit: STUDIO_LIBRARY_FACET_LIMIT,
        },
      },
      { signal },
    ),
    api.searchHistogram(
      { searchHistogramDto: { ...scope, granularity: SearchHistogramGranularity.Month } },
      { signal },
    ),
  ]);
  return {
    people: facetCounts(facets, SearchFacetField.People)
      .filter((person) => UUID.test(person.value) && !!person.label?.trim())
      .map((person) => ({
        id: person.value,
        name: person.label!.trim(),
        count: person.count,
        thumbnailUrl: personThumbnailUrl(person.value),
      })),
    places: facetCounts(facets, SearchFacetField.City)
      .filter((place) => !!place.value.trim())
      .map((place) => ({ value: place.value, count: place.count })),
    months: histogramMonths(histogram),
  };
};

/**
 * Remember what searches returned, so adopting a result reuses the record the server just authorized
 * instead of reading it again. Bounded: a long session of searching must not grow without end.
 */
export const createStudioLibraryCache = (limit = 600) => {
  const items = new Map<string, AssetResponseDto>();
  return {
    remember(found: readonly AssetResponseDto[]) {
      for (const asset of found) {
        items.delete(asset.id);
        items.set(asset.id, asset);
      }
      while (items.size > limit) {
        items.delete(items.keys().next().value!);
      }
    },
    get(id: string): AssetResponseDto | undefined {
      return items.get(id) ?? items.get(id.toLowerCase());
    },
  };
};

export interface StudioLibraryServiceOptions {
  /** The shell's language now, for smart search. */
  language: () => string;
  /** Whether this session is unlocked now. */
  elevated: () => boolean;
  /** What the host hands the editor now (`StudioHostContext.assets`). */
  offered: () => readonly StudioAssetRef[];
  /** Add library records to what the host offers; resolves once `offered` includes them. */
  adopt: (records: AssetResponseDto[]) => Promise<void>;
  /** Read one asset the session has not seen in a search (a normal caller read). */
  lookup?: (id: string) => Promise<AssetResponseDto>;
  personThumbnailUrl: (personId: string) => string;
  api?: StudioLibrarySearchApi;
}

/** The three `StudioHostServices` the bin's Library view calls, bound to the host's own state. */
export const createStudioLibraryServices = ({
  language,
  elevated,
  offered,
  adopt,
  lookup = (id) => getAssetInfo({ id }),
  personThumbnailUrl,
  api = sdk,
}: StudioLibraryServiceOptions): Required<
  Pick<StudioHostServices, 'searchLibrary' | 'libraryFacets' | 'addLibraryAssets'>
> => {
  const cache = createStudioLibraryCache();
  let facets: Promise<StudioLibraryFacets> | null = null;
  return {
    async searchLibrary(query) {
      const { found, ...results } = await searchStudioLibrary(query, {
        language: language(),
        elevated: elevated(),
        api,
      });
      cache.remember(found);
      return results;
    },
    libraryFacets() {
      facets ??= studioLibraryFacets({ api, personThumbnailUrl }).catch((error: unknown) => {
        facets = null;
        throw error;
      });
      return facets;
    },
    async addLibraryAssets(assetIds) {
      const wanted = [...new Set(assetIds.map((id) => id.toLowerCase()))];
      const present = new Set(offered().map((asset) => asset.id.toLowerCase()));
      const records: AssetResponseDto[] = [];
      const unseen: string[] = [];
      for (const id of wanted) {
        if (present.has(id)) {
          continue;
        }
        const hit = cache.get(id);
        if (hit) {
          records.push(hit);
        } else {
          unseen.push(id);
        }
      }
      records.push(...(await resolveStudioAssets(unseen, lookup)));
      // Decided now, not when it was found: a Locked result is not adopted after the session locks.
      const eligible = records.filter((asset) => isStudioEligibleAsset(asset));
      if (eligible.length > 0) {
        await adopt(eligible);
      }
      const byId = new Map(offered().map((asset) => [asset.id.toLowerCase(), asset]));
      return wanted.map((id) => byId.get(id)).filter((asset): asset is StudioAssetRef => !!asset);
    },
  };
};
