import { DateTime } from 'luxon';
import { isoDateToDate, isoDatetimeToDate } from 'src/validation.js';

/**
 * Convert a date to a ISO 8601 datetime string.
 */
export const asDateTimeString = <T extends Date | string | undefined | null>(x: T) => {
  return x instanceof Date ? isoDatetimeToDate.encode(x) : (x as Exclude<T, Date>);
};

/**
 * Convert a date to a date string (yyyy-mm-dd).
 */
export const asDateString = (x: Date | string | null): string | null => {
  return x instanceof Date ? isoDateToDate.encode(x) : x;
};

/** Bind offsetless edits to UTC before PostgreSQL parses them, preserving source fractional precision. */
export const withDateTimeOffset = (value?: string) => {
  if (!value) return value;
  const parsed = DateTime.fromISO(value, { setZone: true, zone: 'UTC' });
  if (!parsed.isValid) return value;
  const explicit = /t.+(?:Z|[+-]\d{2}(?::?\d{2})?)\[/iu.test(value);
  const resolved = explicit ? DateTime.fromISO(value.split('[', 1)[0], { setZone: true, zone: 'UTC' }) : parsed;
  if (!resolved.isValid) return value;
  const fraction = /t.*?[.,](\d+)/iu.exec(value)?.[1];
  const normalized = resolved.toISO({ suppressMilliseconds: !fraction })!;
  return fraction ? normalized.replace(/\.\d+(?=[Z+-])/u, () => '.' + fraction) : normalized;
};

export const extractTimeZone = (dateTimeOriginal?: string | null) => {
  const parsed = dateTimeOriginal ? DateTime.fromISO(dateTimeOriginal, { setZone: true, zone: 'UTC' }) : undefined;
  return parsed?.isValid && (parsed.zone.type === 'fixed' || parsed.zone.type === 'iana') ? parsed.zone : undefined;
};

export const mergeTimeZone = (dateTimeOriginal?: string | null, timeZone?: string | null) => {
  return dateTimeOriginal
    ? DateTime.fromISO(dateTimeOriginal, { zone: 'UTC' }).setZone(timeZone ?? undefined)
    : undefined;
};

/** FL-1299: a capture date is estimated only while it is still the date healing set. */
export const isDateEstimated = ({
  dateTimeOriginal,
  estimatedDateTimeOriginal,
}: {
  dateTimeOriginal?: Date | string | null;
  estimatedDateTimeOriginal?: Date | string | null;
}) =>
  !!dateTimeOriginal &&
  !!estimatedDateTimeOriginal &&
  new Date(dateTimeOriginal).getTime() === new Date(estimatedDateTimeOriginal).getTime();

/** An edited capture date as the asset row stores it: the instant and the local clock time (in `timeZone`, else
 * keeping the offset `previous` had). */
export const getAssetDateTimeUpdates = (
  dateTimeOriginal?: string,
  timeZone?: string | null,
  previous?: { fileCreatedAt: Date; localDateTime: Date },
) => {
  if (!dateTimeOriginal) {
    return {};
  }

  const dateTime = DateTime.fromISO(withDateTimeOffset(dateTimeOriginal)!, { setZone: true, zone: 'UTC' });
  if (!dateTime.isValid) {
    return {};
  }

  const zoned = timeZone ? dateTime.setZone(timeZone) : undefined;
  const localDateTime = zoned?.isValid
    ? zoned.setZone('UTC', { keepLocalTime: true }).toJSDate()
    : previous
      ? new Date(previous.localDateTime.getTime() + dateTime.toMillis() - previous.fileCreatedAt.getTime())
      : dateTime.setZone('UTC', { keepLocalTime: true }).toJSDate();
  return {
    fileCreatedAt: dateTime.toUTC().toJSDate(),
    localDateTime,
  };
};
