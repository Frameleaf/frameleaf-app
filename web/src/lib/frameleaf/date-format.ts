/**
 * FL-783: the one place the web app turns a date into text. Every screen that shows a date or a time
 * calls `formatDate`, `formatTime` or `formatDateTime` here instead of `toLocaleString` or
 * `Intl.DateTimeFormat`, so the person's choice in Your preferences › Look & playback ("Date format",
 * "Time format") applies everywhere, whatever their language.
 *
 * - `auto` (the default) is exactly what `Intl.DateTimeFormat` gives for the locale, so a screen that
 *   moves to this helper looks the same until the person picks a format.
 * - Date format changes only the order and separators of a date that has a day: ISO `2026-11-01`,
 *   day-month-year `01/11/2026`, month-day-year `11/01/2026`. A date written with the month's name
 *   keeps the name in the person's language ("16 Aug 2026", "Aug 16, 2026"); ISO writes it in numbers.
 * - Time format sets the clock (`h12` 2:30 PM, `h23` 14:30) on anything that shows an hour.
 */
import type { DateTime } from 'luxon';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { locale as dateLocale } from '$lib/stores/preferences.store';

export const DATE_FORMATS = ['auto', 'iso', 'dmy', 'mdy'] as const;
export const HOUR_CYCLES = ['auto', 'h12', 'h23'] as const;
export type DisplayFormat = { dateFormat: (typeof DATE_FORMATS)[number]; hourCycle: (typeof HOUR_CYCLES)[number] };

export const AUTO_DISPLAY_FORMAT: DisplayFormat = Object.freeze({ dateFormat: 'auto', hourCycle: 'auto' });

/** The signed-in person's choice; `auto` when signed out or on a server from before FL-783. */
export const displayFormat = (): DisplayFormat =>
  authManager.authenticated ? { ...AUTO_DISPLAY_FORMAT, ...authManager.preferences?.display } : AUTO_DISPLAY_FORMAT;

/** The "Dates and numbers" region from Look & playback; `undefined` follows the browser. */
const defaultLocale = (): string | undefined => {
  const value = get(dateLocale);
  return value && value !== 'default' ? value : undefined;
};

const MEDIUM_DATE: Intl.DateTimeFormatOptions = Object.freeze({ dateStyle: 'medium' });
const SHORT_TIME: Intl.DateTimeFormatOptions = Object.freeze({ timeStyle: 'short' });
const MEDIUM_DATE_TIME: Intl.DateTimeFormatOptions = Object.freeze({ dateStyle: 'medium', timeStyle: 'short' });

const TEXT_MONTHS = new Set(['short', 'long', 'narrow']);

/** `dateStyle` spelled out as fields, so the parts can be put in another order. */
const DATE_STYLE_FIELDS: Record<NonNullable<Intl.DateTimeFormatOptions['dateStyle']>, Intl.DateTimeFormatOptions> = {
  short: { year: 'numeric', month: 'numeric', day: 'numeric' },
  medium: { year: 'numeric', month: 'short', day: 'numeric' },
  long: { year: 'numeric', month: 'long', day: 'numeric' },
  full: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
};

const DATE_KEYS = ['weekday', 'era', 'year', 'month', 'day'];
const TIME_KEYS = ['hour', 'minute', 'second', 'fractionalSecondDigits', 'dayPeriod', 'timeStyle', 'timeZoneName'];

const pick = (options: Intl.DateTimeFormatOptions, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(options).filter(([key]) => keys.includes(key))) as Intl.DateTimeFormatOptions;

const pad = (value: string) => value.padStart(2, '0');

/**
 * FL-1805: one formatter per locale and set of options. A timeline draws thousands of dates with the
 * same few, and building an `Intl.DateTimeFormat` costs far more than using one.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (locale: string | undefined, options: Intl.DateTimeFormatOptions) => {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    // ponytail: unbounded, but the keys are the app's own handful of option sets times the locales in use
    formatter = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter;
};

const partsOf = (date: Date, locale: string | undefined, options: Intl.DateTimeFormatOptions) => {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(locale, options).formatToParts(date)) {
    parts[part.type] ??= part.value;
  }
  return parts;
};

/** The date half in the chosen order, or `undefined` to leave it to Intl (no day, or `auto`). */
const orderedDate = (
  date: Date,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
  dateFormat: DisplayFormat['dateFormat'],
): string | undefined => {
  const fields = options.dateStyle ? DATE_STYLE_FIELDS[options.dateStyle] : pick(options, DATE_KEYS);
  if (dateFormat === 'auto' || !fields.day) {
    return undefined;
  }
  const shared = { timeZone: options.timeZone, calendar: options.calendar, numberingSystem: options.numberingSystem };
  const numbers = partsOf(date, locale, { ...shared, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = pad(numbers.day ?? '');
  const month = pad(numbers.month ?? '');
  const year = fields.year ? (numbers.year ?? '') : undefined;
  const weekday = fields.weekday ? partsOf(date, locale, { ...shared, weekday: fields.weekday }).weekday : undefined;
  const withWeekday = (text: string, separator: string) => (weekday ? `${weekday}${separator}${text}` : text);

  if (dateFormat === 'iso') {
    return withWeekday([year, month, day].filter(Boolean).join('-'), ' ');
  }
  if (!fields.month || !TEXT_MONTHS.has(fields.month)) {
    const ordered = dateFormat === 'dmy' ? [day, month, year] : [month, day, year];
    return withWeekday(ordered.filter(Boolean).join('/'), ', ');
  }
  // the day from the same call as the month name, so it keeps the locale's digits (Arabic, Persian)
  const named = partsOf(date, locale, { ...shared, month: fields.month, day: 'numeric' });
  const name = named.month ?? month;
  const plainDay = named.day ?? day;
  const text =
    dateFormat === 'dmy'
      ? [plainDay, name, year].filter(Boolean).join(' ')
      : `${name} ${plainDay}${year ? `, ${year}` : ''}`;
  return withWeekday(text, ', ');
};

/**
 * Formats `date` with any `Intl.DateTimeFormat` options, applying the person's date and time format.
 * `locale` defaults to the "Dates and numbers" region; pass the one a screen used before to keep its
 * output unchanged under `auto`. An invalid date gives an empty string.
 */
export const formatDateTime = (
  date: Date | number | string,
  options: Intl.DateTimeFormatOptions = MEDIUM_DATE_TIME,
  locale: string | undefined = defaultLocale(),
  format: DisplayFormat = displayFormat(),
): string => {
  const value = date instanceof Date ? date : new Date(date);
  // the "Dates and numbers" store's own word for "follow the browser"
  locale = locale === 'default' ? undefined : locale;
  if (Number.isNaN(value.getTime())) {
    return '';
  }
  const timeOptions = pick(options, TIME_KEYS);
  const hasTime = Object.keys(timeOptions).some((key) => key !== 'timeZoneName');
  const clock: Intl.DateTimeFormatOptions =
    hasTime && format.hourCycle !== 'auto' ? { hourCycle: format.hourCycle, hour12: undefined } : {};

  const ordered = orderedDate(value, locale, options, format.dateFormat);
  if (ordered === undefined) {
    return formatterFor(locale, { ...options, ...clock }).format(value);
  }
  if (!hasTime) {
    return ordered;
  }
  const time = formatterFor(locale, {
    hourCycle: options.hourCycle,
    hour12: options.hour12,
    ...timeOptions,
    ...clock,
    timeZone: options.timeZone,
  }).format(value);
  return `${ordered}${format.dateFormat === 'iso' || !options.dateStyle ? ' ' : ', '}${time}`;
};

/**
 * A Luxon date in its own zone, as `DateTime.toLocaleString(options)` showed it: the wall-clock time is
 * formatted in UTC, so fixed offsets ("UTC+2", which Intl does not accept as a zone) work too.
 */
export const formatLuxon = (
  value: DateTime,
  options: Intl.DateTimeFormatOptions = MEDIUM_DATE,
  locale: string | undefined = value.locale ?? defaultLocale(),
  format: DisplayFormat = displayFormat(),
): string => {
  if (!value.isValid) {
    return '';
  }
  // The year is set on its own: Date.UTC reads years 0 to 99 as 1900 to 1999 (a photo dated year 1).
  const wall = new Date(Date.UTC(2000, value.month - 1, value.day, value.hour, value.minute, value.second));
  wall.setUTCFullYear(value.year);
  return formatDateTime(wall, { ...options, timeZone: 'UTC' }, locale, format);
};

/** A date on its own; defaults to the medium style ("Aug 16, 2026"). */
export const formatDate = (
  date: Date | number | string,
  options: Intl.DateTimeFormatOptions = MEDIUM_DATE,
  locale: string | undefined = defaultLocale(),
  format: DisplayFormat = displayFormat(),
) => formatDateTime(date, options, locale, format);

/** A time on its own; defaults to the short style ("2:30 PM"). */
export const formatTime = (
  date: Date | number | string,
  options: Intl.DateTimeFormatOptions = SHORT_TIME,
  locale: string | undefined = defaultLocale(),
  format: DisplayFormat = displayFormat(),
) => formatDateTime(date, options, locale, format);

/**
 * A run of dates ("12 – 15 May 2024", "Oct – Nov 2026"). While the format is `auto`, or the options
 * have no day for an order to apply to, this is exactly `Intl.DateTimeFormat#formatRange`. Once the
 * person has chosen a date order, both ends are written in that order ("12/05/2024 – 15/05/2024"),
 * and a range within one day is that one date.
 */
export const formatDateRange = (
  start: Date | number | string,
  end: Date | number | string,
  options: Intl.DateTimeFormatOptions = MEDIUM_DATE,
  locale: string | undefined = defaultLocale(),
  format: DisplayFormat = displayFormat(),
): string => {
  const from = start instanceof Date ? start : new Date(start);
  const to = end instanceof Date ? end : new Date(end);
  const resolved = locale === 'default' ? undefined : locale;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return '';
  }
  const fields = options.dateStyle ? DATE_STYLE_FIELDS[options.dateStyle] : pick(options, DATE_KEYS);
  if (format.dateFormat === 'auto' || !fields.day) {
    const clock: Intl.DateTimeFormatOptions =
      format.hourCycle !== 'auto' && Object.keys(pick(options, TIME_KEYS)).length > 0
        ? { hourCycle: format.hourCycle, hour12: undefined }
        : {};
    return formatterFor(resolved, { ...options, ...clock }).formatRange(from, to);
  }
  const first = formatDateTime(from, options, resolved ?? 'default', format);
  const last = formatDateTime(to, options, resolved ?? 'default', format);
  return first === last ? first : `${first} – ${last}`;
};
