import {
  addAssetsToAlbum,
  createAlbum,
  getAllAlbums,
  searchAssets,
  searchHistogram,
  SearchHistogramGranularity,
  searchSmart,
} from '@frameleaf/sdk';
import { DateTime } from 'luxon';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { chunk, resolveMatchingIds } from '$lib/frameleaf/bulk-operations';
import type { LandmarkCard } from '$lib/frameleaf/landmarks';
import type { LibraryViewState } from '$lib/frameleaf/library-session';

/**
 * A visit to a landmark as an album (FL-356): every item taken there on a run of local days, which is
 * more than the handful a memory of the visit shows. The days are `yyyy-MM-dd`, both included. `assetIds`
 * are added whatever their position: a memory's own items, one of which may have been taken just outside
 * the place, so the album never holds less than the memory it was saved from. Returns the album's id, or
 * null when there is nothing to put in it.
 */
export const createLandmarkAlbum = async (visit: {
  landmarkId: string;
  startDate: string;
  endDate: string;
  albumName: string;
  assetIds?: string[];
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
  const taken = await resolveMatchingIds(state as LibraryViewState, { gateway: { searchAssets, searchSmart } });
  if (taken.truncated) {
    throw new Error('The complete landmark visit could not be collected');
  }
  const ids = [...new Set([...taken.ids, ...(visit.assetIds ?? [])])];
  if (ids.length === 0) {
    return null;
  }
  const album = await createAlbum({ createAlbumDto: { albumName: visit.albumName } });
  for (const part of chunk(ids)) {
    await addAssetsToAlbum({ id: album.id, bulkIdsDto: { ids: part } });
  }
  return album.id;
};

/* -------------------------------------------------------------------------- */
/* Suggested albums (FL-357)                                                    */
/* -------------------------------------------------------------------------- */

/** A visit with fewer items than this is not offered as an album. */
export const MIN_SUGGESTED_ALBUM_ITEMS = 5;
/** How many of the most photographed landmarks are looked at for a visit to suggest. */
const SUGGESTION_CANDIDATES = 3;

export type LandmarkVisit = { startDate: string; endDate: string; count: number };
export type LandmarkAlbumSuggestion = LandmarkVisit & { landmark: LandmarkCard };

const daysBetween = (from: string, to: string) =>
  DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days').days;

/**
 * The visits in a landmark's day-by-day counts (oldest first): days at most one empty day apart are one
 * visit, so a rest day in the middle of a stay does not split it.
 */
export const landmarkVisits = (days: { date: string; count: number }[]): LandmarkVisit[] => {
  const visits: LandmarkVisit[] = [];
  for (const { date, count } of days) {
    const current = visits.at(-1);
    if (current && daysBetween(current.endDate, date) <= 2) {
      current.endDate = date;
      current.count += count;
    } else {
      visits.push({ startDate: date, endDate: date, count });
    }
  }
  return visits;
};

// ponytail: "Not now" is remembered on this device only, and an album already named for the landmark is
// what stops it being suggested again. Keep both on the server (the plan's show-less list) if a suggestion
// should follow the account, or a second visit to the same place should get its own.
const NOT_NOW_KEY = 'frameleaf:landmark-album-not-now';
const visitKey = ({ landmark, startDate }: Pick<LandmarkAlbumSuggestion, 'landmark' | 'startDate'>) =>
  `${landmark.id}:${startDate}`;
const readNotNow = (): string[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(NOT_NOW_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
};

/** "Not now": this visit is not suggested again on this device. */
export const dismissLandmarkAlbum = (suggestion: LandmarkAlbumSuggestion) => {
  try {
    localStorage.setItem(NOT_NOW_KEY, JSON.stringify([...new Set([...readNotNow(), visitKey(suggestion)])]));
  } catch {
    // no storage (private window): the suggestion comes back next time, which is harmless
  }
};

/**
 * An album worth suggesting: the busiest visit to the most photographed landmark that has no album of its
 * name yet and was not turned down. `landmarks` are the visited landmarks, most photographed first.
 */
export const suggestLandmarkAlbum = async (landmarks: LandmarkCard[]): Promise<LandmarkAlbumSuggestion | null> => {
  const candidates = landmarks
    .filter(({ count }) => count >= MIN_SUGGESTED_ALBUM_ITEMS)
    .slice(0, SUGGESTION_CANDIDATES);
  if (candidates.length === 0) {
    return null;
  }
  const albums = await getAllAlbums({});
  const taken = new Set(albums.map(({ albumName }) => albumName));
  const notNow = new Set(readNotNow());
  for (const landmark of candidates) {
    if (taken.has(landmark.label)) {
      continue;
    }
    const { buckets } = await searchHistogram({
      searchHistogramDto: {
        filter: { landmarkIds: { any: [landmark.id] } },
        granularity: SearchHistogramGranularity.Day,
      },
    });
    let busiest: LandmarkVisit | undefined;
    for (const visit of landmarkVisits(buckets)) {
      const offered = visit.count >= MIN_SUGGESTED_ALBUM_ITEMS && !notNow.has(visitKey({ landmark, ...visit }));
      if (offered && visit.count > (busiest?.count ?? 0)) {
        busiest = visit;
      }
    }
    if (busiest) {
      return { ...busiest, landmark };
    }
  }
  return null;
};
