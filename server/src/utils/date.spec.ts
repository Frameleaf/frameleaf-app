import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDateString, asDateTimeString, extractTimeZone, withDateTimeOffset } from 'src/utils/date.js';

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
      expect(extractTimeZone()).toBeUndefined();
      expect(extractTimeZone('not-a-date')).toBeUndefined();
    },
  );
});

describe('explicit edit offsets', () => {
  it.each([
    ['2020-06-10T12:30:00.123456', '2020-06-10T12:30:00.123456Z'],
    ['2020-06-10t12:30:00.123456Z', '2020-06-10t12:30:00.123456Z'],
    ['2020-06-10t12:30:00.123456', '2020-06-10t12:30:00.123456Z'],
    ['2020-06-10t12:30:00.123456+02:00[Europe/Paris]', '2020-06-10T12:30:00.123456+02:00'],
    ['2020-06-10T12:30:00.123456[Europe/Paris]', '2020-06-10T12:30:00.123456+02:00'],
    ['2020-12-10T12:30:00.123456[Europe/Paris]', '2020-12-10T12:30:00.123456+01:00'],
    ['2020-06-10T12:30:00.123456-06:00', '2020-06-10T12:30:00.123456-06:00'],
    ['2020-06-10T12:30:00.123456+0530', '2020-06-10T12:30:00.123456+0530'],
    ['2020-06-10T12:30:00.123456Z', '2020-06-10T12:30:00.123456Z'],
    ['2020-06-10', '2020-06-10T00:00:00.000Z'],
    ['not-a-date', 'not-a-date'],
    [undefined, undefined],
  ])('preserves precision and existing offsets for %s', (input, expected) => {
    expect(withDateTimeOffset(input)).toBe(expected);
  });
});
