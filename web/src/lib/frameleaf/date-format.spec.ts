import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatTime, type DisplayFormat } from './date-format';

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
