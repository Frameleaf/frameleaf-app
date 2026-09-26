import {
  AssetOrder,
  AssetTypeEnum,
  AssetVisibility,
  getAlbumTree,
  getAllPeople,
  getAssetStatistics,
  getBestPhotos,
  MemorySearchOrder,
  searchAssetStatistics,
  searchAssets,
  searchFacets,
  SearchFacetField,
  type AlbumResponseDto,
  type AlbumTreeResponseDto,
} from '@immich/sdk';
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

export const load = (async ({ url }) => {
  await authenticate(url);
  memoryManager.setFilters({ size: 12, order: MemorySearchOrder.Desc });
  await memoryManager.applyPreferences();

  const [
    people,
    albums,
    memories,
    favoriteStatistics,
    photoStatistics,
    videoStatistics,
    withoutPeopleStatistics,
    bestPhotos,
    facets,
    recentCaptures,
  ] = await Promise.all([
    getAllPeople({ withHidden: false }),
    getAlbumTree(),
    memoryManager.refresh().then(() => memoryManager.memories),
    // Card counts share the same scope/archive/privacy rules as the destinations they link to.
    // Favorites: with no visibility, statistics and the Favorites timeline (time buckets scoped by
    // `isFavorite`) both take the server's default visibility, Timeline and Archive, never Locked.
    getAssetStatistics({ isFavorite: true }).catch(() => null),
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
    // Never a star-rating fallback: only assets with a computed quality score count here.
    getBestPhotos({ minScore: BEST_PHOTOS_QUALITY_MIN_SCORE, limit: BEST_PHOTOS_PREVIEW_LIMIT }).catch(() => null),
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
    favorites: favoriteStatistics ? favoriteStatistics.images + favoriteStatistics.videos : null,
    photos: photoStatistics ? photoStatistics.total : null,
    videos: videoStatistics ? videoStatistics.total : null,
    withoutPeople: withoutPeopleStatistics ? withoutPeopleStatistics.total : null,
  };

  const bestPhotosPreview: ExploreBestPhotosPreview = {
    total: bestPhotos ? bestPhotos.total : null,
    cover: bestPhotos?.items[0] ?? null,
  };

  return {
    peopleCards: buildExplorePeople(facetCounts(facets?.facets, SearchFacetField.People), people.people),
    places: buildExplorePlaces(facetCounts(facets?.facets, SearchFacetField.City)),
    things: buildExploreThings(facetCounts(facets?.facets, SearchFacetField.Tags)),
    libraryTotal: facets ? facets.total : null,
    recentCaptures: recentCaptures ?? [],
    albums: previewAlbums(albums),
    memories,
    shortcutCounts,
    bestPhotosPreview,
    meta: {
      title: $t('explore'),
    },
  };
}) satisfies PageLoad;
