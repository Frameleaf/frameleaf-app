import {
  AssetTypeEnum,
  getAllAlbums,
  getAllPeople,
  getAssetStatistics,
  getBestPhotos,
  getExploreData,
  MemorySearchOrder,
  searchAssetStatistics,
  type AlbumResponseDto,
} from '@immich/sdk';
import { buildAlbumTree } from '$lib/frameleaf/album-tree';
import {
  BEST_PHOTOS_PREVIEW_LIMIT,
  BEST_PHOTOS_QUALITY_MIN_SCORE,
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
const previewAlbums = (albums: AlbumResponseDto[]): AlbumResponseDto[] => {
  const standaloneIds = new Set(buildAlbumTree(albums).albums.map((node) => node.id));
  return albums
    .filter((album) => standaloneIds.has(album.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, EXPLORE_ALBUM_PREVIEW_COUNT);
};

export const load = (async ({ url }) => {
  await authenticate(url);
  memoryManager.setFilters({ size: 12, order: MemorySearchOrder.Desc });
  await memoryManager.applyPreferences();

  const [
    explore,
    people,
    albums,
    memories,
    favoriteStatistics,
    photoStatistics,
    videoStatistics,
    withoutPeopleStatistics,
    bestPhotos,
  ] = await Promise.all([
    getExploreData(),
    getAllPeople({ withHidden: false }),
    getAllAlbums({}),
    memoryManager.refresh().then(() => memoryManager.memories),
    // Card counts share the same scope/archive/privacy rules as the destinations they link to.
    // Favorites shares `getAssetStatistics`' default (timeline-only) visibility with the
    // dedicated Favorites route, which is itself a timeline scoped by `isFavorite`.
    getAssetStatistics({ isFavorite: true }).catch(() => null),
    // Photos/Videos/Without-people route to the search page, so their counts come from the
    // same `searchAssetStatistics` shapes `Route.search(...)` below resolves through: the flat
    // `type` field takes the legacy (non-locked, archive-inclusive) scope search already uses,
    // and the `filter.hasPeople` shape takes the new-shape scope the search page also honors.
    searchAssetStatistics({ statisticsSearchDto: { type: AssetTypeEnum.Image } }).catch(() => null),
    searchAssetStatistics({ statisticsSearchDto: { type: AssetTypeEnum.Video } }).catch(() => null),
    searchAssetStatistics({ statisticsSearchDto: { filter: { hasPeople: { eq: false } } } }).catch(() => null),
    // Never a star-rating fallback: only assets with a computed quality score count here.
    getBestPhotos({ minScore: BEST_PHOTOS_QUALITY_MIN_SCORE, limit: BEST_PHOTOS_PREVIEW_LIMIT }).catch(() => null),
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
    explore,
    people,
    albums: previewAlbums(albums),
    memories,
    shortcutCounts,
    bestPhotosPreview,
    meta: {
      title: $t('explore'),
    },
  };
}) satisfies PageLoad;
