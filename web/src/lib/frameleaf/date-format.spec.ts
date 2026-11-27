import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { formatDate, formatDateTime, formatLuxon, formatTime, type DisplayFormat } from './date-format';

const date = new Date('2026-11-01T14:30:00Z');
const UTC = { timeZone: 'UTC' };
const as = (
  dateFormat: DisplayFormat['dateFormat'],
  hourCycle: DisplayFormat['hourCycle'] = 'auto',
): DisplayFormat => ({
  dateFormat,
  hourCycle,
});

describe('date-format', () => {
  it('gives exactly the Intl output when both choices are automatic', () => {
    for (const locale of ['en-US', 'de-DE', 'ja-JP']) {
      for (const options of [
        { dateStyle: 'medium', timeStyle: 'short' },
        { dateStyle: 'full' },
        { year: 'numeric', month: '2-digit', day: '2-digit' },
        { hour: 'numeric', minute: '2-digit' },
        { month: 'long', year: 'numeric' },
      ] as Intl.DateTimeFormatOptions[]) {
        expect(formatDateTime(date, { ...options, ...UTC }, locale, as('auto'))).toBe(
          new Intl.DateTimeFormat(locale, { ...options, ...UTC }).format(date),
        );
      }
    }
  });

  it('writes numeric dates in the chosen order in every language', () => {
    const numeric = { year: 'numeric', month: 'numeric', day: 'numeric', ...UTC } as const;
    for (const locale of ['en-US', 'de-DE', 'ja-JP']) {
      expect(formatDate(date, numeric, locale, as('iso'))).toBe('2026-11-01');
      expect(formatDate(date, numeric, locale, as('dmy'))).toBe('01/11/2026');
      expect(formatDate(date, numeric, locale, as('mdy'))).toBe('11/01/2026');
    }
  });

  it('keeps month and day names in the language', () => {
    const full = { dateStyle: 'full', ...UTC } as const;
    expect(formatDate(date, full, 'en-US', as('dmy'))).toBe('Sunday, 1 November 2026');
    expect(formatDate(date, full, 'en-US', as('mdy'))).toBe('Sunday, November 1, 2026');
    expect(formatDate(date, full, 'de-DE', as('dmy'))).toBe('Sonntag, 1 November 2026');
    expect(formatDate(date, { dateStyle: 'medium', ...UTC }, 'en-US', as('iso'))).toBe('2026-11-01');
    expect(formatDate(date, { month: 'short', day: 'numeric', ...UTC }, 'en-US', as('dmy'))).toBe('1 Nov');
  });

  it("keeps the locale's own digits in a written-out date", () => {
    const text = formatDate(date, { dateStyle: 'long', ...UTC }, 'ar-EG', as('dmy'));
    expect(text).not.toContain('NaN');
    expect(text.startsWith('١ ')).toBe(true);
  });

  it('leaves a date without a day to the language', () => {
    const monthYear = { month: 'long', year: 'numeric', ...UTC } as const;
    expect(formatDate(date, monthYear, 'en-US', as('dmy'))).toBe('November 2026');
  });

  it('sets the clock independently of the language', () => {
    expect(formatTime(date, { timeStyle: 'short', ...UTC }, 'de-DE', as('auto', 'h12'))).toMatch(/2:30\s?PM/i);
    expect(formatTime(date, { timeStyle: 'short', ...UTC }, 'en-US', as('auto', 'h23'))).toBe('14:30');
    expect(
      formatTime(date, { hour: 'numeric', minute: '2-digit', hour12: true, ...UTC }, 'en-US', as('auto', 'h23')),
    ).toBe('14:30');
    expect(formatTime(date, { timeStyle: 'short', ...UTC }, 'ja-JP', as('auto', 'h23'))).toBe('14:30');
  });

  it('joins a reordered date with its time', () => {
    expect(formatDateTime(date, { dateStyle: 'medium', timeStyle: 'short', ...UTC }, 'en-US', as('iso', 'h23'))).toBe(
      '2026-11-01 14:30',
    );
    expect(formatDateTime(date, { dateStyle: 'medium', timeStyle: 'short', ...UTC }, 'en-US', as('dmy', 'h23'))).toBe(
      '1 Nov 2026, 14:30',
    );
  });

  it('gives an empty string for an invalid date', () => {
    expect(formatDate('not a date', undefined, 'en-US', as('iso'))).toBe('');
  });
});

describe('a Luxon date and the shared formatters (FL-1805)', () => {
  const auto: DisplayFormat = { dateFormat: 'auto', hourCycle: 'auto' };

  it('reads as Luxon wrote it while the format is auto, in the date’s own zone', () => {
    for (const zone of ['UTC', 'America/Edmonton', 'UTC+2', 'Asia/Kolkata']) {
      const value = DateTime.fromISO('2026-11-01T23:30:00', { zone, locale: 'en-US' });
      for (const preset of [DateTime.DATE_MED, DateTime.DATE_MED_WITH_WEEKDAY, DateTime.DATETIME_MED]) {
        // Luxon joins the engine's parts, which keep the narrow no-break space before "PM" that the
        // engine's own `format` writes as a plain space; the words and digits are the same.
        expect(formatLuxon(value, preset, 'en-US', auto), zone).toBe(
          value.toLocaleString(preset).replaceAll('\u{202F}', ' '),
        );
      }
    }
  });

  it('keeps the year of a photo dated before the year 100', () => {
    const value = DateTime.fromObject({ year: 1, month: 3, day: 4 }, { zone: 'UTC' });
    expect(formatLuxon(value, { year: 'numeric', month: 'long', day: 'numeric' }, 'en-US', auto)).toBe('March 4, 1');
    expect(formatLuxon(DateTime.invalid('unparsable'), DateTime.DATE_MED, 'en-US', auto)).toBe('');
  });

  it('builds a formatter once per locale and set of options', () => {
    const constructor = vi.spyOn(Intl, 'DateTimeFormat');
    const options = { dateStyle: 'full', timeZone: 'Pacific/Chatham' } as const;
    const first = formatDate(new Date(Date.UTC(2026, 10, 1)), options, 'en-NZ', auto);
    for (let day = 2; day < 50; day++) {
      formatDate(new Date(Date.UTC(2026, 10, day)), options, 'en-NZ', auto);
    }
    expect(constructor.mock.calls.filter(([, given]) => given?.timeZone === 'Pacific/Chatham')).toHaveLength(1);
    expect(first).toBe(new Intl.DateTimeFormat('en-NZ', options).format(new Date(Date.UTC(2026, 10, 1))));
    constructor.mockRestore();
  });
});
