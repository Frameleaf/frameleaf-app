/**
 * FL-1092 / FL-1093 magic albums: describe the trip an album holds, then judge which other photos belong
 * to it. Pure functions; the repository supplies rows and the service decides what to show. Nothing here
 * writes anything: adding a photo or changing its date is always the person's choice (FL-1090 mock).
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A gap longer than this between album photos starts a new trip segment; a day without photos is still the trip. */
export const TRIP_GAP_MS = 48 * HOUR_MS;
/** Photos taken this long before the first or after the last album photo of a segment still count. */
export const TRIP_PADDING_MS = 12 * HOUR_MS;
/** ponytail: a segment longer than three weeks is an everyday album, not a trip; suggest nothing for it. */
export const TRIP_MAX_SPAN_MS = 21 * DAY_MS;
export const TRIP_MIN_PHOTOS = 3;
/** A located photo within this distance of any located album photo is at the trip's places. */
export const TRIP_RADIUS_M = 25_000;
/** ponytail: O(candidates x points) distance checks; 300 sampled points keep that cheap. */
export const TRIP_MAX_POINTS = 300;

/** CLIP cosine distances (stored image embeddings of the same model). */
export const NEAR_IDENTICAL_DISTANCE = 0.06;
export const SAME_SCENE_DISTANCE = 0.15;
export const LOOKS_LIKE_DISTANCE = 0.25;

export type TripPhoto = {
  id: string;
  takenAt: Date;
  localDateTime: Date;
  latitude: number | null;
  longitude: number | null;
  make: string | null;
  model: string | null;
};

export type TripSegment = { start: Date; end: Date; from: Date; to: Date; localStart: Date; localEnd: Date };

export type Trip = {
  segments: TripSegment[];
  points: { latitude: number; longitude: number }[];
  cameras: Set<string>;
  photoIds: string[];
};

export type SuggestionReason =
  | { kind: 'during-trip'; date: string }
  | { kind: 'place'; place: string }
  | { kind: 'same-camera' }
  | { kind: 'looks-like' }
  | { kind: 'same-scene'; assetId: string; date: string }
  | { kind: 'near-identical'; assetId: string; date: string }
  | { kind: 'people'; names: string[] };

const cameraKey = (make: string | null, model: string | null) =>
  make?.trim() && model?.trim() ? `${make.trim()}\u0000${model.trim()}` : undefined;

/** The local calendar day of a `localDateTime` (stored as local wall time in UTC fields). */
export const localDay = (localDateTime: Date) => localDateTime.toISOString().slice(0, 10);

export const distanceM = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
  const radians = Math.PI / 180;
  const lat = Math.sin(((b.latitude - a.latitude) * radians) / 2);
  const lon = Math.sin(((b.longitude - a.longitude) * radians) / 2);
  return (
    2 *
    6_371_000 *
    Math.asin(
      Math.min(1, Math.sqrt(lat * lat + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * lon * lon)),
    )
  );
};

const located = <T extends { latitude: number | null; longitude: number | null }>(
  item: T,
): item is T & { latitude: number; longitude: number } =>
  item.latitude !== null && item.longitude !== null && Number.isFinite(item.latitude) && Number.isFinite(item.longitude);

/** The album's trip: time segments split at long gaps, the places photographed, and the cameras used. */
export const describeTrip = (photos: TripPhoto[]): Trip | undefined => {
  const sorted = [...photos].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  const groups: TripPhoto[][] = [];
  for (const photo of sorted) {
    const current = groups.at(-1);
    if (current && photo.takenAt.getTime() - current.at(-1)!.takenAt.getTime() <= TRIP_GAP_MS) current.push(photo);
    else groups.push([photo]);
  }
  const trips = groups.filter(
    (group) =>
      group.length >= TRIP_MIN_PHOTOS && group.at(-1)!.takenAt.getTime() - group[0].takenAt.getTime() <= TRIP_MAX_SPAN_MS,
  );
  if (trips.length === 0) return;
  const kept = trips.flat();
  const points = kept.filter((photo) => located(photo)) as (TripPhoto & { latitude: number; longitude: number })[];
  const step = Math.max(1, Math.ceil(points.length / TRIP_MAX_POINTS));
  return {
    segments: trips.map((group) => {
      const local = group.map(({ localDateTime }) => localDateTime.getTime());
      return {
        start: group[0].takenAt,
        end: group.at(-1)!.takenAt,
        from: new Date(group[0].takenAt.getTime() - TRIP_PADDING_MS),
        to: new Date(group.at(-1)!.takenAt.getTime() + TRIP_PADDING_MS),
        localStart: new Date(Math.min(...local)),
        localEnd: new Date(Math.max(...local)),
      };
    }),
    points: points
      .filter((_, index) => index % step === 0)
      .map(({ latitude, longitude }) => ({ latitude, longitude })),
    cameras: new Set(kept.map(({ make, model }) => cameraKey(make, model)).filter((key): key is string => !!key)),
    photoIds: kept.map(({ id }) => id),
  };
};

export const segmentAt = (trip: Trip, takenAt: Date) =>
  trip.segments.find(({ from, to }) => takenAt >= from && takenAt <= to);

export const isAtTripPlaces = (trip: Trip, point: { latitude: number; longitude: number }) =>
  trip.points.some((place) => distanceM(place, point) <= TRIP_RADIUS_M);

export type TripCandidate = {
  id: string;
  takenAt: Date;
  localDateTime: Date;
  latitude: number | null;
  longitude: number | null;
  /** Recorded city, or the inferred landmark's name when the photo has no recorded place. */
  place: string | null;
  make: string | null;
  model: string | null;
  /** Closest stored-embedding distance to an album photo, when one was compared. */
  visualDistance?: number;
};

export type TripMatch = { likely: boolean; reasons: SuggestionReason[] };

/**
 * Two signals, as for inferred landmarks (FL-358): taken during the trip, and either at its places
 * (very likely) or, without a location, on a trip camera or looking like the trip (possibly). A photo
 * taken during the trip somewhere else is not suggested.
 */
export const matchTripCandidate = (trip: Trip, candidate: TripCandidate): TripMatch | undefined => {
  if (!segmentAt(trip, candidate.takenAt)) return;
  const during: SuggestionReason = { kind: 'during-trip', date: localDay(candidate.localDateTime) };
  if (located(candidate)) {
    if (trip.points.length === 0 || !isAtTripPlaces(trip, candidate)) return;
    return {
      likely: true,
      reasons: [during, ...(candidate.place ? [{ kind: 'place', place: candidate.place } as const] : [])],
    };
  }
  const reasons: SuggestionReason[] = [during];
  const camera = cameraKey(candidate.make, candidate.model);
  if (camera && trip.cameras.has(camera)) reasons.push({ kind: 'same-camera' });
  if (candidate.visualDistance !== undefined && candidate.visualDistance <= LOOKS_LIKE_DISTANCE)
    reasons.push({ kind: 'looks-like' });
  return reasons.length >= 2 ? { likely: false, reasons } : undefined;
};

export type DateSource = 'facebook' | 'whatsapp' | 'messenger' | 'none';

/**
 * Why a photo's date can't be trusted: the file carries no capture date, or its name shows it was
 * saved from Facebook or received on WhatsApp/Messenger, so its date is when it arrived. `savedAt` is
 * the arrival the name records; the photo was taken before it.
 */
export const suspiciousDate = (
  originalFileName: string,
  hasCaptureDate: boolean,
): { source: DateSource; savedAt?: Date } | undefined => {
  const facebook = /^FB_IMG_(\d{13})/i.exec(originalFileName);
  if (facebook) return { source: 'facebook', savedAt: new Date(Number(facebook[1])) };
  const whatsapp = /^(?:IMG|VID)-(\d{4})(\d{2})(\d{2})-WA\d+/i.exec(originalFileName);
  if (whatsapp) {
    const savedAt = new Date(Date.UTC(Number(whatsapp[1]), Number(whatsapp[2]) - 1, Number(whatsapp[3]), 23, 59, 59));
    return Number.isNaN(savedAt.getTime()) ? { source: 'whatsapp' } : { source: 'whatsapp', savedAt };
  }
  if (/^received_\d+/i.test(originalFileName)) return { source: 'messenger' };
  return hasCaptureDate ? undefined : { source: 'none' };
};

export type VisualNeighbour = { assetId: string; distance: number; takenAt: Date; localDateTime: Date };
export type DatePrecision = 'moment' | 'day' | 'trip';
export type DateEstimate = {
  precision: DatePrecision;
  /** Local wall time to set, as `YYYY-MM-DDTHH:mm:ss`; the caller adds the trip's offset. */
  localDateTime: string;
  reasons: SuggestionReason[];
};

/**
 * An undated photo belongs to the trip when two independent signals agree: what it shows (its closest
 * album photos), who is in it, and where it was taken. Two different album photos it is nearly
 * identical to count as two. The date follows the strongest visual match; without one closer than a
 * scene, only "during the trip" is offered.
 */
export const estimateDate = (
  trip: Trip,
  candidate: {
    neighbours: VisualNeighbour[];
    people: string[];
    place: string | null;
    savedAt?: Date;
  },
): DateEstimate | undefined => {
  const neighbours = [...candidate.neighbours]
    .filter(({ distance }) => Number.isFinite(distance) && distance <= LOOKS_LIKE_DISTANCE)
    .sort((a, b) => a.distance - b.distance || a.assetId.localeCompare(b.assetId));
  const best = neighbours[0];
  const segment = best ? segmentAt(trip, best.takenAt) : trip.segments[0];
  if (!segment) return;
  // It can't have been taken after it was saved or received.
  if (candidate.savedAt && candidate.savedAt < segment.from) return;

  const reasons: SuggestionReason[] = [];
  let signals = 0;
  const identical = neighbours.filter(({ distance }) => distance <= NEAR_IDENTICAL_DISTANCE);
  if (best && best.distance <= NEAR_IDENTICAL_DISTANCE) {
    reasons.push({ kind: 'near-identical', assetId: best.assetId, date: localDay(best.localDateTime) });
    signals += Math.min(2, identical.length);
  } else if (best && best.distance <= SAME_SCENE_DISTANCE) {
    reasons.push({ kind: 'same-scene', assetId: best.assetId, date: localDay(best.localDateTime) });
    signals += 1;
  } else if (best) {
    reasons.push({ kind: 'looks-like' });
    signals += 1;
  }
  if (candidate.people.length > 0) {
    reasons.push({ kind: 'people', names: candidate.people });
    signals += 1;
  }
  if (candidate.place) {
    reasons.push({ kind: 'place', place: candidate.place });
    signals += 1;
  }
  if (signals < 2) return;

  const wall = (date: Date, time: string) => `${localDay(date)}T${time}`;
  if (best && best.distance <= NEAR_IDENTICAL_DISTANCE)
    return { precision: 'moment', localDateTime: best.localDateTime.toISOString().slice(0, 19), reasons };
  if (best && best.distance <= SAME_SCENE_DISTANCE)
    return { precision: 'day', localDateTime: wall(best.localDateTime, '12:00:00'), reasons };
  return { precision: 'trip', localDateTime: wall(segment.localStart, '12:00:00'), reasons };
};

/** `+HH:MM` for the offset between a photo's local wall time and its instant. */
export const utcOffset = (takenAt: Date, localDateTime: Date) => {
  const minutes = Math.round((localDateTime.getTime() - takenAt.getTime()) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
};
