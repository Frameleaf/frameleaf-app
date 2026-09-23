import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
import { mdiCameraOutline, mdiHeartOutline, mdiImageSearchOutline, mdiMovieOpenOutline } from '@mdi/js';
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
  labelKey: string;
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
