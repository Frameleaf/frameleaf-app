import { getTimeBucket, getTimelineOrdered, type TimeBucketAssetResponseDto } from '@frameleaf/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { toISOYearMonthUTC } from '$lib/utils/timeline-util';
import { TimelineManager } from '../timeline-manager.svelte';
import type { TimelineMonth } from '../timeline-month.svelte';
import type { TimelineManagerOptions } from '../types';

/** Tries a load makes while live changes keep landing on it, before it gives way. */
const STALE_LOAD_ATTEMPTS = 3;

/**
 * A load a newer timeline (or a live change) overtook. Thrown, not returned, so the month's loader
 * ends cancelled and loads again later, instead of counting an empty month as loaded.
 */
const superseded = () => new DOMException('Timeline month load superseded', 'AbortError');

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
  for (let attempt = 1; ; attempt++) {
    const projection = timelineManager.projectionGeneration;
    const bucketResponse = await getTimeBucket(
      {
        ...authManager.params,
        ...options,
        timeBucket,
      },
      { signal },
    );
    const albumAssets =
      options.timelineAlbumId && bucketResponse
        ? await getTimeBucket(
            {
              ...authManager.params,
              albumId: options.timelineAlbumId,
              timeBucket,
            },
            { signal },
          )
        : undefined;
    if (signal.aborted || !timelineManager.months.includes(timelineMonth)) {
      throw superseded();
    }
    if (projection !== timelineManager.projectionGeneration) {
      // A live change landed while this was in flight: ask again rather than keep a stale read.
      if (attempt < STALE_LOAD_ATTEMPTS) {
        continue;
      }
      throw superseded();
    }
    if (!bucketResponse || (options.timelineAlbumId && !albumAssets)) {
      return;
    }
    for (const id of albumAssets?.id ?? []) {
      timelineManager.albumAssets.add(id);
    }
    addBucketAssets(timelineMonth, bucketResponse);
    return;
  }
}

const addBucketAssets = (timelineMonth: TimelineMonth, bucketResponse: TimeBucketAssetResponseDto) => {
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
};

/** FL-30 (S-15): assets per page of a flat order. */
export const ORDERED_PAGE_SIZE = 500;

/**
 * The key of page `page` of a flat order. Pages are held as synthetic months whose keys sort in page
 * order the way the manager orders months (newest first), far past any real capture date.
 */
export const orderedPageYearMonth = (page: number) => ({ year: 9999 - Math.floor(page / 12), month: 12 - (page % 12) });

// Synthetic month arrays are replaced on refresh, filter/sort changes and session changes.
// Keep boundaries after a page unloads, but never share them with a new timeline generation.
const orderedPageCursors = new WeakMap<TimelineMonth[], Map<number, { start?: string; end?: string }>>();

export function clearOrderedPageCursors(months: TimelineMonth[]) {
  orderedPageCursors.delete(months);
}

/** Load one page of a flat order into its synthetic month, in the server's order. */
export async function loadOrderedPage(
  timelineMonth: TimelineMonth,
  months: TimelineMonth[],
  options: TimelineManagerOptions,
  signal: AbortSignal,
): Promise<void> {
  if (timelineMonth.getFirstAsset() || !options.orderedBy) {
    return;
  }
  const manager = timelineMonth.timelineManager;
  const page = months.indexOf(timelineMonth);
  if (page === -1) {
    return;
  }
  let cursors = orderedPageCursors.get(months);
  if (!cursors) {
    cursors = new Map();
    orderedPageCursors.set(months, cursors);
  }
  for (let attempt = 1; ; attempt++) {
    const projection = manager.projectionGeneration;
    const after = cursors.get(page - 1)?.end;
    const before = after ? undefined : cursors.get(page + 1)?.start;
    const response = await getTimelineOrdered(
      {
        ...authManager.params,
        ...options,
        sort: options.orderedBy,
        ...(after ? { after } : before ? { before } : { skip: page * ORDERED_PAGE_SIZE }),
        take: ORDERED_PAGE_SIZE,
      },
      { signal },
    );
    if (signal.aborted || manager.months !== months) {
      throw superseded();
    }
    if (projection !== manager.projectionGeneration) {
      if (attempt < STALE_LOAD_ATTEMPTS) {
        continue;
      }
      throw superseded();
    }
    if (!response) {
      return;
    }
    // An update during this request may have invalidated its boundaries. Do not retain them.
    if (orderedPageCursors.get(months) === cursors) {
      cursors.set(page, { start: response.startCursor ?? undefined, end: response.endCursor ?? undefined });
    }
    timelineMonth.addOrderedAssets(response);
    return;
  }
}
