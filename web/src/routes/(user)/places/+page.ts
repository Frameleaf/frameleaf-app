import { AssetVisibility, getAssetsByCity, getCityAssetCounts, searchAssetStatistics } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();
  // FL-51: one photo per city, the photos and videos in each city, and how many timeline items have
  // no place at all (the header's "N without a location"); the last two are hints and never fail
  // the page.
  const [items, counts, unplaced] = await Promise.all([
    getAssetsByCity(),
    getCityAssetCounts().catch(() => []),
    searchAssetStatistics({
      statisticsSearchDto: { city: null, country: null, visibility: AssetVisibility.Timeline },
    })
      .then(({ total }) => total)
      .catch(() => null),
  ]);

  return {
    items,
    counts,
    unplaced,
    meta: {
      title: $t('places'),
    },
  };
}) satisfies PageLoad;
