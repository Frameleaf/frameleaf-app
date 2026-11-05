/**
 * FL-1196 (2026-11-04): more of what a camera records, for the library's own use (analytics today).
 * The metadata scan reads these tags numerically where they are numbers (see `CAPTURE_NUMERIC_TAGS`).
 */
export const CAPTURE_NUMERIC_TAGS = [
  'GPSAltitude',
  'GPSAltitudeRef',
  'GPSImgDirection',
  'GPSSpeed',
  'FocalLengthIn35mmFormat',
  'ExposureCompensation',
  'FocusDistance',
  'ShutterCount',
  'ShutterCount2',
  'ShutterCount3',
  'MechanicalShutterCount',
  'ImageCount',
] as const;

export type CaptureDetails = {
  altitude: number | null;
  shutterCount: number | null;
  focalLengthIn35mm: number | null;
  exposureCompensation: number | null;
  exposureProgram: string | null;
  meteringMode: string | null;
  flash: string | null;
  whiteBalance: string | null;
  sceneCaptureType: string | null;
  focusDistance: number | null;
  lensMake: string | null;
  lensSerialNumber: string | null;
  serialNumber: string | null;
  software: string | null;
  artist: string | null;
  copyright: string | null;
  imageDirection: number | null;
  gpsSpeed: number | null;
};

type Tags = Record<string, unknown>;

const number = (value: unknown, min: number, max: number) => {
  const parsed = Array.isArray(value) ? Number(value[0]) : typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

const text = (value: unknown, max = 200) => {
  const joined = Array.isArray(value) ? value.join(', ') : value;
  if (typeof joined !== 'string' && typeof joined !== 'number') {
    return null;
  }
  const trimmed = String(joined).trim();
  return trimmed && trimmed.toLowerCase() !== 'unknown' ? trimmed.slice(0, max) : null;
};

/** Metres above sea level, negative below it; exiftool signs the composite, but older files carry the ref alone. */
const altitude = (tags: Tags) => {
  const value = number(tags.GPSAltitude, -12_000, 100_000);
  if (value === null) {
    return null;
  }
  const ref = tags.GPSAltitudeRef;
  const below = ref === 1 || ref === '1' || (typeof ref === 'string' && /below/i.test(ref));
  return below && value > 0 ? -value : value;
};

/** Shutter actuations, under the tag each maker uses; Fujifilm's ImageCount counts the same thing. */
const shutterCount = (tags: Tags) => {
  for (const name of ['ShutterCount', 'MechanicalShutterCount', 'ShutterCount2', 'ShutterCount3']) {
    const value = number(tags[name], 1, 10_000_000);
    if (value !== null) {
      return Math.round(value);
    }
  }
  const make = typeof tags.Make === 'string' ? tags.Make : '';
  const fujifilm = number(tags.ImageCount, 1, 10_000_000);
  return /fujifilm/i.test(make) && fujifilm !== null ? Math.round(fujifilm) : null;
};

/** km/h, from the speed and its unit (K km/h, M mph, N knots). */
const gpsSpeed = (tags: Tags) => {
  const value = number(tags.GPSSpeed, 0, 5000);
  if (value === null) {
    return null;
  }
  const ref = String(tags.GPSSpeedRef ?? 'K')
    .charAt(0)
    .toUpperCase();
  return ref === 'M' ? value * 1.609344 : ref === 'N' ? value * 1.852 : value;
};

export function captureDetails(tags: Tags): CaptureDetails {
  return {
    altitude: altitude(tags),
    shutterCount: shutterCount(tags),
    focalLengthIn35mm: number(tags.FocalLengthIn35mmFormat, 1, 10_000),
    exposureCompensation: number(tags.ExposureCompensation, -20, 20),
    exposureProgram: text(tags.ExposureProgram),
    meteringMode: text(tags.MeteringMode),
    flash: text(tags.Flash),
    whiteBalance: text(tags.WhiteBalance),
    sceneCaptureType: text(tags.SceneCaptureType),
    focusDistance: number(tags.FocusDistance, 0, 1_000_000),
    lensMake: text(tags.LensMake),
    lensSerialNumber: text(tags.LensSerialNumber, 100),
    serialNumber: text(tags.SerialNumber ?? tags.InternalSerialNumber ?? tags.BodySerialNumber, 100),
    software: text(tags.Software),
    artist: text(tags.Artist ?? tags.Creator),
    copyright: text(tags.Copyright ?? tags.Rights, 500),
    imageDirection: number(tags.GPSImgDirection, 0, 360),
    gpsSpeed: gpsSpeed(tags),
  };
}
