import { AssetVisibility, type IdsFilter } from '@immich/sdk';
import type { DiscoveryQuery } from '$lib/components/discovery/query';
import { activeFilterFields, discoveryUrl } from '$lib/components/discovery/query';
import { createLibrarySession, writeLibraryView } from '$lib/frameleaf/library-session';
import type { TimelineManagerOptions } from '$lib/managers/timeline-manager/types';
import { Route } from '$lib/route';

/**
 * The part of a library session's query the timeline itself can apply (FL-30, review M3).
 *
 * A library page's session can carry a query: "View in library" from Tags or Folders writes one into
 * the link, and a session restored on this device may hold one. The time buckets filter by one tag,
 * one person, one pet, one album and favourites, so those conditions narrow the grid
 * itself; the results toolbar's count, the empty state and Slideshow then describe what the grid
 * shows. A condition the buckets cannot express is reported in `unapplied` and left to the search
 * results page, where the whole query applies.
 */
export type TimelineQueryOptions = {
  options: TimelineManagerOptions;
  /** Active filter fields the grid does not apply, plus `text` for a search the buckets cannot run. */
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
  for (const field of activeFilterFields(query)) {
    switch (field) {
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
        // The buckets refuse a favourite filter with partners' items, so where the view includes
        // them the condition is left to the search results rather than dropping partners (review).
        if (typeof eq === 'boolean' && options.isFavorite === undefined && !options.withPartners) {
          options.isFavorite = eq;
          continue;
        }
        break;
      }
    }
    unapplied.push(field);
  }
  return { options, unapplied };
};

/** The Photos page's own timeline options, which a "View in library" link lands on. */
export const PHOTOS_TIMELINE_OPTIONS: TimelineManagerOptions = {
  visibility: AssetVisibility.Timeline,
  withStacked: true,
  withPartners: true,
};

/**
 * Where "View in library" goes for a query (review M3): the Photos page when the time buckets can
 * apply every condition, so its chips are exactly what narrows the grid; otherwise the search
 * results page, which applies the whole query (a folder path, search text, several tags).
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
