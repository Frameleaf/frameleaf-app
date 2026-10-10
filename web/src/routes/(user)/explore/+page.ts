import {
  AssetOrder,
  AssetTypeEnum,
  AssetVisibility,
  getAlbumTree,
  getAllPeople,
  getBestPhotos,
  getTimeBuckets,
  MemorySearchOrder,
  searchAssetStatistics,
  searchAssets,
  searchFacets,
  SearchFacetField,
  type AlbumResponseDto,
  type AlbumTreeResponseDto,
} from '@frameleaf/sdk';
import {
  BEST_PHOTOS_PREVIEW_LIMIT,
  BEST_PHOTOS_QUALITY_MIN_SCORE,
  buildExplorePeople,
  buildExplorePlaces,
  buildExploreThings,
  EXPLORE_RECENT_LIMIT,
  exploreFacetsBody,
  facetCounts,
  type ExploreBestPhotosPreview,
  type ExploreShortcutCounts,
} from '$lib/frameleaf/explore';
import { memoryManager } from '$lib/managers/memory-manager.svelte';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/** How many of the account's own albums (never collections or shared spaces) to preview. */
const EXPLORE_ALBUM_PREVIEW_COUNT = 6;

/** Standalone albums only — matches "From your albums" in the September 22, 2026 revision, which
 * replaces the earlier "Collections" wording; a collection groups albums and is not itself where
 * photos live, so it does not belong in this preview. */
const previewAlbums = (albums: AlbumTreeResponseDto): AlbumResponseDto[] => {
  return [...albums.albums]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, EXPLORE_ALBUM_PREVIEW_COUNT);
};

/**
 * The Best Photos card: how many items reach the quality threshold, and a picture for the card.
 * When nothing reaches it yet the picture is the first item the Best Photos page lists (the same
 * ranking, `GET /best-photos` without the threshold), so the card is not a blank while that page
 * has photos to show. The count stays the threshold's own and is never made up from this.
 */
const loadBestPhotosPreview = async (): Promise<ExploreBestPhotosPreview> => {
  // Never a star-rating fallback: only assets with a computed quality score count here.
  const scored = await getBestPhotos({ minScore: BEST_PHOTOS_QUALITY_MIN_SCORE, limit: BEST_PHOTOS_PREVIEW_LIMIT });
  if (scored.items[0]) {
    return { total: scored.total, cover: scored.items[0] };
  }
  const ranked = await getBestPhotos({ limit: BEST_PHOTOS_PREVIEW_LIMIT }).catch(() => null);
  return { total: scored.total, cover: ranked?.items[0] ?? null };
};

/**
 * "Days to revisit". The memory manager reads the account's memory preferences first; either step
 * failing only costs this one section.
 */
const loadMemories = async () => {
  memoryManager.setFilters({ size: 12, order: MemorySearchOrder.Desc });
  await memoryManager.applyPreferences();
  await memoryManager.refresh();
  return memoryManager.memories;
};

export const load = (async ({ url }) => {
  await authenticate(url);

  const [
    people,
    albums,
    memories,
    favoriteCount,
    photoStatistics,
    videoStatistics,
    withoutPeopleStatistics,
    bestPhotos,
    facets,
    recentCaptures,
  ] = await Promise.all([
    // Every section loads on its own: a request that fails leaves `null`, the page still opens, and
    // only that section says it could not load (`failed` below) instead of the whole page erroring.
    getAllPeople({ withHidden: false }).catch(() => null),
    getAlbumTree().catch(() => null),
    loadMemories().catch(() => null),
    // Card counts share the same scope/archive/privacy rules as the destinations they link to.
    // Favorites: the Favorites timeline's own query (its `options`), summed over its buckets, so the
    // count is what that page shows: Timeline and Archive, never Locked, and a stack once, as the
    // timeline draws it (asset statistics would count every item in a stack).
    getTimeBuckets({ isFavorite: true, withStacked: true })
      .then((buckets) => buckets.reduce((total, { count }) => total + count, 0))
      .catch(() => null),
    // Photos/Videos/Without-people route to the search page, so their counts are taken with the
    // body that page sends: a flat body gets the Timeline visibility the search session adds to
    // every flat search (`library-search-session.svelte.ts`), so nothing archived, Locked or a
    // Live Photo's video part is counted; the structured `filter.hasPeople` body is sent as is.
    searchAssetStatistics({
      statisticsSearchDto: { type: AssetTypeEnum.Image, visibility: AssetVisibility.Timeline },
    }).catch(() => null),
    searchAssetStatistics({
      statisticsSearchDto: { type: AssetTypeEnum.Video, visibility: AssetVisibility.Timeline },
    }).catch(() => null),
    searchAssetStatistics({ statisticsSearchDto: { filter: { hasPeople: { eq: false } } } }).catch(() => null),
    loadBestPhotosPreview().catch(() => null),
    // T-12: People, Places and Things counts and covers, in the scope of the flat search each card
    // opens (Timeline visibility, as the search session sends it), in one request.
    searchFacets({ searchFacetsDto: exploreFacetsBody }).catch(() => null),
    // "Recent captures" (ExploreLibrary.jsx:223-250) are the newest by capture date, not upload
    // ("Recently added" keeps upload order); the Timeline's own visibility, so nothing archived.
    searchAssets({
      metadataSearchDto: { size: EXPLORE_RECENT_LIMIT, order: AssetOrder.Desc, visibility: AssetVisibility.Timeline },
    })
      .then(({ assets }) => assets.items)
      .catch(() => null),
  ]);
  const $t = await getFormatter();

  const shortcutCounts: ExploreShortcutCounts = {
    favorites: favoriteCount,
    photos: photoStatistics ? photoStatistics.total : null,
    videos: videoStatistics ? videoStatistics.total : null,
    withoutPeople: withoutPeopleStatistics ? withoutPeopleStatistics.total : null,
  };

  const bestPhotosPreview: ExploreBestPhotosPreview = bestPhotos ?? { total: null, cover: null };

  return {
    failed: {
      people: people === null,
      // One facet request feeds People, Places and Things; Places carries its retry.
      places: facets === null,
      memories: memories === null,
      albums: albums === null,
      recents: recentCaptures === null,
    },
    peopleCards: buildExplorePeople(facetCounts(facets?.facets, SearchFacetField.People), people?.people ?? []),
    places: buildExplorePlaces(facetCounts(facets?.facets, SearchFacetField.City)),
    things: buildExploreThings(facetCounts(facets?.facets, SearchFacetField.Tags)),
    libraryTotal: facets ? facets.total : null,
    recentCaptures: recentCaptures ?? [],
    albums: albums ? previewAlbums(albums) : [],
    memories: memories ?? [],
    shortcutCounts,
    bestPhotosPreview,
    meta: {
      title: $t('explore'),
    },
  };
}) satisfies PageLoad;
