import type { MessageFormatter } from 'svelte-i18n';
import {
  approximateGroupDay,
  dateAccuracyOf,
  formatApproximateDate,
  groupDayAccuracy,
  parseApproximateYear,
  periodStartIso,
} from '$lib/frameleaf/approximate-date';

const words: Record<string, string> = {
  frameleaf_date_circa_decade: 'circa {decade}s',
  frameleaf_date_circa_decade_heading: 'Circa {decade}s',
};
const $t = ((key: string, options?: { values?: Record<string, string> }) =>
  (words[key] ?? key).replaceAll('{decade}', () => options?.values?.decade ?? '')) as unknown as MessageFormatter;

describe('formatApproximateDate (FL-936)', () => {
  it('says the year, or circa the decade, with a capital in a heading', () => {
    expect(formatApproximateDate('1975-01-01T00:00:00.000Z', 'year', 'en', { $t })).toBe('1975');
    expect(formatApproximateDate('1970-01-01T00:00:00.000Z', 'decade', 'en', { $t })).toBe('circa 1970s');
    expect(formatApproximateDate(1970, 'decade', 'en', { heading: true, $t })).toBe('Circa 1970s');
  });

  it('reads the stored year as written, whatever the browser zone', () => {
    expect(formatApproximateDate(new Date('1980-01-01T00:00:00.000Z'), 'year', 'en', { $t })).toBe('1980');
    expect(formatApproximateDate({ year: 1984 }, 'decade', 'en', { $t })).toBe('circa 1980s');
  });

  it('is null for an exact date and an accuracy this version does not know', () => {
    expect(formatApproximateDate('1975-06-01T00:00:00.000Z', null, 'en', { $t })).toBeNull();
    expect(formatApproximateDate('1975-06-01T00:00:00.000Z', undefined, 'en', { $t })).toBeNull();
    expect(formatApproximateDate('1975-06-01T00:00:00.000Z', 'century', 'en', { $t })).toBeNull();
    expect(dateAccuracyOf('century')).toBeNull();
  });
});

describe('approximate date values (FL-936)', () => {
  it('saves the first instant of the period in UTC', () => {
    expect(periodStartIso(1975, 'year')).toBe('1975-01-01T00:00:00.000Z');
    expect(periodStartIso(1975, 'decade')).toBe('1970-01-01T00:00:00.000Z');
  });

  it('takes a four-digit year from 1800 to this year', () => {
    expect(parseApproximateYear('1975', 2026)).toBe(1975);
    expect(parseApproximateYear(' 1800 ', 2026)).toBe(1800);
    for (const value of ['1799', '2027', '197', '19755', 'abc', '', null]) {
      expect(parseApproximateYear(value, 2026)).toBeNull();
    }
  });

  it('keeps the year and decade groups apart from every calendar day', () => {
    expect(groupDayAccuracy(approximateGroupDay('year'))).toBe('year');
    expect(groupDayAccuracy(approximateGroupDay('decade'))).toBe('decade');
    expect(groupDayAccuracy(1)).toBeNull();
  });
});
