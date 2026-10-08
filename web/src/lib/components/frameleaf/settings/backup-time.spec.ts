import { DateTime, Settings } from 'luxon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupStamp, backupTime } from '$lib/components/frameleaf/settings/backup-time';

describe('backupTime', () => {
  const previousZone = Settings.defaultZone;

  beforeEach(() => {
    Settings.defaultZone = 'UTC';
  });

  afterEach(() => {
    Settings.defaultZone = previousZone;
  });

  it('reads the stamp in the zone the server reported and shows it in the viewer time', () => {
    const time = backupTime('immich-db-backup-20260919T020000-v3.sql.gz', {
      timezone: 'America/Edmonton',
      locale: 'en-GB',
      now: DateTime.fromISO('2026-10-08T00:00:00Z'),
    });
    expect(time?.at.toUTC().toISO()).toBe('2026-09-19T08:00:00.000Z');
    expect(time?.time).toBe('08:00');
    expect(time?.date).toBe('19 Sept');
    expect(time?.label).toBe('19 Sept, 08:00');
  });

  it('reads the clock as the viewer own when no zone is reported or the zone is unknown', () => {
    const now = DateTime.fromISO('2026-10-08T00:00:00Z');
    expect(backupTime('immich-db-backup-20260919T020000-v3.sql.gz', { locale: 'en-GB', now })?.time).toBe('02:00');
    expect(
      backupTime('immich-db-backup-20260919T020000-v3.sql.gz', { timezone: 'Not/AZone', locale: 'en-GB', now })?.time,
    ).toBe('02:00');
  });

  it('adds the year only when the backup is from another year', () => {
    const now = DateTime.fromISO('2026-10-08T00:00:00Z');
    expect(backupTime('immich-db-backup-20251219T020000-v3.sql.gz', { locale: 'en-GB', now })?.date).toBe(
      '19 Dec 2025',
    );
  });

  it('is undefined for a name without a stamp', () => {
    expect(backupTime('uploaded.sql.gz')).toBeUndefined();
    expect(backupStamp('uploaded.sql.gz')).toBeUndefined();
    expect(backupStamp('immich-db-backup-20260919T020000-v3.sql.gz')).toBe('20260919T020000');
  });
});
