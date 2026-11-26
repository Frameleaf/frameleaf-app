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

/** FL-936: how much of a capture date is known when it is not all of it. An exact date has no accuracy (null). */
export const DATE_ACCURACIES = ['year', 'decade'] as const;
export type DateAccuracy = (typeof DATE_ACCURACIES)[number];

/** FL-936: the earliest year a photo can be dated to by year or decade. */
export const MIN_APPROXIMATE_YEAR = 1800;

/** The first year of the year or decade `year` is in. */
export const getPeriodStartYear = (year: number, accuracy: DateAccuracy) =>
  accuracy === 'decade' ? Math.floor(year / 10) * 10 : year;

/** A year or decade can be chosen from 1800 up to the one that has begun. */
export const isApproximateYear = (year: number, accuracy: DateAccuracy, now = new Date()) =>
  Number.isSafeInteger(year) &&
  year >= MIN_APPROXIMATE_YEAR &&
  getPeriodStartYear(year, accuracy) <= now.getUTCFullYear();

/**
 * FL-936: the capture date a year or a decade is stored as: its first day at midnight, in UTC, so the local date
 * is 1 January of that year whatever time zone the server or the person is in.
 */
export const getPeriodStart = (year: number, accuracy: DateAccuracy) =>
  `${String(getPeriodStartYear(year, accuracy)).padStart(4, '0')}-01-01T00:00:00.000Z`;

/** The year a capture date names, on its own clock. */
export const getCaptureYear = (dateTimeOriginal: string) =>
  DateTime.fromISO(dateTimeOriginal, { setZone: true, zone: 'UTC' }).year;

/**
 * FL-936: a date edit as it is stored. With an accuracy the date becomes the start of its year or decade; a date
 * sent without one is exact again. An edit that names neither is returned as it is.
 */
export const withApproximateDate = <T extends { dateTimeOriginal?: string; dateAccuracy?: DateAccuracy | null }>(
  dto: T,
): T => {
  if (dto.dateTimeOriginal === undefined && dto.dateAccuracy === undefined) {
    return dto;
  }
  const dateAccuracy = dto.dateAccuracy ?? null;
  return {
    ...dto,
    dateAccuracy,
    ...(dateAccuracy &&
      dto.dateTimeOriginal && { dateTimeOriginal: getPeriodStart(getCaptureYear(dto.dateTimeOriginal), dateAccuracy) }),
  };
};
