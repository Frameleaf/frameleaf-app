import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDateString, asDateTimeString } from 'src/utils/date.js';

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
