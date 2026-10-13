import { DateTime, Settings } from 'luxon';
import { get } from 'svelte/store';
import { locale } from '$lib/stores/preferences.store';
import { parseUtcDate } from '$lib/utils/date-time';
import {
  formatGroupTitle,
  getTimes,
  plainDateTimeCompare,
  toTimelineAsset,
  toISOYearMonthUTC,
  type TimelineDateTime,
} from '$lib/utils/timeline-util';
import { assetFactory } from '@test-data/factories/asset-factory';

describe('formatGroupTitle', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    process.env.TZ = 'UTC';
  });

  beforeEach(() => {
    vi.setSystemTime(new Date('2024-07-27T12:00:00Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
    delete process.env.TZ;
  });

  it('formats today', () => {
    const date = parseUtcDate('2024-07-27T01:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('today');
    locale.set('es');
    expect(formatGroupTitle(date)).toBe('hoy');
  });

  it('formats yesterday', () => {
    const date = parseUtcDate('2024-07-26T23:59:59Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('yesterday');
    locale.set('fr');
    expect(formatGroupTitle(date)).toBe('hier');
  });

  it('formats yesterday across month boundaries', () => {
    vi.setSystemTime(new Date('2024-05-01T12:00:00Z'));
    const date = parseUtcDate('2024-04-30T23:59:59Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('yesterday');
  });

  it('formats last week', () => {
    const date = parseUtcDate('2024-07-21T00:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('Sunday');
    locale.set('ar-SA');
    expect(formatGroupTitle(date)).toBe('الأحد');
  });

  it('formats date 7 days ago', () => {
    const date = parseUtcDate('2024-07-20T00:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('Sat, Jul 20');
    locale.set('de');
    expect(formatGroupTitle(date)).toBe('Sa., 20. Juli');
  });

  it('formats date this year', () => {
    const date = parseUtcDate('2020-01-01T00:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('Wed, Jan 1, 2020');
    locale.set('ja');
    expect(formatGroupTitle(date)).toBe('2020年1月1日(水)');
  });

  it('formats future date', () => {
    const tomorrow = parseUtcDate('2024-07-28T00:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(tomorrow)).toBe('Sun, Jul 28');

    const nextMonth = parseUtcDate('2024-08-28T00:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(nextMonth)).toBe('Wed, Aug 28');

    const nextYear = parseUtcDate('2025-01-10T12:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(nextYear)).toBe('Fri, Jan 10, 2025');
  });

  it('returns "Invalid DateTime" when date is invalid', () => {
    const date = DateTime.invalid('test');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('Invalid DateTime');
    locale.set('es');
    expect(formatGroupTitle(date)).toBe('Invalid DateTime');
  });
});

describe('toISOYearMonthUTC', () => {
  it('should prefix year with 0s', () => {
    expect(toISOYearMonthUTC({ year: 28, month: 1 })).toBe('0028-01-01T00:00:00.000Z');
  });

  it('should prefix month with 0s', () => {
    expect(toISOYearMonthUTC({ year: 2025, month: 1 })).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('EXIF timeline rating projection', () => {
  it.each([
    [{ rating: null, isRejected: true }, -1],
    [{ rating: -1 }, -1],
    [{ rating: 3, isRejected: false }, 3],
    [{ rating: null, isRejected: false }, null],
  ])('preserves tile/culling rating for %j', (exifInfo, expected) => {
    expect(toTimelineAsset(assetFactory.build({ exifInfo })).rating).toBe(expected);
  });
});

describe('plainDateTimeCompare', () => {
  const date: TimelineDateTime = { year: 2024, month: 2, day: 29, hour: 23, minute: 59, second: 58, millisecond: 123 };

  it.each(['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond'] as const)(
    'compares the %s field in both directions',
    (field) => {
      const later = { ...date, [field]: date[field] + 1 };
      expect(plainDateTimeCompare(true, date, later)).toBe(-1);
      expect(plainDateTimeCompare(false, date, later)).toBe(1);
    },
  );

  it('orders calendar dates before the time of day', () => {
    const later = { ...date, year: 2025, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 };
    expect(plainDateTimeCompare(true, date, later)).toBe(-1);
    expect(plainDateTimeCompare(false, date, later)).toBe(1);
  });

  it('keeps equal dates tied and does not mutate input', () => {
    const frozen = Object.freeze({ ...date });
    expect(plainDateTimeCompare(true, frozen, frozen)).toBe(0);
    expect(plainDateTimeCompare(false, frozen, frozen)).toBe(0);
  });

  it('sorts a same-day collection by time in either direction', () => {
    const dates = [2, 0, 1].map((second) => ({ ...date, second }));
    expect([...dates].sort(plainDateTimeCompare.bind(undefined, true)).map((date) => date.second)).toEqual([0, 1, 2]);
    expect([...dates].sort(plainDateTimeCompare.bind(undefined, false)).map((date) => date.second)).toEqual([2, 1, 0]);
  });
});

describe('getTimes', () => {
  let previousLocale = get(locale);
  beforeEach(() => {
    previousLocale = get(locale);
  });
  afterEach(() => locale.set(previousLocale));

  it.each([
    [5.75, { year: 2024, month: 3, day: 1, hour: 4, minute: 45, second: 0, millisecond: 123 }],
    [-3.5, { year: 2024, month: 2, day: 29, hour: 19, minute: 30, second: 0, millisecond: 123 }],
    [1 / 3_600_000, { year: 2024, month: 2, day: 29, hour: 23, minute: 0, second: 0, millisecond: 124 }],
    [0, { year: 2024, month: 2, day: 29, hour: 23, minute: 0, second: 0, millisecond: 123 }],
  ])('applies an offset of %s hours across leap-day boundaries', (offset, expected) => {
    locale.set('ar-SA');
    expect(getTimes('2024-02-29T23:00:00.123Z', offset)).toEqual({
      fileCreatedAt: { year: 2024, month: 2, day: 29, hour: 23, minute: 0, second: 0, millisecond: 123 },
      localDateTime: expected,
    });
  });

  it('normalizes ISO offsets to UTC before applying the local offset', () => {
    expect(getTimes('2024-01-01T00:15:00.500+05:30', -3.5)).toEqual({
      fileCreatedAt: { year: 2023, month: 12, day: 31, hour: 18, minute: 45, second: 0, millisecond: 500 },
      localDateTime: { year: 2023, month: 12, day: 31, hour: 15, minute: 15, second: 0, millisecond: 500 },
    });
  });

  it.each(['2024-01-01', '2024-001', '2024-W01-1', '2024-01-01T00:00:00'])(
    'parses %s as UTC independently of the host zone',
    (iso) => {
      const previousZone = Settings.defaultZone;
      try {
        Settings.defaultZone = 'America/Edmonton';
        expect(getTimes(iso, -3.5)).toEqual({
          fileCreatedAt: { year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 },
          localDateTime: { year: 2023, month: 12, day: 31, hour: 20, minute: 30, second: 0, millisecond: 0 },
        });
      } finally {
        Settings.defaultZone = previousZone;
      }
    },
  );

  it('preserves invalid date and offset behavior', () => {
    expect(getTimes('invalid', 5.5)).toEqual({ fileCreatedAt: {}, localDateTime: {} });
    expect(getTimes('invalid', NaN)).toEqual({ fileCreatedAt: {}, localDateTime: {} });
    expect(() => getTimes('2024-01-01T00:00:00Z', NaN)).toThrow();
    expect(() => getTimes('2024-01-01T00:00:00Z', Infinity)).toThrow();
    expect(() => getTimes('2024-01-01T00:00:00Z', -Infinity)).toThrow();
  });
});
