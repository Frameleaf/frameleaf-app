/**
 * FL-1092 / FL-1093 magic albums: describe the trip an album holds, then judge which other photos belong
 * to it. Pure functions; the repository supplies rows and the service decides what to show. Nothing here
 * writes anything: adding a photo or changing its date is always the person's choice (FL-1090 mock).
 */

import { withGoodDates } from 'src/utils/date-sanity.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A gap longer than this between album photos starts a new trip segment; a day without photos is still the trip. */
export const TRIP_GAP_MS = 48 * HOUR_MS;
/** Photos taken this long before the first or after the last album photo of a segment still count. */
export const TRIP_PADDING_MS = 12 * HOUR_MS;
/**
 * FL-1411: an album is a trip only when all its photos fit in three weeks. A catch-all album has busy weeks
 * too, and those are not trips; suggest nothing for it.
 */
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
/**
 * FL-1094: CLIP cosine distance between two torso crops of the same person wearing the same clothes.
 * Measured with ViT-B-16-SigLIP-384__webli on 1,407 CC-licensed Wikimania 2019/2023 photos of 118 people
 * (person from Commons categories, day from EXIF), each dated by the one-day rule against that person's
 * other photos: 0.10 dated 43% of datable photos at 97.4% precision; 0.12 dated 50% at 94.9%. Details in
 * PR 731. Measure again before changing the default CLIP model.
 */
export const SAME_OUTFIT_DISTANCE = 0.1;

export type TripPhoto = {
  id: string;
  takenAt: Date;
  localDateTime: Date;
  latitude: number | null;
  longitude: number | null;
  make: string | null;
  model: string | null;
  dateSetByHand?: boolean;
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
  | { kind: 'people'; names: string[] }
  | { kind: 'same-outfit'; names: string[]; assetId: string; date: string };

const cameraKey = (make: string | null, model: string | null) =>
  make?.trim() && model?.trim() ? `${make.trim()}\0${model.trim()}` : undefined;

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
  item.latitude !== null &&
  item.longitude !== null &&
  Number.isFinite(item.latitude) &&
  Number.isFinite(item.longitude);

/**
 * The album's trip: time segments split at long gaps, the places photographed, and the cameras used. Dates
 * that cannot be right (a camera's reset date, a date still to come) are left out before anything is measured,
 * so one of them neither makes a trip album look years long nor counts as part of the trip.
 */
export const describeTrip = (photos: TripPhoto[], now: Date = new Date()): Trip | undefined => {
  const sorted = withGoodDates(photos, now).sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  if (sorted.length === 0 || sorted.at(-1)!.takenAt.getTime() - sorted[0].takenAt.getTime() > TRIP_MAX_SPAN_MS) return;
  const groups: TripPhoto[][] = [];
  for (const photo of sorted) {
    const current = groups.at(-1);
    if (current && photo.takenAt.getTime() - current.at(-1)!.takenAt.getTime() <= TRIP_GAP_MS) current.push(photo);
    else groups.push([photo]);
  }
  const trips = groups.filter((group) => group.length >= TRIP_MIN_PHOTOS);
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
    points: points.filter((_, index) => index % step === 0).map(({ latitude, longitude }) => ({ latitude, longitude })),
    cameras: new Set(kept.map(({ make, model }) => cameraKey(make, model)).filter((key): key is string => !!key)),
    photoIds: kept.map(({ id }) => id),
  };
};

/** Evenly spaced picks, so a long trip is represented from start to end. */
export const sample = <T>(items: T[], count: number): T[] => {
  if (items.length <= count) return items;
  const step = items.length / count;
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * step)]);
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
  /** The album photo the date came from, for its offset; none when only "during the trip" is known. */
  datedBy?: { takenAt: Date; localDateTime: Date };
  reasons: SuggestionReason[];
};

/** The torso under a face: about three face heights down and three face widths across, clamped to the image. */
export const torsoBox = (
  face: { x1: number; y1: number; x2: number; y2: number },
  image: { width: number; height: number },
) => {
  const width = face.x2 - face.x1;
  const height = face.y2 - face.y1;
  if (width <= 0 || height <= 0) return;
  const left = Math.max(0, Math.round((face.x1 + face.x2) / 2 - 1.5 * width));
  const right = Math.min(image.width, Math.round((face.x1 + face.x2) / 2 + 1.5 * width));
  const top = Math.max(0, Math.round(face.y2));
  const bottom = Math.min(image.height, Math.round(face.y2 + 3 * height));
  // A face at the bottom edge leaves no clothes to compare.
  if (bottom - top < height || right - left < width) return;
  return { x: left, y: top, width: right - left, height: bottom - top };
};

export const cosineDistance = (a: number[], b: number[]) => {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    aa += a[index] * a[index];
    bb += b[index] * b[index];
  }
  return aa === 0 || bb === 0 ? Infinity : 1 - dot / Math.sqrt(aa * bb);
};

export type Outfit = { personId: string; name: string; embedding: number[] };
export type TripOutfit = Outfit & { assetId: string; takenAt: Date; localDateTime: Date };
export type OutfitMatch = { name: string; assetId: string; distance: number; takenAt: Date; localDateTime: Date };

/**
 * The one trip day someone in the photo wore the same clothes. Someone who wore them on several days of
 * the trip tells no day, so that is no match.
 */
export const matchOutfit = (outfits: Outfit[], trip: TripOutfit[]): OutfitMatch | undefined => {
  let best: OutfitMatch | undefined;
  for (const outfit of outfits) {
    const days = new Map<string, OutfitMatch>();
    for (const worn of trip) {
      if (worn.personId !== outfit.personId) continue;
      const distance = cosineDistance(outfit.embedding, worn.embedding);
      if (!(distance <= SAME_OUTFIT_DISTANCE)) continue;
      const day = localDay(worn.localDateTime);
      const seen = days.get(day);
      if (!seen || distance < seen.distance || (distance === seen.distance && worn.assetId < seen.assetId))
        days.set(day, { name: outfit.name, assetId: worn.assetId, distance, ...pick(worn) });
    }
    const [match, ...others] = days.values();
    if (match && others.length === 0 && (!best || match.distance < best.distance)) best = match;
  }
  return best;
};

const pick = ({ takenAt, localDateTime }: { takenAt: Date; localDateTime: Date }) => ({ takenAt, localDateTime });

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
    /** FL-1094: someone in it wears what they wore on one trip day. */
    outfit?: OutfitMatch;
  },
): DateEstimate | undefined => {
  const neighbours = [...candidate.neighbours]
    .filter(({ distance }) => Number.isFinite(distance) && distance <= LOOKS_LIKE_DISTANCE)
    .sort((a, b) => a.distance - b.distance || a.assetId.localeCompare(b.assetId));
  const best = neighbours[0];
  const scene = best && best.distance <= SAME_SCENE_DISTANCE ? best : undefined;
  // An outfit from another day than the scene it shows is no evidence for that date.
  const outfit =
    candidate.outfit && (!scene || localDay(scene.localDateTime) === localDay(candidate.outfit.localDateTime))
      ? candidate.outfit
      : undefined;
  // The trip segment of whatever dates it: a scene match, then an outfit, then the closest look-alike.
  const datedBy = scene ?? outfit ?? best;
  const segment = datedBy ? segmentAt(trip, datedBy.takenAt) : trip.segments[0];
  if (!segment) return;
  // It can't have been taken after it was saved or received: before a scene match, before its segment otherwise.
  const anchoredBy = scene ? scene.takenAt : segment.from;
  if (candidate.savedAt && candidate.savedAt < anchoredBy) return;

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
  if (outfit) {
    const { name, assetId, localDateTime } = outfit;
    reasons.push({ kind: 'same-outfit', names: [name], assetId, date: localDay(localDateTime) });
    signals += 1;
  }
  if (signals < 2) return;

  const wall = (date: Date, time: string) => `${localDay(date)}T${time}`;
  if (best && best.distance <= NEAR_IDENTICAL_DISTANCE)
    return {
      precision: 'moment',
      localDateTime: best.localDateTime.toISOString().slice(0, 19),
      datedBy: pick(best),
      reasons,
    };
  if (best && best.distance <= SAME_SCENE_DISTANCE)
    return { precision: 'day', localDateTime: wall(best.localDateTime, '12:00:00'), datedBy: pick(best), reasons };
  if (outfit)
    return { precision: 'day', localDateTime: wall(outfit.localDateTime, '12:00:00'), datedBy: pick(outfit), reasons };
  return { precision: 'trip', localDateTime: wall(segment.localStart, '12:00:00'), reasons };
};

/** `+HH:MM` for the offset between a photo's local wall time and its instant. */
export const utcOffset = (takenAt: Date, localDateTime: Date) => {
  const minutes = Math.round((localDateTime.getTime() - takenAt.getTime()) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
};

/**
 * FL-1299: how tight an album must be before it can vouch for a photo's date. Judgment calls, kept as named
 * constants to tune on real libraries.
 */
export const HEAL_MIN_DATED = 5;
export const HEAL_WINDOW_DAYS = 14;
export const HEAL_SHARE = 0.8;

export type HealPhoto = {
  id: string;
  fileName: string;
  takenAt: Date;
  localDateTime: Date;
  /** It has camera details and no saved-from-chat name, so `suspiciousDate` has no doubts about it. */
  camera: boolean;
  /** Healing set this date, so it says nothing about when the album's photos were taken. */
  estimated: boolean;
  /** Someone, or an earlier healing, set this date on purpose. It isn't lost. */
  dateSet: boolean;
  /** The viewer's own. Other members' photos are evidence, but are never changed. */
  mine: boolean;
};

export type HealSuggestion = {
  assetId: string;
  fileName: string;
  /** The local day it shows now. */
  shownDay: string;
  /** The local day offered. */
  day: string;
  /** Ready for an asset update: local time with offset. */
  dateTimeOriginal: string;
  precision: 'exact' | 'around';
  /** The two photos an exact date came from. */
  between: { before: string; after: string } | null;
};

export type HealResult = {
  eligible: boolean;
  reason?: 'few' | 'wide';
  from?: string;
  to?: string;
  suggestions: HealSuggestion[];
};

const serialDay = (localDateTime: Date) => Math.floor(localDateTime.getTime() / DAY_MS);

const sequenceOf = (name: string) => {
  const match = /^(.*?)(\d+)\.[a-z0-9]+$/i.exec(name);
  return match ? { stem: match[1].toLowerCase(), number: Number(match[2]) } : undefined;
};

const healedDate = ({ takenAt, localDateTime }: HealPhoto, time?: string) => {
  const wall = time ? `${localDay(localDateTime)}T${time}` : localDateTime.toISOString().slice(0, 19);
  return `${wall}${utcOffset(takenAt, localDateTime)}`;
};

/**
 * Photos whose date was lost, in an album that tells us when it was taken. Only a photo with no camera details
 * whose date sits more than a day outside the album's own stretch is offered, so a real throwback is left alone
 * and a ten-year album is skipped. Nothing is written here: a healed date is always the person's choice.
 */
export const healDates = (photos: HealPhoto[]): HealResult => {
  const dated = photos
    .filter(({ camera, estimated }) => camera && !estimated)
    .sort((a, b) => a.localDateTime.getTime() - b.localDateTime.getTime() || a.id.localeCompare(b.id));
  if (dated.length < HEAL_MIN_DATED) {
    return { eligible: false, reason: 'few', suggestions: [] };
  }

  const days = dated.map(({ localDateTime }) => serialDay(localDateTime));
  let best = [0, 0];
  for (let start = 0, end = 0; start < dated.length; start += 1) {
    while (end + 1 < dated.length && days[end + 1] - days[start] <= HEAL_WINDOW_DAYS) {
      end += 1;
    }
    if (end - start > best[1] - best[0]) {
      best = [start, end];
    }
  }
  const inWindow = dated.slice(best[0], best[1] + 1);
  if (inWindow.length / dated.length < HEAL_SHARE) {
    return { eligible: false, reason: 'wide', suggestions: [] };
  }

  const first = serialDay(inWindow[0].localDateTime);
  const last = serialDay(inWindow.at(-1)!.localDateTime);
  const middle = inWindow[inWindow.length >> 1];
  const families = new Map<string, (HealPhoto & { number: number })[]>();
  for (const item of inWindow) {
    const sequence = sequenceOf(item.fileName);
    if (sequence) {
      const family = families.get(sequence.stem) ?? [];
      family.push({ ...item, number: sequence.number });
      families.set(sequence.stem, family);
    }
  }
  const suggestions = photos
    .filter(({ camera, dateSet, mine, localDateTime }) => {
      const day = serialDay(localDateTime);
      return !camera && !dateSet && mine && (day < first - 1 || day > last + 1);
    })
    .map((photo): HealSuggestion => {
      const base = { assetId: photo.id, fileName: photo.fileName, shownDay: localDay(photo.localDateTime) };
      const place = sequenceOf(photo.fileName);
      const family = place ? (families.get(place.stem) ?? []) : [];
      const before = family.filter(({ number }) => number < place!.number).sort((a, b) => b.number - a.number)[0];
      const after = family.filter(({ number }) => number > place!.number).sort((a, b) => a.number - b.number)[0];
      if (before && after && Math.abs(serialDay(after.localDateTime) - serialDay(before.localDateTime)) <= 1) {
        const earlier = after.localDateTime < before.localDateTime ? after : before;
        return {
          ...base,
          day: localDay(earlier.localDateTime),
          dateTimeOriginal: healedDate(earlier),
          precision: 'exact',
          between: { before: before.fileName, after: after.fileName },
        };
      }
      return {
        ...base,
        day: localDay(middle.localDateTime),
        dateTimeOriginal: healedDate(middle, '12:00:00'),
        precision: 'around',
        between: null,
      };
    });
  return {
    eligible: true,
    from: localDay(inWindow[0].localDateTime),
    to: localDay(inWindow.at(-1)!.localDateTime),
    suggestions,
  };
};
