import type { PlacesResponseDto, SearchLandmarkResponseDto, UserPlaceResponseDto } from '@frameleaf/sdk';
import { toMapArea, type MapArea } from '$lib/frameleaf/map-settings';
import { circleBasePx } from '$lib/frameleaf/named-places';

/**
 * FL-1027: what the map's search box finds, from the server's own data only: the person's places and
 * the landmarks they have photos at (both already on the map, so filtered here), and the towns
 * `GET /search/places` answers with, in the person's language when there is a translation.
 */
export type MapSearchGroup = 'yours' | 'landmarks' | 'cities';

export interface MapSearchRow {
  id: string;
  group: MapSearchGroup;
  name: string;
  /** The line under the name. A named place has none of its own. */
  where?: string;
  latitude: number;
  longitude: number;
  /** How close the map comes when it flies here. */
  zoom: number;
  /** How far "Show photos here" reaches from the centre. */
  radiusMeters: number;
  /** The server's count, where it has one (a landmark). */
  count?: number;
  /** A landmark's kind, for its icon. */
  kind?: string;
}

export const MAP_SEARCH_DEBOUNCE_MS = 250;
/** Each group shows up to four rows. */
export const MAP_SEARCH_GROUP_ROWS = 4;

const CITY_ZOOM = 11;
const CITY_RADIUS_M = 15_000;
const LANDMARK_MIN_RADIUS_M = 250;
const CLOSEST_ZOOM = 16;
const WIDEST_PLACE_ZOOM = 9;
/** A place's radius takes up about this many pixels when the map arrives. */
const ARRIVAL_RADIUS_PX = 120;
const METERS_PER_DEGREE_LATITUDE = 111_320;

/** Case and accents do not matter: "munchen" finds München. Kana keep their marks. */
export const foldPlaceName = (value: string) => value.normalize('NFD').replaceAll(/[̀-ͯ]/g, '').toLowerCase().trim();

/** The zoom at which a circle of this radius fills about the same part of the map, wherever it is. */
export const zoomForRadius = (latitude: number, radiusMeters: number) => {
  const zoom = Math.log2(ARRIVAL_RADIUS_PX / circleBasePx(latitude, Math.max(1, radiusMeters)));
  return Math.min(CLOSEST_ZOOM, Math.max(WIDEST_PLACE_ZOOM, zoom));
};

/** Names that start with the query come first; otherwise the order they arrived in stands. */
const matching = <T extends { name: string }>(items: readonly T[], query: string) => {
  const folded = foldPlaceName(query);
  const starts: T[] = [];
  const contains: T[] = [];
  for (const item of items) {
    const name = foldPlaceName(item.name);
    if (name.startsWith(folded)) {
      starts.push(item);
    } else if (name.includes(folded)) {
      contains.push(item);
    }
  }
  return [...starts, ...contains];
};

const yourPlaceRow = (place: UserPlaceResponseDto): MapSearchRow => ({
  id: `yours:${place.id}`,
  group: 'yours',
  name: place.name,
  latitude: place.latitude,
  longitude: place.longitude,
  zoom: zoomForRadius(place.latitude, place.radiusMeters),
  radiusMeters: place.radiusMeters,
});

/** Every place, for the box when it is focused and empty. */
export const allYourPlaceRows = (places: readonly UserPlaceResponseDto[]) => places.map((place) => yourPlaceRow(place));

export const yourPlaceRows = (places: readonly UserPlaceResponseDto[], query: string) =>
  matching(places, query)
    .slice(0, MAP_SEARCH_GROUP_ROWS)
    .map((place) => yourPlaceRow(place));

export const landmarkRows = (landmarks: readonly SearchLandmarkResponseDto[], query: string) =>
  matching(landmarks, query)
    .slice(0, MAP_SEARCH_GROUP_ROWS)
    .map((landmark): MapSearchRow => ({
      id: `landmark:${landmark.id}`,
      group: 'landmarks',
      name: landmark.name,
      where: [landmark.city ?? landmark.state, landmark.country].filter(Boolean).join(', ') || undefined,
      latitude: landmark.latitude,
      longitude: landmark.longitude,
      zoom: zoomForRadius(landmark.latitude, Math.max(LANDMARK_MIN_RADIUS_M, landmark.radiusM)),
      radiusMeters: Math.max(LANDMARK_MIN_RADIUS_M, landmark.radiusM),
      count: landmark.assetCount,
      kind: landmark.kind,
    }));

/** The server's towns, named in the person's language where it can; the English name otherwise. */
export const cityRows = (places: readonly PlacesResponseDto[]) => {
  const rows = new Map<string, MapSearchRow>();
  for (const place of places) {
    if (rows.size === MAP_SEARCH_GROUP_ROWS) {
      break;
    }
    const localized = place.placeNamesLocalized;
    const name = localized?.city || place.name;
    const where = [localized?.state || place.admin1name, localized?.country].filter(Boolean).join(', ') || undefined;
    const id = `city:${name}|${where ?? ''}`;
    if (!rows.has(id)) {
      rows.set(id, {
        id,
        group: 'cities',
        name,
        where,
        latitude: place.latitude,
        longitude: place.longitude,
        zoom: CITY_ZOOM,
        radiusMeters: CITY_RADIUS_M,
      });
    }
  }
  return [...rows.values()];
};

/** The language the server named these towns in, when it translated any. */
export const cityNamesLanguage = (places: readonly PlacesResponseDto[]) =>
  places.find((place) => place.placeNamesLocalized)?.placeNamesLocalized?.lang;

/** The area "Show photos here" opens, across the date line too. */
export const mapSearchRowArea = ({ latitude, longitude, radiusMeters }: MapSearchRow): MapArea => {
  const latitudeReach = radiusMeters / METERS_PER_DEGREE_LATITUDE;
  const longitudeReach = latitudeReach / Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
  return toMapArea({
    getWest: () => longitude - longitudeReach,
    getEast: () => longitude + longitudeReach,
    getSouth: () => latitude - latitudeReach,
    getNorth: () => latitude + latitudeReach,
  });
};
