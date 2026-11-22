import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  OCCASION_REGIONS,
  easterSunday,
  occasionDate,
  occasionOn,
  regionFromLocale,
  resolveOccasionRegion,
} from 'src/utils/occasions.js';

describe('occasions (FL-880)', () => {
  describe('easterSunday', () => {
    it.each([
      [2008, '2008-03-23'], // the earliest in a century
      [2011, '2011-04-24'],
      [2024, '2024-03-31'],
      [2025, '2025-04-20'],
      [2026, '2026-04-05'],
      [2027, '2027-03-28'],
      [2038, '2038-04-25'], // the latest possible
      [2285, '2285-03-22'], // the earliest possible
    ])('%i is %s', (year, expected) => {
      expect(easterSunday(year).toFormat('yyyy-MM-dd')).toBe(expected);
    });
  });

  describe('occasionDate', () => {
    it.each([
      ['us-ca', 2024, '2024-05-12', '2024-06-16'],
      ['us-ca', 2026, '2026-05-10', '2026-06-21'],
      ['us-ca', 2027, '2027-05-09', '2027-06-20'],
      // a month that starts on a Sunday: the first of the month counts
      ['us-ca', 2022, '2022-05-08', '2022-06-19'],
      ['uk-ie', 2008, '2008-03-02', '2008-06-15'],
      ['uk-ie', 2024, '2024-03-10', '2024-06-16'],
      ['uk-ie', 2026, '2026-03-15', '2026-06-21'],
      ['uk-ie', 2038, '2038-04-04', '2038-06-20'],
      ['au-nz', 2026, '2026-05-10', '2026-09-06'],
      ['de', 2026, '2026-05-10', '2026-05-14'],
      ['de', 2038, '2038-05-09', '2038-06-03'],
      ['fr', 2026, '2026-05-31', '2026-06-21'],
      ['es-pt', 2026, '2026-05-03', '2026-03-19'],
      ['mx', 2026, '2026-05-10', '2026-06-21'],
      ['mx', 2027, '2027-05-10', '2027-06-20'],
      ['se', 2026, '2026-05-31', '2026-11-08'],
    ] as const)('%s in %i: %s and %s', (region, year, mother, father) => {
      expect(occasionDate(region, 'mothers_day', year)).toBe(mother);
      expect(occasionDate(region, 'fathers_day', year)).toBe(father);
    });

    it("moves French Mother's Day to the first Sunday of June when the last Sunday of May is Pentecost", () => {
      // Easter 2028 is April 16, so Pentecost is June 4; Easter 2023 is April 9, so Pentecost is May 28
      expect(occasionDate('fr', 'mothers_day', 2023)).toBe('2023-06-04');
      expect(occasionDate('fr', 'mothers_day', 2028)).toBe('2028-05-28');
    });

    it('keeps every Sunday occasion on a Sunday, across regions and years', () => {
      for (let year = 2000; year <= 2100; year++) {
        for (const region of OCCASION_REGIONS) {
          if (region !== 'mx') {
            expect(DateTime.fromISO(occasionDate(region, 'mothers_day', year)).weekday).toBe(7);
          }
        }
        expect(DateTime.fromISO(occasionDate('de', 'fathers_day', year)).weekday).toBe(4);
      }
    });
  });

  describe('occasionOn', () => {
    it('names the day only in the region that keeps it', () => {
      expect(occasionOn('us-ca', '2026-05-10')).toBe('mothers_day');
      expect(occasionOn('uk-ie', '2026-05-10')).toBeUndefined();
      expect(occasionOn('uk-ie', '2026-03-15')).toBe('mothers_day');
      expect(occasionOn('us-ca', '2026-06-21')).toBe('fathers_day');
      expect(occasionOn('au-nz', '2026-06-21')).toBeUndefined();
      expect(occasionOn('us-ca', '2026-05-11')).toBeUndefined();
    });
  });

  describe('regionFromLocale', () => {
    it.each([
      ['en', 'us-ca'],
      ['en-US', 'us-ca'],
      ['en-CA', 'us-ca'],
      ['fr-CA', 'us-ca'],
      ['en-GB', 'uk-ie'],
      ['en_IE', 'uk-ie'],
      ['en-AU', 'au-nz'],
      ['en-NZ', 'au-nz'],
      ['de', 'de'],
      ['de-DE', 'de'],
      ['fr', 'fr'],
      ['es', 'es-pt'],
      ['pt-PT', 'es-pt'],
      ['es-MX', 'mx'],
      ['sv', 'se'],
      ['zh-Hant-TW', 'us-ca'],
      ['pt-BR', 'us-ca'],
      ['', 'us-ca'],
    ] as const)('%s uses %s', (locale, region) => {
      expect(regionFromLocale(locale)).toBe(region);
    });

    it('uses the first region without a locale', () => {
      expect(regionFromLocale()).toBe('us-ca');
      expect(regionFromLocale(null)).toBe('us-ca');
    });
  });

  describe('resolveOccasionRegion', () => {
    it("keeps the person's choice over their locale", () => {
      expect(resolveOccasionRegion('uk-ie', 'en-US')).toBe('uk-ie');
    });

    it('follows the locale on auto, or for a value it does not know', () => {
      expect(resolveOccasionRegion('auto', 'en-GB')).toBe('uk-ie');
      expect(resolveOccasionRegion('atlantis', 'de')).toBe('de');
      expect(resolveOccasionRegion(undefined, 'sv')).toBe('se');
    });
  });
});
