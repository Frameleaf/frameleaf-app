import { describe, expect, it } from 'vitest';
import {
  formatUtcOffset,
  splitLocalDateTime,
  timeZoneChoices,
  timeZoneCity,
  timeZoneLabel,
  captureTimeOf,
  isIanaZone,
  wallTimeInZone,
  zoneForOffset,
} from './time-zones';

describe('friendly time zones (FL-32, T-19)', () => {
  const winter = '2026-01-15T12:00';
  const summer = '2026-07-15T12:00';

  it('names a zone by its city, its region and the offset on the date being set', () => {
    expect(timeZoneLabel('America/Vancouver', winter, 'en').label).toBe('Vancouver (Pacific Time · UTC−08:00)');
    expect(timeZoneLabel('America/Vancouver', summer, 'en').label).toBe('Vancouver (Pacific Time · UTC−07:00)');
    expect(timeZoneLabel('Asia/Kolkata', winter, 'en').offsetMinutes).toBe(330);
    expect(timeZoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  });

  it('formats offsets with a real minus sign and plain UTC at zero', () => {
    expect(formatUtcOffset(0)).toBe('UTC');
    expect(formatUtcOffset(330)).toBe('UTC+05:30');
    expect(formatUtcOffset(-420)).toBe('UTC−07:00');
  });

  it('lists UTC first, then places west to east, without raw Etc offsets', () => {
    const choices = timeZoneChoices({
      wallTime: winter,
      locale: 'en',
      zones: ['Europe/London', 'Etc/GMT+5', 'America/Vancouver', 'UTC', 'Asia/Tokyo', 'America/Toronto'],
    });
    expect(choices.map((choice) => choice.value)).toEqual([
      'UTC',
      'America/Vancouver',
      'America/Toronto',
      'Europe/London',
      'Asia/Tokyo',
    ]);
    expect(choices.every((choice) => !choice.label.includes('/'))).toBe(true);
  });

  it('reads the pre-fill from the first selected item', () => {
    expect(splitLocalDateTime('2024-12-11T18:42')).toEqual({ date: '2024-12-11', time: '18:42' });
    expect(splitLocalDateTime(undefined)).toBeNull();
    expect(splitLocalDateTime('garbage')).toBeNull();
  });

  it('reads the offset a wall time has in the zone, on either side of a daylight-saving change', () => {
    expect(timeZoneLabel('America/Vancouver', '2026-03-08T01:30', 'en').offsetMinutes).toBe(-480);
    expect(timeZoneLabel('America/Vancouver', '2026-03-08T03:30', 'en').offsetMinutes).toBe(-420);
    expect(wallTimeInZone('2026-03-08T03:30', 'America/Vancouver')).toBe('2026-03-08T03:30:00-07:00');
    expect(wallTimeInZone('2026-11-01T12:00', 'Europe/London')).toBe('2026-11-01T12:00:00+00:00');
  });

  it('guesses an item’s zone from its offset, preferring the browser’s own', () => {
    const choices = timeZoneChoices({
      wallTime: winter,
      locale: 'en',
      zones: ['America/Los_Angeles', 'America/Vancouver', 'Europe/Berlin'],
    });
    expect(zoneForOffset(choices, -480, 'America/Vancouver')?.value).toBe('America/Vancouver');
    expect(zoneForOffset(choices, -480, 'Asia/Tokyo')?.value).toBe('America/Los_Angeles');
    expect(zoneForOffset(choices, 0, 'Asia/Tokyo')?.value).toBe('UTC');
  });

  it('reads an item’s real capture time and IANA zone from its details (review N1/N3)', () => {
    expect(
      captureTimeOf({
        localDateTime: '2019-01-05T09:30:00.000Z',
        fileCreatedAt: '2019-01-05T17:30:00.000Z',
        exifInfo: { timeZone: 'America/Vancouver' },
      }),
    ).toEqual({ localDateTime: '2019-01-05T09:30', offsetMinutes: -480, timeZone: 'America/Vancouver' });
    // A bare offset such as "UTC+2" names no place; the offset alone is kept.
    expect(
      captureTimeOf({
        localDateTime: '2019-01-05T19:30:00Z',
        fileCreatedAt: '2019-01-05T17:30:00Z',
        exifInfo: { timeZone: 'UTC+2' },
      }),
    ).toEqual({ localDateTime: '2019-01-05T19:30', offsetMinutes: 120 });
    expect(isIanaZone('Nowhere/Land')).toBe(false);
    expect(captureTimeOf({ localDateTime: 'bad', fileCreatedAt: 'bad' })).toBeNull();
  });
});
