import { getTimeBucket, getTimelineOrdered } from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { toISOYearMonthUTC } from '$lib/utils/timeline-util';
import { TimelineManager } from '../timeline-manager.svelte';
import type { TimelineMonth } from '../timeline-month.svelte';
import type { TimelineManagerOptions } from '../types';

export async function loadFromTimeBuckets(
  timelineManager: TimelineManager,
  timelineMonth: TimelineMonth,
  options: TimelineManagerOptions,
  signal: AbortSignal,
): Promise<void> {
  if (timelineMonth.getFirstAsset()) {
    return;
  }

  const timeBucket = toISOYearMonthUTC(timelineMonth.yearMonth);
  const bucketResponse = await getTimeBucket(
    {
      ...authManager.params,
      ...options,
      timeBucket,
    },
    { signal },
  );

  if (!bucketResponse || signal.aborted) {
    return;
  }

  if (options.timelineAlbumId) {
    const albumAssets = await getTimeBucket(
      {
        ...authManager.params,
        albumId: options.timelineAlbumId,
        timeBucket,
      },
      { signal },
    );
    if (!albumAssets || signal.aborted) {
      return;
    }
    for (const id of albumAssets.id) {
      timelineManager.albumAssets.add(id);
    }
  }

  const unprocessedAssets = timelineMonth.addAssets(bucketResponse, true);
  if (unprocessedAssets.length > 0) {
    console.error(
      `Warning: getTimeBucket API returning assets not in requested month: ${timelineMonth.yearMonth.month}, ${JSON.stringify(
        unprocessedAssets.map((unprocessed) => ({
          id: unprocessed.id,
          localDateTime: unprocessed.localDateTime,
        })),
      )}`,
    );
  }
}

/** FL-30 (S-15): assets per page of a flat order. */
export const ORDERED_PAGE_SIZE = 500;

/**
 * The key of page `page` of a flat order. Pages are held as synthetic months whose keys sort in page
 * order the way the manager orders months (newest first), far past any real capture date.
 */
export const orderedPageYearMonth = (page: number) => ({ year: 9999 - Math.floor(page / 12), month: 12 - (page % 12) });

/** Load one page of a flat order into its synthetic month, in the server's order. */
export async function loadOrderedPage(
  timelineMonth: TimelineMonth,
  page: number,
  options: TimelineManagerOptions,
  signal: AbortSignal,
): Promise<void> {
  if (timelineMonth.getFirstAsset() || !options.orderedBy) {
    return;
  }
  const response = await getTimelineOrdered(
    {
      ...authManager.params,
      ...options,
      sort: options.orderedBy,
      skip: page * ORDERED_PAGE_SIZE,
      take: ORDERED_PAGE_SIZE,
    },
    { signal },
  );
  if (!response || signal.aborted) {
    return;
  }
  timelineMonth.addOrderedAssets(response);
}
