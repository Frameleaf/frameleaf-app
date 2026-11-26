import type { UserPlaceResponseDto } from '@frameleaf/sdk';

/**
 * FL-1019: what the named-place screens work out without the server: the radius slider's stops, how a
 * radius reads, how large a circle is on the map, and which place a click on the map is inside.
 * Mock: `src/location-history.mjs` and `src/NamedPlaces.jsx` in the prototype (FL-898).
 */

export const PLACE_NAME_MAX = 80;
export const PLACES_MAX = 200;
export const PLACE_RADIUS_DEFAULT = 250;

/** 25 m to 5 km, with even steps along the track feeling even on the map. */
export const RADIUS_STOPS = [25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000];
export const RADIUS_STEPS = RADIUS_STOPS.length - 1;

export const radiusAt = (step: number) => RADIUS_STOPS[Math.max(0, Math.min(RADIUS_STEPS, Math.round(step)))];

/** The nearest stop: a radius saved elsewhere need not be one of them. */
export const radiusStep = (meters: number) => {
  let best = 0;
  for (const [index, stop] of RADIUS_STOPS.entries()) {
    if (Math.abs(stop - meters) < Math.abs(RADIUS_STOPS[best] - meters)) {
      best = index;
    }
  }
  return best;
};

/** "500 m", "1.5 km", in the person's language. */
export const formatRadius = (meters: number, locale?: string) =>
  new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: meters < 1000 ? 'meter' : 'kilometer',
    maximumFractionDigits: 1,
  }).format(meters < 1000 ? meters : meters / 1000);

/** The sphere the server's matching measures on, so a circle holds what a search finds. */
const EARTH_RADIUS_M = 6_378_168;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

export const distanceMeters = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) => {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** A circle is never drawn smaller than this, so a small place can be seen with a whole trip on screen. */
export const MIN_CIRCLE_RADIUS_PX = 14;

/** MapLibre's world is 512px wide at zoom 0. */
const metersPerPixelAtZoomZero = (latitude: number) =>
  (2 * Math.PI * EARTH_RADIUS_M * Math.max(0.01, Math.cos(radians(latitude)))) / 512;

/** The circle's radius in pixels at zoom 0; the map multiplies it by 2^zoom in CSS, so a zoom redraws nothing. */
export const circleBasePx = (latitude: number, radiusMeters: number) =>
  radiusMeters / metersPerPixelAtZoomZero(latitude);

/** The place a point on the map is in: the nearest centre of those whose drawn circle holds it. */
export const placeAtPoint = <T extends Pick<UserPlaceResponseDto, 'latitude' | 'longitude' | 'radiusMeters'>>(
  places: readonly T[],
  point: { latitude: number; longitude: number },
  zoom: number,
): T | undefined => {
  let best: { place: T; distance: number } | undefined;
  for (const place of places) {
    const distance = distanceMeters(place, point);
    const minimum = (MIN_CIRCLE_RADIUS_PX * metersPerPixelAtZoomZero(place.latitude)) / 2 ** zoom;
    if (distance <= Math.max(place.radiusMeters, minimum) && (!best || distance < best.distance)) {
      best = { place, distance };
    }
  }
  return best?.place;
};

const foldName = (name: string) => name.trim().toLocaleLowerCase();

/** Names are unique per person, ignoring capitals. */
export const isPlaceNameTaken = (places: readonly { id: string; name: string }[], name: string, exceptId?: string) =>
  places.some((place) => place.id !== exceptId && foldName(place.name) === foldName(name));

/** The nearest known town within 50 km, to say where a place is ("Jasper, Alberta"). */
export const nearestTown = <T extends { latitude: number | null; longitude: number | null; label: string }>(
  towns: readonly T[],
  point: { latitude: number; longitude: number },
): string | undefined => {
  let best: { label: string; distance: number } | undefined;
  for (const { latitude, longitude, label } of towns) {
    if (latitude === null || longitude === null) {
      continue;
    }
    const distance = distanceMeters({ latitude, longitude }, point);
    if (distance <= 50_000 && (!best || distance < best.distance)) {
      best = { label, distance };
    }
  }
  return best?.label;
};
