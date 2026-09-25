import type { ExifResponseDto, UpdateAssetDto } from '@immich/sdk';
import { validCoordinate } from '$lib/frameleaf/info-panel';

/**
 * The "Edit location" dialog's rules (audit V-24, `LocationDialog` in MediaViewer.jsx:3591-3693): what
 * the fields start with, and what a save sends. Pure, so the rules can be tested without the map.
 */
export interface LocationDraft {
  city: string;
  state: string;
  country: string;
  latitude: string;
  longitude: string;
}

export const locationDraft = (exif: ExifResponseDto | undefined | null): LocationDraft => {
  const lat = validCoordinate(exif?.latitude, 90);
  const lon = validCoordinate(exif?.longitude, 180);
  const located = lat !== null && lon !== null;
  return {
    city: exif?.city ?? '',
    state: exif?.state ?? '',
    country: exif?.country ?? '',
    latitude: located ? String(lat) : '',
    longitude: located ? String(lon) : '',
  };
};

/** A typed coordinate as decimal degrees inside the axis limit (a decimal comma is read too), or null. */
export const parseCoordinate = (value: string, limit: number) =>
  value.trim() === '' ? null : validCoordinate(Number(value.trim().replace(',', '.')), limit);

/**
 * The change a save sends: the coordinates when they moved, and each place name the owner changed (an
 * emptied one clears it). `null` when nothing changed. `'invalid'` while a coordinate is not a decimal
 * degree, only one is given, or both are emptied on an item that has a location, which the server
 * cannot remove.
 */
export function locationPatch(
  initial: LocationDraft,
  draft: LocationDraft,
): Pick<UpdateAssetDto, 'latitude' | 'longitude' | 'city' | 'state' | 'country'> | 'invalid' | null {
  const latEmpty = draft.latitude.trim() === '';
  const lonEmpty = draft.longitude.trim() === '';
  const lat = parseCoordinate(draft.latitude, 90);
  const lon = parseCoordinate(draft.longitude, 180);

  if (latEmpty && lonEmpty) {
    if (initial.latitude !== '') {
      return 'invalid';
    }
  } else if (lat === null || lon === null) {
    return 'invalid';
  }

  const patch: Pick<UpdateAssetDto, 'latitude' | 'longitude' | 'city' | 'state' | 'country'> = {};
  if (
    lat !== null &&
    lon !== null &&
    (lat !== parseCoordinate(initial.latitude, 90) || lon !== parseCoordinate(initial.longitude, 180))
  ) {
    patch.latitude = lat;
    patch.longitude = lon;
  }
  for (const field of ['city', 'state', 'country'] as const) {
    const value = draft[field].trim();
    if (value !== initial[field].trim()) {
      patch[field] = value === '' ? null : value;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
