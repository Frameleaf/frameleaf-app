/**
 * FL-936: a capture date known only to the year or the decade. The server keeps such a date as the start
 * of its period (1 January, midnight, UTC) with `dateAccuracy` beside it; everything that shows the date
 * reads it through `formatApproximateDate`, so it says "1975" or "circa 1970s" and never a day or a time.
 */
import type { DateAccuracy as SdkDateAccuracy } from '@frameleaf/sdk';
import type { MessageFormatter } from 'svelte-i18n';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';

export type DateAccuracy = 'year' | 'decade';
/** What the date dialogs choose between. */
export type DatePrecision = 'exact' | DateAccuracy;

/** The earliest year the server takes for a year or a decade. */
export const MIN_APPROXIMATE_YEAR = 1800;

/** The timeline's group keys for a year and a decade: no calendar day, and they sort before 1 January. */
export const YEAR_GROUP_DAY = 0;
export const DECADE_GROUP_DAY = -1;

/** The accuracy the server sent, or null for an exact date and for a value this version does not know. */
export const dateAccuracyOf = (value: unknown): DateAccuracy | null =>
  value === 'year' || value === 'decade' ? value : null;

/** The same two words as the SDK's request enum, which TypeScript treats as a different type. */
export const toSdkDateAccuracy = (accuracy: DateAccuracy) => accuracy as SdkDateAccuracy;

export const decadeOf = (year: number) => Math.floor(year / 10) * 10;

/** The decades the dialogs offer: 1800s to the current one, oldest first. */
export const decadeChoices = (currentYear = new Date().getFullYear()): number[] => {
  const decades: number[] = [];
  for (let decade = MIN_APPROXIMATE_YEAR; decade <= currentYear; decade += 10) {
    decades.push(decade);
  }
  return decades;
};

/** A typed year the server takes: four digits, from 1800 to this year. Null for anything else. */
export const parseApproximateYear = (value: unknown, currentYear = new Date().getFullYear()): number | null => {
  const text = String(value ?? '').trim();
  if (!/^\d{4}$/.test(text)) {
    return null;
  }
  const year = Number(text);
  return year >= MIN_APPROXIMATE_YEAR && year <= currentYear ? year : null;
};

/** What is saved for a year or a decade: the first instant of the period, in UTC. */
export const periodStartIso = (year: number, accuracy: DateAccuracy) =>
  `${String(accuracy === 'decade' ? decadeOf(year) : year).padStart(4, '0')}-01-01T00:00:00.000Z`;

/** The timeline group an asset with this accuracy belongs to, in place of a calendar day. */
export const approximateGroupDay = (accuracy: DateAccuracy) =>
  accuracy === 'decade' ? DECADE_GROUP_DAY : YEAR_GROUP_DAY;

/** The accuracy a timeline group stands for, by its key; null for a calendar day. */
export const groupDayAccuracy = (day: number): DateAccuracy | null =>
  day === YEAR_GROUP_DAY ? 'year' : day === DECADE_GROUP_DAY ? 'decade' : null;

type DateInput = string | number | Date | { year: number } | null | undefined;

const yearOf = (date: DateInput): number | null => {
  if (date === null || date === undefined) {
    return null;
  }
  if (typeof date === 'number') {
    return Number.isFinite(date) ? date : null;
  }
  if (typeof date === 'string') {
    // the stored date is the start of the period in UTC, so its year is read as written, never in a zone
    const match = /^(\d{4})(?:-|$)/.exec(date);
    return match ? Number(match[1]) : null;
  }
  if (date instanceof Date) {
    return Number.isFinite(date.getTime()) ? date.getUTCFullYear() : null;
  }
  return Number.isFinite(date.year) ? date.year : null;
};

const yearText = (year: number, locale: string | undefined) => {
  try {
    return new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 0 }).format(year);
  } catch {
    return String(year);
  }
};

export type ApproximateDateOptions = {
  /** A heading starts with a capital: "Circa 1970s". */
  heading?: boolean;
  /** The translator; the page's own by default. */
  $t?: MessageFormatter;
};

/**
 * "1975" for a year and "circa 1970s" for a decade. `date` is the stored date (an ISO string, a Date, a
 * year, or anything with a `year`). Null for an exact date, so a caller falls back to its own format.
 */
export const formatApproximateDate = (
  date: DateInput,
  accuracy: string | null | undefined,
  locale?: string,
  { heading = false, $t = get(t) }: ApproximateDateOptions = {},
): string | null => {
  const known = dateAccuracyOf(accuracy);
  const year = yearOf(date);
  if (!known || year === null) {
    return null;
  }
  if (known === 'year') {
    return yearText(year, locale);
  }
  return $t(heading ? 'frameleaf_date_circa_decade_heading' : 'frameleaf_date_circa_decade', {
    values: { decade: yearText(decadeOf(year), locale) },
  });
};
