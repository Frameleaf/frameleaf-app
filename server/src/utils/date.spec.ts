import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asDateString,
  asDateTimeString,
  extractTimeZone,
  getAssetDateTimeUpdates,
  getPeriodStart,
  isApproximateYear,
  withApproximateDate,
  withDateTimeOffset,
} from 'src/utils/date.js';

describe('asDateString', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should return null for null input', () => {
    expect(asDateString(null)).toBeNull();
  });

  it('should pass through a pre-serialized string unchanged', () => {
    expect(asDateString('2000-01-15')).toBe('2000-01-15');
  });

  // a `date` column is parsed as `new Date('YYYY-MM-DD')`, which is UTC midnight regardless of the server time zone
  it.each(['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/Istanbul', 'Pacific/Kiritimati'])(
    'should return the UTC calendar date of a date column when the server time zone is %s',
    (timeZone) => {
      vi.stubEnv('TZ', timeZone);
      expect(asDateString(new Date('2000-01-15'))).toBe('2000-01-15');
    },
  );

  it('should correctly pad years with a leading 0', () => {
    expect(asDateString(new Date('0280-12-12'))).toBe('0280-12-12');
  });
});

describe('asDateTimeString', () => {
  it('should return null for null input', () => {
    expect(asDateTimeString(null)).toBeNull();
  });

  it('should pass through a pre-serialized string unchanged', () => {
    const iso = '2000-01-15T12:00:00.000Z';
    expect(asDateTimeString(iso)).toBe(iso);
  });

  it('should return an ISO 8601 datetime string for a Date', () => {
    const date = new Date('2000-01-15T12:00:00.000Z');
    expect(asDateTimeString(date)).toBe('2000-01-15T12:00:00.000Z');
  });
});

describe('absolute edit timezone extraction', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(['America/Edmonton', 'Asia/Tokyo'])(
    'uses the same UTC fallback as asset clocks when the server zone is %s',
    (zone) => {
      vi.stubEnv('TZ', zone);
      expect(extractTimeZone('2020-06-10T12:30:00')?.name).toBe('UTC');
      expect(extractTimeZone('2020-06-10T12:30:00-06:00')?.offset(0)).toBe(-360);
      expect(extractTimeZone('2020-06-10T12:30:00Z')?.offset(0)).toBe(0);
      expect(extractTimeZone('2020-06-10t12:30:00+02:00[Europe/Paris]')?.name).toBe('Europe/Paris');
      expect(extractTimeZone('2020-12-10T12:30:00[Europe/Paris]')?.name).toBe('Europe/Paris');
      expect(extractTimeZone('2020-12-10T12:30:00[Invalid/Zone]')).toBeUndefined();
      expect(extractTimeZone()).toBeUndefined();
      expect(extractTimeZone('not-a-date')).toBeUndefined();
    },
  );
});

describe('explicit edit offsets', () => {
  it.each([
    ['2020-06-10T12:30:00.123456', '2020-06-10T12:30:00.123456Z'],
    ['2020-06-10t12:30:00.123456Z', '2020-06-10T12:30:00.123456Z'],
    ['2020-06-10t12:30:00.123456', '2020-06-10T12:30:00.123456Z'],
    ['2020-06-10t12:30:00.123456+02:00[Europe/Paris]', '2020-06-10T12:30:00.123456+02:00'],
    ['2020-06-10T12:30:00.123456[Europe/Paris]', '2020-06-10T12:30:00.123456+02:00'],
    ['2020-12-10T12:30:00.123456[Europe/Paris]', '2020-12-10T12:30:00.123456+01:00'],
    ['2020-06-10T12:30:00.123456-06:00', '2020-06-10T12:30:00.123456-06:00'],
    ['2020-06-10T12:30:00.123456+0530', '2020-06-10T12:30:00.123456+05:30'],
    ['2020-06-10T12:30:00.123456Z', '2020-06-10T12:30:00.123456Z'],
    ['2020-06-10', '2020-06-10T00:00:00Z'],
    ['2020-06-10t12:30:00,123456', '2020-06-10T12:30:00.123456Z'],
    ['2020-06-10T12:30:00,123456+02:00', '2020-06-10T12:30:00.123456+02:00'],
    ['20200610T123000.123456+0200', '2020-06-10T12:30:00.123456+02:00'],
    ['2020-11-01T01:30:00.123456-04:00[America/New_York]', '2020-11-01T01:30:00.123456-04:00'],
    ['2020-11-01T01:30:00.123456-05:00[America/New_York]', '2020-11-01T01:30:00.123456-05:00'],
    ['2020-11-01T01:30:00.123456-07:00[America/Edmonton]', '2020-11-01T01:30:00.123456-07:00'],
    ['not-a-date', 'not-a-date'],
    [undefined, undefined],
  ])('preserves precision and existing offsets for %s', (input, expected) => {
    expect(withDateTimeOffset(input)).toBe(expected);
  });
});

describe('approximate dates (FL-936)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const sent = [
    '1975-06-15T23:30:00-11:00',
    '1975-01-01T00:30:00+14:00',
    '1975-12-31T23:59:59.999-12:00',
    '1975-12-31T23:59:59',
    '1975-07-01T00:00:00Z',
    '1975-07-01',
  ];

  it.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Edmonton', 'Asia/Kolkata'])(
    'stores a year or a decade as 1 January at midnight, with the server in %s',
    (zone) => {
      vi.stubEnv('TZ', zone);
      for (const dateTimeOriginal of sent) {
        for (const [dateAccuracy, start] of [
          ['year', '1975-01-01T00:00:00.000Z'],
          ['decade', '1970-01-01T00:00:00.000Z'],
        ] as const) {
          const edit = withApproximateDate({ dateTimeOriginal, dateAccuracy });
          expect(edit).toEqual({ dateTimeOriginal: start, dateAccuracy, dateDetail: null });
          // what the EXIF row and the asset row get: the same instant and the same clock, zone UTC
          expect(withDateTimeOffset(edit.dateTimeOriginal)).toBe(start);
          expect(extractTimeZone(edit.dateTimeOriginal)?.name).toBe('UTC');
          const stored = { fileCreatedAt: new Date(start), localDateTime: new Date(start) };
          expect(getAssetDateTimeUpdates(edit.dateTimeOriginal)).toEqual(stored);
          expect(getAssetDateTimeUpdates(edit.dateTimeOriginal, 'UTC')).toEqual(stored);
          expect(stored.localDateTime.toISOString().slice(0, 10)).toBe(start.slice(0, 10));
        }
      }
    },
  );

  it('a date sent without an accuracy is exact again; an edit of neither is left alone', () => {
    expect(withApproximateDate({ dateTimeOriginal: '1975-06-15T10:00:00+02:00' })).toEqual({
      dateTimeOriginal: '1975-06-15T10:00:00+02:00',
      dateAccuracy: null,
      dateDetail: null,
    });
    expect(withApproximateDate({ dateTimeOriginal: '1975-06-15T10:00:00', dateAccuracy: null })).toEqual({
      dateTimeOriginal: '1975-06-15T10:00:00',
      dateAccuracy: null,
      dateDetail: null,
    });
    expect(withApproximateDate({ dateAccuracy: null })).toEqual({ dateAccuracy: null, dateDetail: null });
    const untouched: { dateTimeOriginal?: string; isFavorite: boolean } = { isFavorite: true };
    expect(withApproximateDate(untouched)).toBe(untouched);
  });

  describe('FL-1814: a month, or around a year', () => {
    it('stores a month as its 1st at midnight UTC, read on the clock the date was written in', () => {
      for (const [dateTimeOriginal, start] of [
        ['1987-03-15T10:00:00', '1987-03-01T00:00:00.000Z'],
        // late on the 31st in Edmonton is already April in UTC: the month the person meant is March
        ['1987-03-31T23:30:00-07:00', '1987-03-01T00:00:00.000Z'],
        // early on 1 March in Tokyo is still February in UTC: still March
        ['1987-03-01T00:30:00+09:00', '1987-03-01T00:00:00.000Z'],
        // a leap day keeps its month
        ['2024-02-29T12:00:00Z', '2024-02-01T00:00:00.000Z'],
        ['1987-12-31T23:59:59', '1987-12-01T00:00:00.000Z'],
      ] as const) {
        expect(withApproximateDate({ dateTimeOriginal, dateAccuracy: 'year', dateDetail: 'month' })).toEqual({
          dateTimeOriginal: start,
          dateAccuracy: 'year',
          dateDetail: 'month',
        });
      }
    });

    it('stores around a year as that year, with the detail', () => {
      expect(
        withApproximateDate({ dateTimeOriginal: '1987-06-15T10:00:00', dateAccuracy: 'year', dateDetail: 'about' }),
      ).toEqual({ dateTimeOriginal: '1987-01-01T00:00:00.000Z', dateAccuracy: 'year', dateDetail: 'about' });
    });

    it('drops the detail beside anything but a year, and clears it on any other date edit', () => {
      expect(
        withApproximateDate({ dateTimeOriginal: '1987-06-15T10:00:00', dateAccuracy: 'decade', dateDetail: 'month' }),
      ).toEqual({ dateTimeOriginal: '1980-01-01T00:00:00.000Z', dateAccuracy: 'decade', dateDetail: null });
      expect(withApproximateDate({ dateTimeOriginal: '1987-06-15T10:00:00', dateDetail: 'month' })).toMatchObject({
        dateAccuracy: null,
        dateDetail: null,
      });
      expect(withApproximateDate({ dateTimeOriginal: '1987-06-15T10:00:00', dateAccuracy: 'year' })).toMatchObject({
        dateDetail: null,
      });
    });
  });

  it('takes a year from 1800 up to this one, and a decade that has begun', () => {
    const now = new Date('2026-11-22T12:00:00.000Z');
    expect(isApproximateYear(1800, 'year', now)).toBe(true);
    expect(isApproximateYear(1799, 'year', now)).toBe(false);
    expect(isApproximateYear(1799, 'decade', now)).toBe(false);
    expect(isApproximateYear(2026, 'year', now)).toBe(true);
    expect(isApproximateYear(2027, 'year', now)).toBe(false);
    expect(isApproximateYear(2029, 'decade', now)).toBe(true);
    expect(isApproximateYear(2030, 'decade', now)).toBe(false);
    expect(getPeriodStart(1805, 'decade')).toBe('1800-01-01T00:00:00.000Z');
    expect(getPeriodStart(1989, 'decade')).toBe('1980-01-01T00:00:00.000Z');
    expect(getPeriodStart(2000, 'year')).toBe('2000-01-01T00:00:00.000Z');
  });
});
