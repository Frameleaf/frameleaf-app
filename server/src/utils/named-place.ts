/** FL-949: a person's named place as the matching reads it. */
export type NamedPlaceArea = { id: string; name: string; latitude: number; longitude: number; radiusMeters: number };

/** The sphere Postgres' earthdistance measures on, so a photo is inside a place here exactly when a search finds it. */
const EARTH_RADIUS_M = 6_378_168;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle metres between two points. */
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

/**
 * The named place a point is in: of the places whose circle holds it, the one whose centre is nearest (then the
 * smaller), so a "Garden" inside "Home" names the photos taken in the garden.
 */
export const namedPlaceAt = <T extends NamedPlaceArea>(
  places: readonly T[],
  point: { latitude: number | null | undefined; longitude: number | null | undefined },
): T | null => {
  const { latitude, longitude } = point;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return null;
  }
  let best: { place: T; distance: number } | null = null;
  for (const place of places) {
    const distance = distanceMeters(place, { latitude, longitude });
    if (distance > place.radiusMeters) {
      continue;
    }
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance &&
        (place.radiusMeters < best.place.radiusMeters ||
          (place.radiusMeters === best.place.radiusMeters && place.id < best.place.id)))
    ) {
      best = { place, distance };
    }
  }
  return best?.place ?? null;
};

/** FL-949: the share of a memory's located photos one named place must hold for the memory to carry its name. */
export const NAMED_PLACE_SHARE = 0.6;

/** The named place most of these points are in, when it holds at least `NAMED_PLACE_SHARE` of them all. */
export const dominantNamedPlace = <T extends NamedPlaceArea>(
  places: readonly T[],
  points: ReadonlyArray<{ latitude: number | null | undefined; longitude: number | null | undefined }>,
): T | null => {
  if (places.length === 0 || points.length === 0) {
    return null;
  }
  const counts = new Map<string, { place: T; count: number }>();
  for (const point of points) {
    const place = namedPlaceAt(places, point);
    if (place) {
      const entry = counts.get(place.id);
      if (entry) {
        entry.count++;
      } else {
        counts.set(place.id, { place, count: 1 });
      }
    }
  }
  let best: { place: T; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.place.id < best.place.id)) {
      best = entry;
    }
  }
  return best && best.count >= points.length * NAMED_PLACE_SHARE ? best.place : null;
};
