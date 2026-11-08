/**
 * FL-1300: the pure rules behind the Magic Albums cleanup scan. Everything here is a judgment call to tune on real
 * libraries, which is why each threshold has a name.
 */

/** Rule 7: two albums hold "the same photos" at this share of the smaller one. */
export const SAME_PHOTOS_SHARE = 0.9;
/** Rule 12: home is everything this far from the centre of the densest GPS cluster. */
export const HOME_RADIUS_KM = 100;
/** The review's picker lists this many of the largest clusters. */
export const HOME_AREAS_SHOWN = 5;
/** A snapshot older than this is computed again the next time the person opens Albums. */
export const CLEANUP_SCAN_STALE_HOURS = 24;
/** Suggestions listed per album in the snapshot; healing still sends each approved photo's id. */
export const CLEANUP_MAX_LOST_DATES_PER_ALBUM = 200;
/** Nothing else is moving: a run with no progress for this long is treated as stopped, so Undo stays available. */
export const CLEANUP_APPLY_STALLED_MINUTES = 30;

const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_SOURCE = [
  `(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}`,
  `\\d{1,2}\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}`,
  String.raw`\d{4}[-/]\d{1,2}[-/]\d{1,2}`,
  String.raw`\d{1,2}/\d{1,2}/\d{4}`,
  `(?:${MONTHS})\\.?\\s+\\d{4}`,
].join('|');
const DATE_ONLY = new RegExp(`^(?:${DATE_SOURCE})$`, 'i');
const DATE_ANYWHERE = new RegExp(`\\b(?:${DATE_SOURCE})\\b`, 'gi');
/** The default delimiters of the review, read the same way it reads them: dates whole, then "-", "," and ":". */
const DEFAULT_SPLIT = /\s+[-–—]\s+|\s*,\s+|\s*:\s+/;

export const cleanAlbumName = (name: string): string => name.trim().replaceAll(/\s+/g, ' ');

/** Rule 5: same after trimming, collapsing spaces and ignoring case. */
export const albumNameKey = (name: string): string => cleanAlbumName(name).toLowerCase();

/** Rule 16: only an album named nothing but a date can be removed. */
export const isDateOnlyName = (name: string): boolean => DATE_ONLY.test(cleanAlbumName(name));

const firstLevelOf = (name: string): string | undefined => {
  const parts = cleanAlbumName(name)
    .replaceAll(DATE_ANYWHERE, (match) => match.replaceAll(/[\s,]/g, '_'))
    .split(DEFAULT_SPLIT);
  return parts.length > 1 ? parts[0].toLowerCase() : undefined;
};

export type CleanupCountInput = {
  albums: { id: string; name: string }[];
  sameName: { albumIds: string[] }[];
  samePhotos: { firstId: string; secondId: string }[];
  sameTrip: { firstId: string; secondId: string }[];
  lostDates: { albumId: string }[];
};

/**
 * How much the review would have to offer, counted once per album, so a clean or small library never gets the
 * banner. The planner in the browser is the authority on what changes; this only decides whether to mention it.
 */
export const countCleanupSuggestions = ({ albums, sameName, samePhotos, sameTrip, lostDates }: CleanupCountInput) => {
  const levels = new Map<string, string[]>();
  const counted = new Set<string>();
  for (const { id, name } of albums) {
    if (isDateOnlyName(name)) {
      counted.add(id);
      continue;
    }
    const level = firstLevelOf(name);
    if (level) {
      levels.set(level, [...(levels.get(level) ?? []), id]);
    }
  }
  for (const ids of levels.values()) {
    if (ids.length >= 2) {
      for (const id of ids) {
        counted.add(id);
      }
    }
  }
  for (const { albumIds } of sameName) {
    for (const id of albumIds) {
      counted.add(id);
    }
  }
  for (const { firstId, secondId } of [...samePhotos, ...sameTrip]) {
    counted.add(firstId).add(secondId);
  }
  for (const { albumId } of lostDates) {
    counted.add(albumId);
  }
  return counted.size;
};

export const distanceKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLon = (b.lon - a.lon) * radians;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

export type GpsBin = { lat: number; lon: number; count: number; city: string | null };
export type HomeArea = { city: string | null; lat: number; lon: number; photoCount: number };

/**
 * Rule 12: where the photos cluster. The densest bin seeds a cluster of everything within the home radius, the
 * cluster is labelled by the city most of its photos were taken in, and the five largest are offered as home.
 */
export const detectHomeAreas = (bins: GpsBin[], shown = HOME_AREAS_SHOWN): HomeArea[] => {
  const remaining = bins.filter((bin) => bin.count > 0).sort((a, b) => b.count - a.count);
  const areas: HomeArea[] = [];
  while (remaining.length > 0 && areas.length < shown) {
    const seed = remaining[0];
    const members = remaining.filter((bin) => distanceKm(seed, bin) <= HOME_RADIUS_KM);
    const photoCount = members.reduce((sum, bin) => sum + bin.count, 0);
    const tally = new Map<string, number>();
    for (const { city, count } of members) {
      if (city) {
        tally.set(city, (tally.get(city) ?? 0) + count);
      }
    }
    const [city] = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [null];
    areas.push({
      city,
      lat: members.reduce((sum, bin) => sum + bin.lat * bin.count, 0) / photoCount,
      lon: members.reduce((sum, bin) => sum + bin.lon * bin.count, 0) / photoCount,
      photoCount,
    });
    for (const member of members) {
      remaining.splice(remaining.indexOf(member), 1);
    }
  }
  return areas.sort((a, b) => b.photoCount - a.photoCount);
};
