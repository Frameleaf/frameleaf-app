import {
  AssetTypeEnum,
  AssetVisibility,
  SearchFacetField,
  type SearchFacetsDto,
  type AssetResponseDto,
  type PersonResponseDto,
  type SearchFacetResponseDto,
} from '@immich/sdk';
import { mdiCameraOutline, mdiHeartOutline, mdiImageSearchOutline, mdiMovieOpenOutline } from '@mdi/js';
import type { Translations } from 'svelte-i18n';
import { Route } from '$lib/route';

/**
 * Frameleaf Explore destination (FL-50).
 *
 * Ported from the approved prototype (`design/frameleaf/template/src/ExploreLibrary.jsx`,
 * `explore-timeline.mjs`), but built over the real Explore/People/Best Photos/search
 * endpoints instead of the prototype's local sample array: production already
 * pre-aggregates people, cities and recent uploads server side
 * (`SearchService.getExploreData`), so unlike the prototype this module does not
 * recompute those groupings client side — it only shapes real API responses into the
 * card data the panel renders, and keeps the query semantics that the acceptance
 * criteria call for: card counts and the destinations they link to share the same
 * scope/archive/privacy rules, because the route loader (`explore/+page.ts`) fetches each
 * shortcut's count with the exact same `type`/`filter` shape this module builds into its
 * `href`, so both resolve through the same `SearchService` scope.
 *
 * Best Photos never falls back to star ratings: `bestPhotosPreview` only reports what
 * `BestPhotosService.getBestPhotos` returns for assets whose quality score has actually
 * been computed, and the panel shows the graceful "not scored yet" copy when that total
 * is zero rather than substituting a rating-based count.
 */

/** Matches the design template's `bestPhotosScore >= 90` threshold on the 0–1 production scale. */
export const BEST_PHOTOS_QUALITY_MIN_SCORE = 0.9;

/** How many of the account's own quality-scored assets to ask for; only `total` and the first cover are used. */
export const BEST_PHOTOS_PREVIEW_LIMIT = 1;

export interface ExploreBestPhotosPreview {
  /** Count of assets at or above {@link BEST_PHOTOS_QUALITY_MIN_SCORE}, or null while it has not loaded yet. */
  total: number | null;
  cover: AssetResponseDto | null;
}

export interface ExploreShortcutCounts {
  favorites: number | null;
  photos: number | null;
  videos: number | null;
  withoutPeople: number | null;
}

export const emptyExploreShortcutCounts = (): ExploreShortcutCounts => ({
  favorites: null,
  photos: null,
  videos: null,
  withoutPeople: null,
});

export type ExploreShortcutId = 'favorites' | 'photos' | 'videos' | 'withoutPeople';

export interface ExploreShortcut {
  id: ExploreShortcutId;
  labelKey: Translations;
  icon: string;
  count: number | null;
  href: string;
}

/**
 * The four destination shortcuts from the design template's highlight row. Each `href`
 * points at a real, already-accessible destination: Favorites has its own scoped route,
 * the rest deep-link into the search page with the same DTO shape the loader's
 * `searchAssetStatistics` call used for its count, so the number a person sees is the
 * number they land on.
 */
export const buildExploreShortcuts = (counts: ExploreShortcutCounts): ExploreShortcut[] => [
  {
    id: 'favorites',
    labelKey: 'favorites',
    icon: mdiHeartOutline,
    count: counts.favorites,
    href: Route.favorites(),
  },
  {
    id: 'videos',
    labelKey: 'frameleaf_explore_shortcut_videos',
    icon: mdiMovieOpenOutline,
    count: counts.videos,
    href: Route.search({ type: AssetTypeEnum.Video }),
  },
  {
    id: 'photos',
    labelKey: 'frameleaf_explore_shortcut_photos',
    icon: mdiCameraOutline,
    count: counts.photos,
    href: Route.search({ type: AssetTypeEnum.Image }),
  },
  {
    id: 'withoutPeople',
    labelKey: 'frameleaf_explore_shortcut_without_people',
    icon: mdiImageSearchOutline,
    count: counts.withoutPeople,
    href: Route.search({ filter: { hasPeople: { eq: false } } }),
  },
];

/** Enough values that the People row can skip unnamed people and still fill its twelve cards. */
export const EXPLORE_FACET_LIMIT = 30;

export const EXPLORE_FACETS = [SearchFacetField.People, SearchFacetField.City, SearchFacetField.Tags];

/**
 * T-12: the one `POST /search/facets` body Explore counts and covers its People, Places and "Things
 * in your photos" cards with. Each card opens a flat search (`Route.search({ personIds })`,
 * `{ city }`, `{ tagIds }`), and the search session sends every flat search with Timeline visibility
 * (`library-search-session.svelte.ts`), so this body carries the same visibility: the count on a
 * card is the number of results it opens, and nothing archived, Locked (even in an unlocked session)
 * or a Live Photo's video part is counted or chosen as a cover. The server also leaves out hidden and
 * suppressed people, suppressed tags and the places of partners who hide their locations, and takes
 * each cover (`facetCovers`, the newest match) from the same matched set as the count.
 */
export const exploreFacetsBody: SearchFacetsDto = {
  visibility: AssetVisibility.Timeline,
  facets: EXPLORE_FACETS,
  facetLimit: EXPLORE_FACET_LIMIT,
  facetCovers: true,
};

/** Cards per section, as `ExploreLibrary.jsx` slices them. */
export const EXPLORE_PEOPLE_LIMIT = 12;
export const EXPLORE_PLACE_LIMIT = 8;
export const EXPLORE_THING_LIMIT = 10;
export const EXPLORE_RECENT_LIMIT = 8;

export interface ExploreFacetCount {
  value: string;
  label?: string | null;
  count: number;
  coverAssetId?: string | null;
}

/** A facet's counts, busiest first as the server sorts them; none when the facet is missing. */
export const facetCounts = (facets: SearchFacetResponseDto[] | null | undefined, field: SearchFacetField) =>
  (facets?.find((facet) => facet.fieldName === field)?.counts ?? []).filter((item) => item.count > 0);

export interface ExplorePersonCard {
  id: string;
  person: PersonResponseDto;
  label: string;
  count: number;
  href: string;
}

/**
 * People cards (`exploreSections` people): the counted people the account can name, busiest first.
 * A person must be in the account's own (non-hidden) people list; a count for anyone else is ignored.
 */
export const buildExplorePeople = (
  counts: ExploreFacetCount[],
  people: PersonResponseDto[],
  limit = EXPLORE_PEOPLE_LIMIT,
): ExplorePersonCard[] => {
  const known = new Map(people.filter((person) => !person.isHidden).map((person) => [person.id, person]));
  const cards: ExplorePersonCard[] = [];
  for (const { value, count } of counts) {
    const person = known.get(value);
    if (!person?.name) {
      continue;
    }
    cards.push({ id: person.id, person, label: person.name, count, href: Route.search({ personIds: [person.id] }) });
    if (cards.length === limit) {
      break;
    }
  }
  return cards;
};

export interface ExploreCoverCard {
  id: string;
  label: string;
  count: number;
  href: string;
  /** The newest match of the card's own search, from the facet request; null when it has none. */
  coverAssetId: string | null;
}

/** Places cards: cities by count, each opening the search for that city. */
export const buildExplorePlaces = (counts: ExploreFacetCount[], limit = EXPLORE_PLACE_LIMIT): ExploreCoverCard[] =>
  counts.slice(0, limit).map(({ value, count, coverAssetId }) => ({
    id: value,
    label: value,
    count,
    href: Route.search({ city: value }),
    coverAssetId: coverAssetId ?? null,
  }));

/** "Things in your photos" (`ExploreLibrary.jsx:196-220`): the account's tags by count. */
export const buildExploreThings = (counts: ExploreFacetCount[], limit = EXPLORE_THING_LIMIT): ExploreCoverCard[] =>
  counts.slice(0, limit).map(({ value, label, count, coverAssetId }) => ({
    id: value,
    label: label || value,
    count,
    href: Route.search({ tagIds: [value] }),
    coverAssetId: coverAssetId ?? null,
  }));

/**
 * The recorded local calendar day of a capture (`explore-timeline.mjs` `captureDate(...).day`),
 * read from `localDateTime` without passing through the browser's time zone; null when unknown or
 * when the day does not exist (a 31 February is rejected, as the prototype rejects it).
 */
export const captureDay = (asset: Pick<AssetResponseDto, 'localDateTime'>): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(asset.localDateTime ?? '');
  if (!match || Number(match[1]) < 1) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
};

export const isVideoAsset = (asset: Pick<AssetResponseDto, 'type'>) => asset.type === AssetTypeEnum.Video;
