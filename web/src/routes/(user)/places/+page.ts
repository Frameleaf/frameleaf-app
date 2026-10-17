import {
  AssetVisibility,
  getAssetsByCity,
  getCityAssetCounts,
  getVisitedLandmarks,
  searchAssetStatistics,
} from '@frameleaf/sdk';
import { buildLandmarkCards } from '$lib/frameleaf/landmarks';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();
  // FL-51: one photo per city, the photos and videos in each city, and how many timeline items have
  // no place at all (the header's "N without a location"); the last two are hints and never fail
  // the page. If the places themselves cannot load, the page still opens and says so with a retry.
  const [items, counts, unplaced, landmarks] = await Promise.all([
    getAssetsByCity().catch(() => null),
    getCityAssetCounts().catch(() => []),
    searchAssetStatistics({
      statisticsSearchDto: { city: null, country: null, visibility: AssetVisibility.Timeline },
    })
      .then(({ total }) => total)
      .catch(() => null),
    // FL-354: visited landmarks sit under the region most of their photos were taken in; a hint too
    getVisitedLandmarks().catch(() => []),
  ]);

  return {
    items: items ?? [],
    failed: items === null,
    counts,
    unplaced,
    landmarks: buildLandmarkCards(landmarks),
    meta: {
      title: $t('places'),
    },
  };
}) satisfies PageLoad;
