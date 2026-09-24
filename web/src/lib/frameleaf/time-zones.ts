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

export const timeZoneLabel = (zone: string, at: Date, locale?: string): { label: string; offsetMinutes: number } => {
  const offsetMinutes = DateTime.fromJSDate(at, { zone }).offset;
  if (zone === 'UTC') {
    return { label: 'UTC', offsetMinutes: 0 };
  }
  const offset = formatUtcOffset(offsetMinutes);
  const generic = genericName(zone, at, locale);
  return { label: `${timeZoneCity(zone)} (${generic ? `${generic} · ${offset}` : offset})`, offsetMinutes };
};

/**
 * Every zone as a friendly choice, ordered west to east and then by name, with UTC first as in the
 * prototype. `at` is the moment being set, so a zone's offset reflects daylight saving on that date.
 */
export const timeZoneChoices = ({
  at = new Date(),
  locale,
  zones = supportedZones(),
}: { at?: Date; locale?: string; zones?: readonly string[] } = {}): TimeZoneChoice[] => {
  const seen = new Set<string>();
  const choices: TimeZoneChoice[] = [];
  for (const zone of zones) {
    // `Etc/GMT+5` style ids are offsets, not places, and read backwards (POSIX signs).
    if (seen.has(zone) || zone === 'UTC' || zone.startsWith('Etc/') || !zone.includes('/')) {
      continue;
    }
    seen.add(zone);
    choices.push({ value: zone, ...timeZoneLabel(zone, at, locale) });
  }
  choices.sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.label.localeCompare(b.label, locale));
  return [{ value: 'UTC', label: 'UTC', offsetMinutes: 0 }, ...choices];
};

/** A date-time field's value as the dialog pre-fills it: `yyyy-MM-dd` and `HH:mm`. */
export const splitLocalDateTime = (value: string | undefined): { date: string; time: string } | null => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value ?? '');
  return match ? { date: match[1], time: match[2] } : null;
};
