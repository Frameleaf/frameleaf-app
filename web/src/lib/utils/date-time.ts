import { DateTime } from 'luxon';
import { get } from 'svelte/store';
import { dateFormats } from '$lib/constants';
import { formatDateRange, formatLuxon } from '$lib/frameleaf/date-format';
import { locale } from '$lib/stores/preferences.store';

export function parseUtcDate(date: string) {
  return DateTime.fromISO(date, { zone: 'UTC' }).toUTC();
}

const getDateRange = (startTimestamp: string, endTimestamp: string, format: 'short' | 'long') => {
  const userLocale = get(locale);
  const startDate = DateTime.fromISO(startTimestamp).setZone('UTC');
  const endDate = DateTime.fromISO(endTimestamp).setZone('UTC');

  if (startDate.year === endDate.year && startDate.month === endDate.month && format === 'short') {
    return formatLuxon(endDate.setLocale(userLocale), { month: 'long', year: 'numeric' });
  }
  // FL-1805: the person's date order applies to a range that shows days.
  return formatDateRange(
    startDate.toJSDate(),
    endDate.toJSDate(),
    format === 'short' ? dateFormats.albumShort : dateFormats.album,
    userLocale,
  );
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
