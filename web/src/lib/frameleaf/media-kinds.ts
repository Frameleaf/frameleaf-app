import { AssetVisibility, MediaKind, type AssetResponseDto } from '@frameleaf/sdk';
import {
  mdiAccountBoxOutline,
  mdiCameraBurst,
  mdiCameraFrontVariant,
  mdiCellphoneScreenshot,
  mdiMotionPlayOutline,
  mdiPanorama,
  mdiPanoramaSphereOutline,
  mdiRecord,
  mdiTimelapse,
} from '@mdi/js';
import type { Translations } from 'svelte-i18n';
import { Route } from '$lib/route';

/**
 * FL-1284: the capture kinds the server reads from each file (`asset_exif.mediaKinds`), in the order
 * Explore and the filter list them. The API returns kinds as plain strings, so one this web build does
 * not know is ignored rather than shown unlabelled.
 */
export const MEDIA_KINDS: readonly {
  kind: MediaKind;
  icon: string;
  /** Plural, for Explore and the filter list. */
  labelKey: Translations;
  /** Singular, for the viewer's title. */
  viewerKey: Translations;
}[] = [
  {
    kind: MediaKind.SlowMotion,
    icon: mdiMotionPlayOutline,
    labelKey: 'frameleaf_media_kind_slow_motion',
    viewerKey: 'frameleaf_viewer_kind_slow_motion',
  },
  {
    kind: MediaKind.TimeLapse,
    icon: mdiTimelapse,
    labelKey: 'frameleaf_media_kind_time_lapse',
    viewerKey: 'frameleaf_viewer_kind_time_lapse',
  },
  {
    kind: MediaKind.Panorama,
    icon: mdiPanorama,
    labelKey: 'frameleaf_media_kind_panorama',
    viewerKey: 'frameleaf_viewer_kind_panorama',
  },
  {
    kind: MediaKind.Spherical,
    icon: mdiPanoramaSphereOutline,
    labelKey: 'frameleaf_media_kind_spherical',
    viewerKey: 'frameleaf_viewer_kind_spherical',
  },
  {
    kind: MediaKind.Burst,
    icon: mdiCameraBurst,
    labelKey: 'frameleaf_media_kind_burst',
    viewerKey: 'frameleaf_viewer_kind_burst',
  },
  {
    kind: MediaKind.Portrait,
    icon: mdiAccountBoxOutline,
    labelKey: 'frameleaf_media_kind_portrait',
    viewerKey: 'frameleaf_viewer_kind_portrait',
  },
  {
    kind: MediaKind.Selfie,
    icon: mdiCameraFrontVariant,
    labelKey: 'frameleaf_media_kind_selfie',
    viewerKey: 'frameleaf_viewer_kind_selfie',
  },
  {
    kind: MediaKind.Screenshot,
    icon: mdiCellphoneScreenshot,
    labelKey: 'frameleaf_media_kind_screenshot',
    viewerKey: 'frameleaf_viewer_kind_screenshot',
  },
  {
    kind: MediaKind.ScreenRecording,
    icon: mdiRecord,
    labelKey: 'frameleaf_media_kind_screen_recording',
    viewerKey: 'frameleaf_viewer_kind_screen_recording',
  },
];

const byKind = new Map(MEDIA_KINDS.map((entry) => [entry.kind as string, entry]));

export const mediaKindInfo = (kind: string) => byKind.get(kind);

/** The kinds an item has that this build can label, in `MEDIA_KINDS` order. */
export const knownMediaKinds = (asset: Pick<AssetResponseDto, 'exifInfo'>): MediaKind[] => {
  const kinds = new Set(asset.exifInfo?.mediaKinds ?? []);
  return MEDIA_KINDS.filter(({ kind }) => kinds.has(kind)).map(({ kind }) => kind);
};

export const hasMediaKind = (asset: Pick<AssetResponseDto, 'exifInfo'>, kind: MediaKind) =>
  asset.exifInfo?.mediaKinds?.includes(kind) ?? false;

/**
 * The search a kind opens. Explore counts kinds with Timeline visibility (as its other cards are
 * counted), so the search narrows to the Timeline too and the count on a card is what it opens.
 */
export const mediaKindSearchHref = (kind: MediaKind) =>
  Route.search({ filter: { mediaKinds: { any: [kind] }, visibility: { eq: AssetVisibility.Timeline } } });

/**
 * Slow-motion playback, the way the camera app plays an untouched slow-motion clip: real speed for the
 * opening and closing moments, slowed in between to the speed the clip was filmed at relative to 30 fps
 * (a 240 fps clip plays at 1/8), never slower than browsers allow. Apple keeps the exact ramp in the
 * Photos library rather than in the file, so these proportions are the camera app's defaults.
 */
export const SLOW_MOTION_RAMP = { start: 0.12, end: 0.88 } as const;
const MIN_PLAYBACK_RATE = 0.0625;

export const slowMotionRate = (fps: number | null | undefined) =>
  fps && fps > 30 ? Math.max(MIN_PLAYBACK_RATE, Math.min(1, 30 / fps)) : 1;

export const slowMotionRateAt = (currentTime: number, duration: number, fps: number | null | undefined) => {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 1;
  }
  const progress = currentTime / duration;
  return progress >= SLOW_MOTION_RAMP.start && progress < SLOW_MOTION_RAMP.end ? slowMotionRate(fps) : 1;
};
