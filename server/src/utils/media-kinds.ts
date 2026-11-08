import { AssetType } from 'src/enum.js';

/**
 * FL-1284: the special kinds of photo and video a camera app records, read from the file's own metadata so
 * every source (phone app upload, iCloud Photos sync, folder import, Google Takeout) gets the same answer.
 * Stored on `asset_exif.mediaKinds`; the API returns them as plain strings (never a response enum), so a
 * kind added later never breaks a strictly decoding native app.
 */
export const MEDIA_KINDS = [
  'slow-motion',
  'time-lapse',
  'panorama',
  'spherical',
  'burst',
  'portrait',
  'selfie',
  'screenshot',
  'screen-recording',
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Tags read as numbers rather than exiftool's printed labels, so the checks below compare codes. */
export const MEDIA_KIND_NUMERIC_TAGS = ['CustomRendered', 'AndroidCaptureFPS', 'FullFrameRatePlaybackIntent'] as const;

/** Video slower than this many frames a second is never treated as a slow-motion capture. */
const SLOW_MOTION_MIN_FPS = 100;
/** Longest side ÷ shortest side at or above which a still with no other signal reads as a panorama. */
const PANORAMA_MIN_ASPECT = 3;

// Android, macOS, Windows and the common localised screenshot names (FL-349 matches the same names).
const SCREENSHOT_NAME =
  /screen[ _-]?shot|screen[ _-]?capture|bildschirmfoto|captura de pantalla|capture d.[ée]cran|schermafbeelding|schermata|スクリーンショット|屏幕截图|截屏|스크린샷/i;
const SCREEN_RECORDING_NAME = /screen[ _-]?record|bildschirmaufnahme|grabación de pantalla|enregistrement de l.écran/i;

type Tags = Record<string, unknown>;

export type MediaKindInput = {
  type: AssetType;
  originalFileName: string;
  /** Pixel size as stored, before orientation; the panorama check only compares the two sides. */
  width?: number | null;
  height?: number | null;
  /** Frames a second of the main video stream, when probed. */
  fps?: number | null;
  /** `asset_exif.projectionType`, upper-cased. */
  projectionType?: string | null;
};

const numberOf = (value: unknown): number | null => {
  const first = Array.isArray(value) ? value[0] : value;
  const parsed = typeof first === 'string' && first.trim() ? Number(first) : first;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};
const textOf = (value: unknown): string => {
  const first = Array.isArray(value) ? value.join(' ') : value;
  return typeof first === 'string' || typeof first === 'number' ? String(first).trim() : '';
};

/**
 * The kinds the file's metadata shows, in `MEDIA_KINDS` order. Each signal is one a camera app writes on
 * purpose; nothing is inferred from how the picture looks.
 */
export const detectMediaKinds = (tags: Tags, input: MediaKindInput): MediaKind[] => {
  const kinds = new Set<MediaKind>();
  const isImage = input.type === AssetType.Image;
  const isVideo = input.type === AssetType.Video;
  const fileName = input.originalFileName;
  const projection = (input.projectionType ?? textOf(tags.ProjectionType)).toUpperCase();
  // Google Camera and Pixel write the capture mode as a "special type"
  const specialType = textOf(tags.SpecialTypeID).toUpperCase();
  // EXIF CustomRendered as iPhone writes it: 6 panorama, 7 portrait with HDR, 8 portrait
  const customRendered = numberOf(tags.CustomRendered);

  if (isVideo) {
    const fps = numberOf(input.fps);
    // Android records the capture rate (com.android.capture.fps) beside a slower or faster playback rate
    const captureFps = numberOf(tags.AndroidCaptureFPS);
    // iPhone marks high-frame-rate clips meant to play in real time (Action, 4K120) with intent 1; a
    // slow-motion capture has intent 0 or no tag at all
    const playbackIntent = numberOf(tags.FullFrameRatePlaybackIntent);
    if (captureFps !== null && fps !== null && fps > 0) {
      if (captureFps >= fps * 1.5) {
        kinds.add('slow-motion');
      } else if (captureFps > 0 && captureFps <= fps / 1.5) {
        kinds.add('time-lapse');
      }
    } else if (fps !== null && fps >= SLOW_MOTION_MIN_FPS && playbackIntent !== 1) {
      kinds.add('slow-motion');
    }
    if (SCREEN_RECORDING_NAME.test(fileName)) {
      kinds.add('screen-recording');
    }
  }

  if (projection === 'EQUIRECTANGULAR' || /\.(insp)$/i.test(fileName)) {
    kinds.add('spherical');
  } else if (isImage) {
    const width = numberOf(input.width);
    const height = numberOf(input.height);
    const wide =
      width !== null && height !== null && width > 0 && height > 0
        ? Math.max(width, height) / Math.min(width, height) >= PANORAMA_MIN_ASPECT
        : false;
    if (customRendered === 6 || projection === 'CYLINDRICAL' || specialType.includes('PANORAMA') || wide) {
      kinds.add('panorama');
    }
  }

  if (isImage) {
    // Apple BurstUUID, Google BurstID, Samsung's camera burst id
    if (textOf(tags.BurstUUID) || textOf(tags.BurstID) || textOf(tags.CameraBurstID)) {
      kinds.add('burst');
    }
    if (customRendered === 7 || customRendered === 8 || specialType.includes('PORTRAIT')) {
      kinds.add('portrait');
    }
    // iOS and macOS write "Screenshot" in the user comment of every screenshot they save
    if (/^screenshot$/i.test(textOf(tags.UserComment)) || SCREENSHOT_NAME.test(fileName)) {
      kinds.add('screenshot');
    }
  }

  // iPhone and many Android phones name the front lens ("iPhone 15 front camera 2.69mm f/1.9")
  if (/\bfront\b/i.test(textOf(tags.LensModel)) && !kinds.has('screenshot')) {
    kinds.add('selfie');
  }

  return MEDIA_KINDS.filter((kind) => kinds.has(kind));
};

/** True for a value `MEDIA_KINDS` lists; used to drop anything else read back from storage. */
export const isMediaKind = (value: unknown): value is MediaKind => MEDIA_KINDS.includes(value as MediaKind);
