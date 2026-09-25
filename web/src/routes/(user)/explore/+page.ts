import {
  AssetOrder,
  AssetTypeEnum,
  AssetVisibility,
  getAlbumTree,
  getAllPeople,
  getAssetStatistics,
  getBestPhotos,
  getExploreData,
  MemorySearchOrder,
  searchAssetStatistics,
  searchAssets,
  searchFacets,
  SearchFacetField,
  type AlbumResponseDto,
  type AlbumTreeResponseDto,
  type AssetResponseDto,
  type MetadataSearchDto,
} from '@immich/sdk';
import {
  BEST_PHOTOS_PREVIEW_LIMIT,
  BEST_PHOTOS_QUALITY_MIN_SCORE,
  buildExplorePeople,
  buildExplorePlaces,
  buildExploreThings,
  EXPLORE_FACET_LIMIT,
  EXPLORE_FACETS,
  EXPLORE_PLACE_LIMIT,
  EXPLORE_RECENT_LIMIT,
  EXPLORE_THING_LIMIT,
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
 * The newest match of the very search a card opens, as its cover (the prototype covers a bucket with
 * its newest asset). Going through the same search keeps the cover inside the card's scope, so a
 * Locked, hidden or partner-hidden item can never be one.
 */
const coverOf = async (dto: MetadataSearchDto): Promise<AssetResponseDto | undefined> => {
  const { assets } = await searchAssets({ metadataSearchDto: { ...dto, size: 1, order: AssetOrder.Desc } });
  return assets.items[0];
};

const coversFor = async (keys: string[], search: (key: string) => MetadataSearchDto) => {
  const entries = await Promise.all(
    keys.map(async (key) => [key, await coverOf(search(key)).catch(() => undefined)] as const),
  );
  return new Map(entries.filter((entry): entry is readonly [string, AssetResponseDto] => !!entry[1]));
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
    facets,
    recentCaptures,
  ] = await Promise.all([
    getExploreData(),
    getAllPeople({ withHidden: false }),
    getAlbumTree(),
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
    // T-12: People, Places and Things counts, from the same flat search scope their cards open.
    searchFacets({ searchFacetsDto: { facets: EXPLORE_FACETS, facetLimit: EXPLORE_FACET_LIMIT } }).catch(() => null),
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

  const cityCounts = facetCounts(facets?.facets, SearchFacetField.City).slice(0, EXPLORE_PLACE_LIMIT);
  const tagCounts = facetCounts(facets?.facets, SearchFacetField.Tags).slice(0, EXPLORE_THING_LIMIT);
  // The Explore endpoint already carries one photo per city; only cities it does not cover search.
  const exploreCovers = new Map(
    (explore.find((item) => item.fieldName === 'exifInfo.city')?.items ?? []).map((item) => [item.value, item.data]),
  );
  const [placeCovers, thingCovers] = await Promise.all([
    coversFor(
      cityCounts.map(({ value }) => value).filter((city) => !exploreCovers.has(city)),
      (city) => ({ city }),
    ),
    coversFor(
      tagCounts.map(({ value }) => value),
      (tagId) => ({ tagIds: [tagId] }),
    ),
  ]);

  return {
    peopleCards: buildExplorePeople(facetCounts(facets?.facets, SearchFacetField.People), people.people),
    places: buildExplorePlaces(cityCounts, new Map([...exploreCovers, ...placeCovers])),
    things: buildExploreThings(tagCounts, thingCovers),
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
