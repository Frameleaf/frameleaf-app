/**
 * The information panel's "Edit date and time" dialog logic (audit V-23), ported from
 * `design/frameleaf/template/src/media-viewer.mjs` (`splitDateTime`, `joinDateTime`,
 * `formatCaptureDate`, `timezoneOffsetLabel`, `COMMON_TIMEZONES`, `timezoneOptions`). Pure, so the
 * dialog's rules can be tested without rendering it.
 */

/** The template's short list of time zones, offered first (media-viewer.mjs:379-414). */
export const COMMON_TIMEZONES = Object.freeze([
  'UTC',
  'America/St_Johns',
  'America/Halifax',
  'America/Toronto',
  'America/New_York',
  'America/Winnipeg',
  'America/Chicago',
  'America/Edmonton',
  'America/Denver',
  'America/Phoenix',
  'America/Vancouver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Athens',
  'Europe/Moscow',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Perth',
  'Australia/Sydney',
  'Pacific/Auckland',
]);

/** `2026-09-24T18:05…` → its wall-clock date and time; a missing time is midnight. */
export function splitDateTime(value: string | null | undefined): { date: string; time: string } {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?/.exec(value ?? '');
  return match ? { date: match[1], time: match[2] ?? '00:00' } : { date: '', time: '' };
}

/** A date and a time as the wall-clock `yyyy-MM-ddTHH:mm:00`, or null while either is incomplete or impossible. */
export function joinDateTime(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return null;
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hours > 23 ||
    minutes > 59
  ) {
    return null;
  }
  return `${date}T${time}:00`;
}

/** `UTC+02:00` for a zone at a moment, or null for a zone the browser does not know. */
export function timezoneOffsetLabel(zone: string, at: Date = new Date()): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at);
    const name = parts.find((part) => part.type === 'timeZoneName')?.value;
    return name === 'GMT' ? 'UTC+00:00' : (name ?? '').replace(/^GMT/, 'UTC') || null;
  } catch {
    return null;
  }
}

export interface TimezoneChoice {
  value: string;
  label: string;
}

const choice = (zone: string, at: Date): TimezoneChoice | null => {
  const offset = timezoneOffsetLabel(zone, at);
  return offset ? { value: zone, label: `${offset} · ${zone.replaceAll('_', ' ')}` } : null;
};

/**
 * The time zone choices: the template's common zones, with the item's own zone first when it is not
 * one of them (`timezoneOptions`, media-viewer.mjs:415-426), then every other zone the browser knows,
 * so no zone the production dialog offered is lost.
 */
export function timezoneChoices(
  current: string | null | undefined,
  at: Date = new Date(),
  known: readonly string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [],
): { common: TimezoneChoice[]; more: TimezoneChoice[] } {
  const commonZones = [...COMMON_TIMEZONES];
  if (current && !commonZones.includes(current)) {
    commonZones.unshift(current);
  }
  const listed = new Set(commonZones);
  const toChoices = (zones: readonly string[]) =>
    zones.map((zone) => choice(zone, at)).filter((option): option is TimezoneChoice => !!option);
  return {
    common: toChoices(commonZones),
    more: toChoices(known.filter((zone) => !listed.has(zone))),
  };
}
