import { describe, expect, it } from 'vitest';
import {
  brandedArchiveName,
  buildArchiveName,
  formatArchiveDate,
  namedArchiveName,
  sanitizeArchiveSegment,
  withArchiveDetail,
} from './archive-name';

describe('sanitizeArchiveSegment', () => {
  it('returns an empty string for nothing to sanitize', () => {
    expect(sanitizeArchiveSegment(undefined)).toBe('');
    expect(sanitizeArchiveSegment(null)).toBe('');
    expect(sanitizeArchiveSegment('')).toBe('');
    expect(sanitizeArchiveSegment('   ')).toBe('');
  });

  it('folds diacritics instead of dropping the letters that carry them', () => {
    expect(sanitizeArchiveSegment('Café Déjà Vu')).toBe('Cafe-Deja-Vu');
  });

  it('drops characters outside printable ASCII once diacritics are folded off', () => {
    expect(sanitizeArchiveSegment('東京 2026')).toBe('2026');
    expect(sanitizeArchiveSegment('東京')).toBe('');
  });

  it('replaces filesystem-reserved and control characters with a separator', () => {
    expect(sanitizeArchiveSegment('Trips/Rockies: "2026"')).toBe('Trips-Rockies-2026');
    expect(sanitizeArchiveSegment('a<b>c:d"e/f\\g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('collapses whitespace and underscore runs to one hyphen and trims the edges', () => {
    expect(sanitizeArchiveSegment('  spaced   out_name  ')).toBe('spaced-out-name');
    expect(sanitizeArchiveSegment('--already--hyphenated--')).toBe('already-hyphenated');
  });

  it('caps a single segment so it cannot crowd out everything else', () => {
    const long = 'a'.repeat(80);
    expect(sanitizeArchiveSegment(long)).toHaveLength(40);
  });
});

describe('formatArchiveDate', () => {
  it('formats as YYYY-MM-DD, zero-padded', () => {
    expect(formatArchiveDate(new Date(2026, 8, 22))).toBe('2026-09-22');
    expect(formatArchiveDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('buildArchiveName', () => {
  it('joins sanitized, non-empty segments with hyphens', () => {
    expect(buildArchiveName(['Trip to Banff', '2026'], { fallback: 'photos' })).toBe('Trip-to-Banff-2026');
  });

  it('drops empty segments without leaving a gap', () => {
    expect(buildArchiveName(['Album', null, undefined, '', 'Name'], { fallback: 'x' })).toBe('Album-Name');
  });

  it('falls back to the localized fallback when every segment sanitizes away', () => {
    expect(buildArchiveName([undefined, ''], { fallback: 'Photos' })).toBe('Photos');
    expect(buildArchiveName(['東京'], { fallback: 'Photos' })).toBe('Photos');
  });

  it('falls back to the ASCII-safe backstop when the fallback itself sanitizes away', () => {
    expect(buildArchiveName([], { fallback: '東京' })).toBe('frameleaf');
    expect(buildArchiveName([], { fallback: '' })).toBe('frameleaf');
  });

  it('prefixes with the product name when branded', () => {
    expect(buildArchiveName(['Favorites'], { fallback: 'Favorites', brand: true })).toBe('frameleaf-Favorites');
  });

  it('never emits "Immich" or "fork" even as a fallback', () => {
    const result = buildArchiveName([], { fallback: '' });
    expect(result.toLowerCase()).not.toContain('immich');
    expect(result.toLowerCase()).not.toContain('fork');
  });

  it('appends the date when asked, after any brand prefix', () => {
    const now = new Date(2026, 8, 22);
    expect(buildArchiveName(['Search'], { fallback: 'Search', brand: true, withDate: true, now })).toBe(
      'frameleaf-Search-2026-09-22',
    );
  });

  it('caps the final length and never leaves a trailing hyphen', () => {
    const result = buildArchiveName(['a'.repeat(40), 'b'.repeat(40)], { fallback: 'x', maxLength: 50 });
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith('-')).toBe(false);
  });
});

describe('namedArchiveName', () => {
  it('is bare (unbranded) for a named entity', () => {
    expect(namedArchiveName('Rockies 2026', 'Album')).toBe('Rockies-2026');
  });

  it('falls back to the kind label when the name sanitizes away', () => {
    expect(namedArchiveName('東京', 'Album')).toBe('Album');
    expect(namedArchiveName(undefined, 'Person')).toBe('Person');
    expect(namedArchiveName('', 'Person')).toBe('Person');
  });
});

describe('brandedArchiveName', () => {
  it('always carries the product prefix', () => {
    expect(brandedArchiveName('Favorites')).toBe('frameleaf-Favorites');
  });

  it('appends extra descriptive segments after the label', () => {
    expect(brandedArchiveName('Search', ['sunset beach'])).toBe('frameleaf-Search-sunset-beach');
  });

  it('ignores empty extra segments', () => {
    expect(brandedArchiveName('Photos', [undefined, '', null])).toBe('frameleaf-Photos');
  });
});

describe('withArchiveDetail', () => {
  it('appends detail onto an already-built name', () => {
    expect(withArchiveDetail('frameleaf-Photos', 'Rockies 2026')).toBe('frameleaf-Photos-Rockies-2026');
  });

  it('is a no-op when every detail is empty', () => {
    expect(withArchiveDetail('frameleaf-Photos', undefined, '')).toBe('frameleaf-Photos');
  });

  it('re-sanitizes the base, so it stays safe to call twice', () => {
    expect(withArchiveDetail('frameleaf-Photos', 'A', 'B')).toBe('frameleaf-Photos-A-B');
  });
});
