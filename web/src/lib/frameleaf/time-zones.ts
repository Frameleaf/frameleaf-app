import { DateTime } from 'luxon';

/**
 * Friendly time-zone choices for the Change date dialog (FL-32, T-19).
 *
 * The prototype's `ChangeDateDialog` (`SelectionBar.jsx` `TIMEZONES`) names zones the way people do
 * — "Vancouver (Pacific)", "London" — rather than as raw IANA ids. Production offers every zone the
 * browser knows, so the label is built from the zone itself: the city, the region's generic name
 * and the offset on the date being set, e.g. "Vancouver (Pacific Time · UTC−07:00)". The IANA id
 * stays the value sent to the server.
 */
export type TimeZoneChoice = {
  /** The IANA zone, sent as the bulk update's `timeZone`. */
  value: string;
  label: string;
  offsetMinutes: number;
};

const supportedZones = (): string[] => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

/** "UTC+05:30", "UTC−07:00" (a real minus sign), or "UTC" at zero. */
export const formatUtcOffset = (minutes: number): string => {
  if (minutes === 0) {
    return 'UTC';
  }
  const sign = minutes > 0 ? '+' : '−';
  const whole = Math.abs(minutes);
  const hours = String(Math.floor(whole / 60)).padStart(2, '0');
  const rest = String(whole % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${rest}`;
};

/** The last part of an IANA id, as a place name: "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export const timeZoneCity = (zone: string): string => (zone.split('/').at(-1) ?? zone).replaceAll('_', ' ');

const genericName = (zone: string, at: Date, locale?: string): string | undefined => {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(at)
      .find((item) => item.type === 'timeZoneName')?.value;
    // A bare "GMT+5" says nothing the offset does not already say.
    return part && !/^(GMT|UTC)([+−-]|$)/.test(part) ? part : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A zone's label and offset for a wall time (`yyyy-MM-ddTHH:mm`) on that zone's own clock, so a date
 * across a daylight-saving change reads the offset that date really has there.
 */
export const timeZoneLabel = (
  zone: string,
  wallTime: string,
  locale?: string,
): { label: string; offsetMinutes: number } => {
  const local = DateTime.fromISO(wallTime, { zone });
  const moment = local.isValid ? local : DateTime.now().setZone(zone);
  const offsetMinutes = moment.offset;
  const at = moment.toJSDate();
  if (zone === 'UTC') {
    return { label: 'UTC', offsetMinutes: 0 };
  }
  const offset = formatUtcOffset(offsetMinutes);
  const generic = genericName(zone, at, locale);
  return { label: `${timeZoneCity(zone)} (${generic ? `${generic} · ${offset}` : offset})`, offsetMinutes };
};

/**
 * Every zone as a friendly choice, ordered west to east and then by name, with UTC first as in the
 * prototype. `wallTime` is the date and time being set, so each zone's offset is the one that wall
 * time has there (daylight saving included).
 */
export const timeZoneChoices = ({
  wallTime = DateTime.now().toFormat("yyyy-MM-dd'T'HH:mm"),
  locale,
  zones = supportedZones(),
}: { wallTime?: string; locale?: string; zones?: readonly string[] } = {}): TimeZoneChoice[] => {
  const seen = new Set<string>();
  const choices: TimeZoneChoice[] = [];
  for (const zone of zones) {
    // `Etc/GMT+5` style ids are offsets, not places, and read backwards (POSIX signs).
    if (seen.has(zone) || zone === 'UTC' || zone.startsWith('Etc/') || !zone.includes('/')) {
      continue;
    }
    seen.add(zone);
    choices.push({ value: zone, ...timeZoneLabel(zone, wallTime, locale) });
  }
  choices.sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.label.localeCompare(b.label, locale));
  return [{ value: 'UTC', label: 'UTC', offsetMinutes: 0 }, ...choices];
};

/** A date-time field's value as the dialog pre-fills it: `yyyy-MM-dd` and `HH:mm`. */
export const splitLocalDateTime = (value: string | undefined): { date: string; time: string } | null => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value ?? '');
  return match ? { date: match[1], time: match[2] } : null;
};

/** The browser's own zone. */
export const browserTimeZone = (): string => {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/**
 * A zone for an item known only by its UTC offset (the timeline carries offsets, not zone names):
 * the browser's own zone when it has that offset then, else the first place listed with it, else
 * UTC. Upstream's date dialog guesses the same way (`getPreferredTimeZone`).
 */
export const zoneForOffset = (
  choices: readonly TimeZoneChoice[],
  offsetMinutes: number,
  preferred = browserTimeZone(),
) =>
  choices.find((choice) => choice.value === preferred && choice.offsetMinutes === offsetMinutes) ??
  choices.find((choice) => choice.offsetMinutes === offsetMinutes && choice.value !== 'UTC') ??
  choices.find((choice) => choice.value === 'UTC');

/** A wall time in a zone as ISO with that zone's offset then: `2024-12-11T18:42:00-08:00`. */
export const wallTimeInZone = (wallTime: string, zone: string): string | null => {
  const local = DateTime.fromISO(wallTime, { zone });
  return local.isValid ? local.toISO({ suppressMilliseconds: true, includeOffset: true }) : null;
};

/**
 * An item's real capture time (FL-32 review N1/N3): its wall time, its UTC offset then, and its
 * IANA zone where its metadata names one. The timeline's own dates are not this in an Added-date
 * view, where they are the upload time.
 */
export type CaptureTime = { localDateTime: string; offsetMinutes: number; timeZone?: string };

/** A zone name the browser can use and that names a place (or UTC), not a bare offset. */
export const isIanaZone = (zone: string | null | undefined): zone is string => {
  if (!zone || !(zone === 'UTC' || zone.includes('/'))) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** An asset's capture time from its details: `localDateTime` is the wall time, `fileCreatedAt` the instant. */
export const captureTimeOf = (asset: {
  localDateTime: string;
  fileCreatedAt: string;
  exifInfo?: { timeZone?: string | null } | null;
}): CaptureTime | null => {
  const local = Date.parse(asset.localDateTime);
  const instant = Date.parse(asset.fileCreatedAt);
  if (!Number.isFinite(local) || !Number.isFinite(instant)) {
    return null;
  }
  const zone = asset.exifInfo?.timeZone;
  return {
    localDateTime: new Date(local).toISOString().slice(0, 16),
    offsetMinutes: Math.round((local - instant) / 60_000),
    ...(isIanaZone(zone) && { timeZone: zone }),
  };
};
