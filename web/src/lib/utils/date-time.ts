import { DateTime } from 'luxon';
import { get } from 'svelte/store';
import { dateFormats } from '$lib/constants';
import { locale } from '$lib/stores/preferences.store';

export function parseUtcDate(date: string) {
  return DateTime.fromISO(date, { zone: 'UTC' }).toUTC();
}

const rangeFormatters: Partial<
  Record<'short' | 'long', { locale: string | undefined; formatter: Intl.DateTimeFormat }>
> = {};

const getDateRange = (startTimestamp: string, endTimestamp: string, format: 'short' | 'long') => {
  const userLocale = get(locale);
  const startDate = DateTime.fromISO(startTimestamp).setZone('UTC');
  const endDate = DateTime.fromISO(endTimestamp).setZone('UTC');

  if (startDate.year === endDate.year && startDate.month === endDate.month && format === 'short') {
    return endDate.setLocale(userLocale).toLocaleString({ month: 'long', year: 'numeric' });
  }

  let cached = rangeFormatters[format];
  // Keep at most one locale per style, rather than retaining every language selected.
  if (!cached || cached.locale !== userLocale) {
    cached = {
      locale: userLocale,
      formatter: new Intl.DateTimeFormat(userLocale, format === 'short' ? dateFormats.albumShort : dateFormats.album),
    };
    rangeFormatters[format] = cached;
  }
  return cached.formatter.formatRange(startDate.toJSDate(), endDate.toJSDate());
};

/**
 * Get localized date range in short format like 'Oct – Nov 2026', with full month if start and end are the same: 'October 2026'.
 * Timestamps are expected to be date-only in UTC.
 */
export const getShortDateRange = (start: string, end: string) => getDateRange(start, end, 'short');

/**
 * Get localized date range in long format. Timestamps are expected to be date-only in UTC.
 */
export const getAlbumDateRange = (start: string, end: string) => getDateRange(start, end, 'long');
