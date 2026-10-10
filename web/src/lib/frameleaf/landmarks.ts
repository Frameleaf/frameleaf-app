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
  city: string | null;
  state: string | null;
  country: string | null;
}

/** Cards for the visited landmarks, in the order the server lists them: most photographed first. */
export const buildLandmarkCards = (landmarks: SearchLandmarkResponseDto[], limit = Infinity): LandmarkCard[] =>
  landmarks.slice(0, limit).map((landmark) => ({
    id: landmark.id,
    label: landmark.name,
    kind: landmark.kind,
    icon: landmark.icon,
    count: landmark.assetCount,
    href: landmarkHref(landmark.id),
    coverAssetId: landmark.coverAssetId,
    firstDay: landmark.firstTakenAt.slice(0, 10),
    lastDay: landmark.lastTakenAt.slice(0, 10),
    city: landmark.city,
    state: landmark.state,
    country: landmark.country,
  }));
