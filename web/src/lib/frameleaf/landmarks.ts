import { getBaseUrl, type LandmarkIconDto, type SearchLandmarkResponseDto } from '@frameleaf/sdk';
import {
  mdiBank,
  mdiBeach,
  mdiBridge,
  mdiCastle,
  mdiChessRook,
  mdiChurch,
  mdiEiffelTower,
  mdiFerrisWheel,
  mdiImageFilterHdr,
  mdiMapMarkerStar,
  mdiPaw,
  mdiPillar,
  mdiPineTree,
  mdiStadium,
  mdiTree,
} from '@mdi/js';
import type { Translations } from 'svelte-i18n';
import { Route } from '$lib/route';

/**
 * Landmarks and attractions (FL-350): the notable places photos were taken at, from the server's place
 * pack. A landmark is drawn with its own brand icon when the icon pack has one, and otherwise with the
 * icon for its kind.
 */
const KINDS: Record<string, { icon: string; labelKey: Translations }> = {
  theme_park: { icon: mdiFerrisWheel, labelKey: 'frameleaf_landmark_kind_theme_park' },
  zoo: { icon: mdiPaw, labelKey: 'frameleaf_landmark_kind_zoo' },
  resort: { icon: mdiBeach, labelKey: 'frameleaf_landmark_kind_resort' },
  national_park: { icon: mdiPineTree, labelKey: 'frameleaf_landmark_kind_national_park' },
  stadium: { icon: mdiStadium, labelKey: 'frameleaf_landmark_kind_stadium' },
  ancient_site: { icon: mdiPillar, labelKey: 'frameleaf_landmark_kind_ancient_site' },
  castle: { icon: mdiCastle, labelKey: 'frameleaf_landmark_kind_castle' },
  museum: { icon: mdiBank, labelKey: 'frameleaf_landmark_kind_museum' },
  religious: { icon: mdiChurch, labelKey: 'frameleaf_landmark_kind_religious' },
  tower: { icon: mdiEiffelTower, labelKey: 'frameleaf_landmark_kind_tower' },
  bridge: { icon: mdiBridge, labelKey: 'frameleaf_landmark_kind_bridge' },
  monument: { icon: mdiChessRook, labelKey: 'frameleaf_landmark_kind_monument' },
  natural: { icon: mdiImageFilterHdr, labelKey: 'frameleaf_landmark_kind_natural' },
  park: { icon: mdiTree, labelKey: 'frameleaf_landmark_kind_park' },
  landmark: { icon: mdiMapMarkerStar, labelKey: 'frameleaf_landmark_kind_landmark' },
};

/** The icon and name for a kind of place. A kind this build does not know reads as a plain landmark. */
export const landmarkKind = (kind: string) => KINDS[kind] ?? KINDS.landmark;

/** Everything taken at one landmark, as a search. */
export const landmarkHref = (id: string) => Route.search({ filter: { landmarkIds: { any: [id] } } });

/** A landmark's own brand icon. Only landmarks whose `icon` is present have one. */
export const landmarkIconUrl = (id: string) => `${getBaseUrl()}/search/landmarks/${id}/icon`;

export const EXPLORE_LANDMARK_LIMIT = 12;

export interface LandmarkCard {
  id: string;
  label: string;
  kind: string;
  icon?: LandmarkIconDto;
  count: number;
  href: string;
  coverAssetId: string;
  /** The local days of the first and latest item taken here, as `yyyy-MM-dd`. */
  firstDay: string;
  lastDay: string;
  latitude: number;
  longitude: number;
  city: string | null;
  state: string | null;
  country: string | null;
}

export type Resortable = { id: string; kind: string; latitude: number; longitude: number; radiusM: number };

const metresBetween = (a: Resortable, b: Resortable) => {
  const toRadians = Math.PI / 180;
  const x = (b.longitude - a.longitude) * toRadians * Math.cos(((a.latitude + b.latitude) / 2) * toRadians);
  const y = (b.latitude - a.latitude) * toRadians;
  return Math.hypot(x, y) * 6_371_000;
};

/**
 * The places that sit inside a visited resort, each with that resort's id. The resort stands for them in
 * a list, and on the map until it is close enough to tell them apart (`SPLIT_ZOOM` in `landmark-pins.ts`).
 */
export const resortMembers = (places: Resortable[]): Map<string, string> => {
  const resorts = places.filter(({ kind }) => kind === 'resort');
  const members = new Map<string, string>();
  for (const place of places) {
    const resort = place.kind === 'resort' ? undefined : resorts.find((r) => metresBetween(r, place) <= r.radiusM);
    if (resort) {
      members.set(place.id, resort.id);
    }
  }
  return members;
};

/** Places for a list: a resort stands for the places inside it, which only the close-up map tells apart. */
export const withoutResortMembers = <T extends Resortable>(places: T[]): T[] => {
  const members = resortMembers(places);
  return places.filter(({ id }) => !members.has(id));
};

/**
 * Cards for the visited landmarks, in the order the server lists them: most photographed first. A resort
 * stands for the places inside it.
 */
export const buildLandmarkCards = (landmarks: SearchLandmarkResponseDto[], limit = Infinity): LandmarkCard[] =>
  withoutResortMembers(landmarks)
    .slice(0, limit)
    .map((landmark) => ({
      id: landmark.id,
      label: landmark.name,
      kind: landmark.kind,
      icon: landmark.icon,
      count: landmark.assetCount,
      href: landmarkHref(landmark.id),
      coverAssetId: landmark.coverAssetId,
      firstDay: landmark.firstTakenAt.slice(0, 10),
      lastDay: landmark.lastTakenAt.slice(0, 10),
      latitude: landmark.latitude,
      longitude: landmark.longitude,
      city: landmark.city,
      state: landmark.state,
      country: landmark.country,
    }));

/**
 * The id of the Places state a landmark is filed under: where most of its photos were taken, so it sits
 * beside the towns those same photos are filed under (`buildPlacesTree` in `places.ts` makes the ids).
 */
export const landmarkStateId = (landmark: Pick<LandmarkCard, 'state' | 'country'>) =>
  `state:${landmark.country ?? ''}:${landmark.state ?? ''}`;
