import { addAssetsToAlbum, createAlbum, searchAssets, searchSmart } from '@frameleaf/sdk';
import { DateTime } from 'luxon';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { chunk, resolveMatchingIds } from '$lib/frameleaf/bulk-operations';
import type { LibraryViewState } from '$lib/frameleaf/library-session';

/**
 * A visit to a landmark as an album (FL-356): every item taken there on a run of local days, which is
 * more than the handful a memory of the visit shows. The days are `yyyy-MM-dd`, both included. Returns
 * the album's id, or null when nothing was taken there on those days.
 */
export const createLandmarkAlbum = async (visit: {
  landmarkId: string;
  startDate: string;
  endDate: string;
  albumName: string;
}): Promise<string | null> => {
  const dayAfter = DateTime.fromISO(visit.endDate, { zone: 'utc' }).plus({ days: 1 }).toISODate();
  const state = {
    version: 1,
    scope: { kind: 'library' },
    query: {
      ...emptyDiscoveryQuery(),
      filter: {
        landmarkIds: { any: [visit.landmarkId] },
        // the local capture day, as the server grouped the visit
        localDateTime: { gte: `${visit.startDate}T00:00:00.000Z`, lt: `${dayAfter}T00:00:00.000Z` },
      },
    },
    sort: 'captured-desc',
    grouping: 'all',
    view: 'grid',
  };
  const { ids } = await resolveMatchingIds(state as LibraryViewState, { gateway: { searchAssets, searchSmart } });
  if (ids.length === 0) {
    return null;
  }
  const album = await createAlbum({ createAlbumDto: { albumName: visit.albumName } });
  for (const part of chunk(ids)) {
    await addAssetsToAlbum({ id: album.id, bulkIdsDto: { ids: part } });
  }
  return album.id;
};
