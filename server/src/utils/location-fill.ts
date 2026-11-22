import geotz from 'geo-tz';
import { DateTime } from 'luxon';
import { distanceKm } from 'src/utils/album-cleanup.js';

/**
 * FL-964: where a photo without a location was probably taken, from its owner's location history. Everything here
 * is arithmetic on values already read; the service does the reading and the writing.
 */

export type FillPoint = { recordedAt: Date; latitude: number; longitude: number };

/** How a proposal was reached. A plain string in the API. */
export type FillMethod = 'nearest' | 'interpolated';

export type FillProposal = { latitude: number; longitude: number; method: FillMethod; gapSeconds: number };

/** Two history places further apart than this are not joined by a straight line: the person went somewhere between. */
export const FILL_INTERPOLATE_MAX_KM = 5;
/** A clock time with no zone is at most this far from the same moment in UTC (UTC-12 to UTC+14). */
export const FILL_ZONE_SEARCH_HOURS = 14;

const seconds = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 1000;

/**
 * The place for the moment `at`, from the history's last place at or before it and its first at or after it. A place
 * further than `maxGapSeconds` from the moment is not used. With one on each side, no more than 5 km apart, the photo
 * is put between them by time; otherwise it takes the nearer one's place.
 */
export const proposeLocation = (
  at: Date,
  before: FillPoint | null,
  after: FillPoint | null,
  maxGapSeconds: number,
): FillProposal | null => {
  const gapBefore = before ? seconds(before.recordedAt, at) : NaN;
  const gapAfter = after ? seconds(at, after.recordedAt) : NaN;
  const useBefore = gapBefore >= 0 && gapBefore <= maxGapSeconds;
  const useAfter = gapAfter >= 0 && gapAfter <= maxGapSeconds;
  if (
    useBefore &&
    useAfter &&
    gapBefore > 0 &&
    gapAfter > 0 &&
    distanceKm({ lat: before!.latitude, lon: before!.longitude }, { lat: after!.latitude, lon: after!.longitude }) <
      FILL_INTERPOLATE_MAX_KM
  ) {
    const share = gapBefore / (gapBefore + gapAfter);
    // the short way round, for the two places either side of the 180th meridian
    const turn = ((after!.longitude - before!.longitude + 540) % 360) - 180;
    return {
      latitude: before!.latitude + share * (after!.latitude - before!.latitude),
      longitude: ((before!.longitude + share * turn + 540) % 360) - 180,
      method: 'interpolated',
      gapSeconds: Math.round(Math.min(gapBefore, gapAfter)),
    };
  }
  const point = useBefore && (!useAfter || gapBefore <= gapAfter) ? before! : useAfter ? after! : null;
  return point
    ? {
        latitude: point.latitude,
        longitude: point.longitude,
        method: 'nearest',
        gapSeconds: Math.round(point === before ? gapBefore : gapAfter),
      }
    : null;
};

/** Looks up the time zone of a position, remembering every answer for the life of one run. */
export class ZoneLookup {
  private zones = new Map<string, string | null>();

  /** Minutes east of UTC at this place and moment; null where no zone is known. */
  offsetMinutes(point: FillPoint): number | null {
    // about a kilometre: a history has thousands of places within one street
    const key = `${point.latitude.toFixed(2)},${point.longitude.toFixed(2)}`;
    let zone = this.zones.get(key);
    if (zone === undefined) {
      // eslint-disable-next-line import-x/no-named-as-default-member
      zone = geotz.find(point.latitude, point.longitude)[0] ?? null;
      this.zones.set(key, zone);
    }
    const local = zone ? DateTime.fromJSDate(point.recordedAt, { zone }) : null;
    return local?.isValid ? local.offset : null;
  }
}

/**
 * The moments a clock time with no zone could be: one for each zone its owner's history says they were in around
 * then. `local` is the clock time held in UTC fields, as the asset table keeps it; `nearby` is a thin sample of the
 * history within `FILL_ZONE_SEARCH_HOURS` of it.
 */
export const candidateInstants = (
  local: Date,
  nearby: FillPoint[],
  zones: ZoneLookup,
): Array<{ at: Date; offsetMinutes: number }> => {
  const offsets = new Set<number>();
  for (const point of nearby) {
    const offset = zones.offsetMinutes(point);
    if (offset !== null) {
      offsets.add(offset);
    }
  }
  return [...offsets]
    .toSorted((a, b) => a - b)
    .map((offsetMinutes) => ({ at: new Date(local.getTime() - offsetMinutes * 60_000), offsetMinutes }));
};

/**
 * For a photo with a clock time and no zone: of the moments it could be, the proposal whose history place is nearest
 * in time and really is in the zone that moment assumes. `around` reads the history's places either side of a moment.
 */
export const proposeForLocalTime = async (
  local: Date,
  nearby: FillPoint[],
  zones: ZoneLookup,
  maxGapSeconds: number,
  around: (at: Date) => Promise<{ before: FillPoint | null; after: FillPoint | null }>,
): Promise<FillProposal | null> => {
  let best: FillProposal | null = null;
  for (const { at, offsetMinutes } of candidateInstants(local, nearby, zones)) {
    const { before, after } = await around(at);
    const proposal = proposeLocation(at, before, after, maxGapSeconds);
    if (!proposal || (best && best.gapSeconds <= proposal.gapSeconds)) {
      continue;
    }
    // the place the proposal rests on must keep the clock this moment assumes: a photo taken at 09:00 somewhere is
    // not placed by where its owner was at 09:00 UTC unless that place is on UTC
    const used = [before, after].filter(
      (point): point is FillPoint => !!point && Math.abs(seconds(point.recordedAt, at)) <= maxGapSeconds,
    );
    if (used.every((point) => zones.offsetMinutes(point) === offsetMinutes)) {
      best = proposal;
    }
  }
  return best;
};
