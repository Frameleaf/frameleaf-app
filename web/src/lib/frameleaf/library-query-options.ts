import { AssetTypeEnum, AssetVisibility, type IdsFilter, type SearchFilter } from '@frameleaf/sdk';
import type { DiscoveryQuery } from '$lib/components/discovery/query';
import { activeFilterFields, discoveryUrl, ENRICHMENT_FIELD, toServerFilter } from '$lib/components/discovery/query';
import { createLibrarySession, writeLibraryView } from '$lib/frameleaf/library-session';
import type { TimelineManagerOptions } from '$lib/managers/timeline-manager/types';
import { Route } from '$lib/route';

/**
 * The part of a library session's query the timeline itself applies (FL-30, review M3, FL-425).
 *
 * A library page's session can carry a query: the docked Filters panel edits it, "View in library"
 * from Tags or Folders writes one into the link, and a session restored on this device may hold one.
 * One tag, one person, one pet, one album, media type and favourites become the time buckets' own
 * options, as before; every other condition (dates, places, cameras, rating, several people, an
 * enrichment state, either-or branches) travels in the buckets' `filter`, which the server applies as
 * search does. The results toolbar's count, the empty state and Slideshow then describe what the grid
 * shows. Only free text, which no timeline can run, is reported in `unapplied` and left to the search
 * results page.
 */
export type TimelineQueryOptions = {
  options: TimelineManagerOptions;
  /** `text` for a search the buckets cannot run; every filter field applies. */
  unapplied: string[];
};

/** The one id an `any`/`all` condition requires, when it names exactly one and excludes nothing. */
const singleId = (condition: IdsFilter | undefined): string | null => {
  if (!condition || (condition.none?.length ?? 0) > 0) {
    return null;
  }
  const ids = [...new Set([...(condition.any ?? []), ...(condition.all ?? [])])];
  return ids.length === 1 && (condition.any?.length ?? 0) <= 1 ? ids[0] : null;
};

export const timelineQueryOptions = (
  query: DiscoveryQuery | undefined,
  base: TimelineManagerOptions,
): TimelineQueryOptions => {
  const options: TimelineManagerOptions = { ...base };
  const unapplied: string[] = [];
  if (!query) {
    return { options, unapplied };
  }
  if (query.text?.trim()) {
    unapplied.push('text');
  }
  const filter = query.filter ?? {};
  /** FL-425: the conditions no bucket option names, applied by the server as search applies them. */
  const rest: Record<string, unknown> = {};
  for (const field of activeFilterFields(query)) {
    if (field === ENRICHMENT_FIELD) {
      options.imageEnrichment = query.imageEnrichment;
      continue;
    }
    switch (field) {
      case 'type': {
        const eq = filter.type?.eq;
        if (
          (eq === AssetTypeEnum.Image || eq === AssetTypeEnum.Video) &&
          Object.keys(filter.type!).length === 1 &&
          (!options.assetType || options.assetType === eq)
        ) {
          options.assetType = eq;
          continue;
        }
        break;
      }
      case 'tagIds': {
        const id = singleId(filter.tagIds);
        if (id && !options.tagId) {
          options.tagId = id;
          continue;
        }
        break;
      }
      case 'personIds': {
        const id = singleId(filter.personIds);
        if (id && (!options.personId || options.personId === id)) {
          options.personId = id;
          continue;
        }
        break;
      }
      case 'petIds': {
        const id = singleId(filter.petIds);
        if (id && (!options.petId || options.petId === id)) {
          options.petId = id;
          continue;
        }
        break;
      }
      case 'albumIds': {
        const id = singleId(filter.albumIds);
        if (id && (!options.albumId || options.albumId === id)) {
          options.albumId = id;
          continue;
        }
        break;
      }
      case 'isFavorite': {
        const eq = filter.isFavorite?.eq;
        if (typeof eq === 'boolean' && options.isFavorite === undefined) {
          options.isFavorite = eq;
          continue;
        }
        break;
      }
    }
    rest[field] = filter[field as keyof SearchFilter];
  }
  if (Object.keys(rest).length > 0) {
    // as search takes it: the panel's calendar days become the datetime bounds they mean
    options.filter = JSON.stringify(toServerFilter(rest as SearchFilter));
  }
  return { options, unapplied };
};

/** Require one more id in an id-list condition, keeping every group it already has. */
const requireId = (condition: IdsFilter | undefined, id: string): IdsFilter => {
  if (!condition) {
    return { any: [id] };
  }
  if ((condition.all ?? []).includes(id) || (condition.any?.length === 1 && condition.any[0] === id)) {
    return condition;
  }
  return { ...condition, all: [...new Set([...(condition.all ?? []), id])] };
};

/** Timeline options that only order or draw the photos, never narrow which ones a page shows. */
const PRESENTATION_OPTIONS = new Set([
  'order',
  'orderBy',
  'orderedBy',
  'dateType',
  'withStacked',
  'withCoordinates',
  'deferInit',
]);

/**
 * The search query that shows what a library page shows, narrowed by `query` as well (LIB-P1).
 *
 * The docked Filters panel narrows the page's own photos in place (FL-425); its live counts and its
 * "Save search" are for this search, so the page's own scope (an album, a person, a tag, Favorites,
 * Archive) is carried into it and nothing it was narrowed by is lost. Null when the page is narrowed
 * by something a search cannot carry (a map area, Locked, suppressed content, Best Photos): the
 * counts are then the session query's own.
 */
export const searchQueryForTimeline = (query: DiscoveryQuery, base: TimelineManagerOptions): DiscoveryQuery | null => {
  const result = structuredClone(query);
  const filter = result.filter;
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || PRESENTATION_OPTIONS.has(key)) {
      continue;
    }
    switch (key) {
      case 'visibility': {
        if (value === AssetVisibility.Archive) {
          filter.visibility = { eq: AssetVisibility.Archive };
        } else if (value !== AssetVisibility.Timeline) {
          return null;
        }
        break;
      }
      case 'isFavorite': {
        filter.isFavorite = { eq: value as boolean };
        break;
      }
      case 'assetType': {
        filter.type = { eq: value as AssetTypeEnum };
        break;
      }
      case 'albumId': {
        filter.albumIds = requireId(filter.albumIds, value as string);
        break;
      }
      case 'personId': {
        filter.personIds = requireId(filter.personIds, value as string);
        break;
      }
      case 'petId': {
        filter.petIds = requireId(filter.petIds, value as string);
        break;
      }
      case 'tagId': {
        filter.tagIds = requireId(filter.tagIds, value as string);
        break;
      }
      default: {
        return null;
      }
    }
  }
  return result;
};

/** The Photos page's own timeline options, which a "View in library" link lands on. */
export const PHOTOS_TIMELINE_OPTIONS: TimelineManagerOptions = {
  visibility: AssetVisibility.Timeline,
  withStacked: true,
};

/**
 * Where "View in library" goes for a query (review M3): the Photos page, whose time buckets apply
 * every filter condition (FL-425), so its chips are exactly what narrows the grid; the search results
 * page for search text, which no timeline can run.
 */
export const viewInLibraryHref = (query: DiscoveryQuery, origin = 'http://localhost'): string => {
  if (timelineQueryOptions(query, PHOTOS_TIMELINE_OPTIONS).unapplied.length > 0) {
    return discoveryUrl(query);
  }
  const session = createLibrarySession();
  session.state.query = query;
  const url = writeLibraryView(new URL(Route.photos(), origin), session.state);
  return `${url.pathname}${url.search}`;
};
