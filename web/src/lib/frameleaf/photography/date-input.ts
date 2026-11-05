import { DateTime } from 'luxon';

/**
 * A `<input type="date">` value (YYYY-MM-DD) saved as the end of that day in the
 * viewer's own time zone, as a UTC instant.
 */
export const endOfLocalDayIso = (value: string): string | null =>
  value ? DateTime.fromISO(`${value}T23:59:59`).toUTC().toISO() : null;

/**
 * The date-input value for a stored instant: its calendar date in the viewer's
 * own time zone, so a saved end-of-day reads back as the day that was picked.
 */
export const localDateInput = (iso: string | null | undefined): string => {
  if (!iso) {
    return '';
  }
  const date = DateTime.fromISO(iso);
  return date.isValid ? (date.toISODate() ?? '') : '';
};
