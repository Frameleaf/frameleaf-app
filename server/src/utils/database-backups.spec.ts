import { DateTime } from 'luxon';
import {
  PRE_UPGRADE_BACKUP_LABEL,
  findDatabaseBackupVersion,
  getDatabaseBackupTime,
  isDatabaseBackupDumpName,
  isFailedDatabaseBackupName,
  isPreUpgradeBackupName,
  isValidDatabaseBackupName,
  isValidDatabaseRoutineBackupName,
} from 'src/utils/database-backups.js';

const routine = 'frameleaf-db-backup-20261001T101500-v3.1.0-pg19beta4.sql.gz';
const preUpgrade = 'frameleaf-db-backup-20261001T101500-pre-upgrade-v3.2.0-pg19beta4.sql.gz';

describe('database backup names', () => {
  describe('FL-295 pre-upgrade copy', () => {
    it('is labelled pre-upgrade', () => {
      expect(PRE_UPGRADE_BACKUP_LABEL).toBe('pre-upgrade');
    });

    it('is recognised as a pre-upgrade copy, and a routine backup is not', () => {
      expect(isPreUpgradeBackupName(preUpgrade)).toBe(true);
      expect(isPreUpgradeBackupName(routine)).toBe(false);
      expect(isPreUpgradeBackupName(`${preUpgrade}.tmp`)).toBe(false);
      expect(isPreUpgradeBackupName(`restore-point-${preUpgrade}`)).toBe(false);
    });

    it('is a valid backup name, so the backups list shows it and the restore path accepts it', () => {
      expect(isValidDatabaseBackupName(preUpgrade)).toBeTruthy();
    });

    it('is never a routine backup, so rotation (keepLastAmount) never removes it', () => {
      expect(isValidDatabaseRoutineBackupName(preUpgrade)).toBeFalsy();
      expect(isValidDatabaseRoutineBackupName(routine)).toBeTruthy();
    });

    it('carries the server version the restore path reads', () => {
      expect(findDatabaseBackupVersion(preUpgrade)).toBe('3.2.0');
      expect(findDatabaseBackupVersion(routine)).toBe('3.1.0');
    });

    it('is a failed backup while it is still a temporary file', () => {
      expect(isFailedDatabaseBackupName(`${preUpgrade}.tmp`)).toBeTruthy();
    });
  });

  it('recognizes only UUID attempt labels as routine and preserves restore version/time parsing', () => {
    const attempt = 'frameleaf-db-backup-20261001T101500-9278736b-d61f-4b66-8de9-41d17a5e59ca-v3.1.0-pg19.1.sql.gz';
    expect(isValidDatabaseRoutineBackupName(attempt)).toBeTruthy();
    expect(isValidDatabaseBackupName(attempt)).toBeTruthy();
    expect(findDatabaseBackupVersion(attempt)).toBe('3.1.0');
    expect(getDatabaseBackupTime(attempt)?.toISO()).toBe(getDatabaseBackupTime(routine)?.toISO());
    expect(isValidDatabaseRoutineBackupName(`${attempt}.tmp`)).toBeFalsy();
    expect(isValidDatabaseRoutineBackupName(`restore-point-${attempt}`)).toBeFalsy();
    expect(isValidDatabaseRoutineBackupName(`cloud-backup-${attempt}`)).toBeFalsy();
    expect(isValidDatabaseRoutineBackupName(preUpgrade)).toBeFalsy();
  });

  describe('isDatabaseBackupDumpName', () => {
    it.each([
      [routine, true],
      [preUpgrade, true],
      ['frameleaf-db-backup-1753789649000.sql.gz', true],
      [`${routine}.tmp`, false],
      [`restore-point-${routine}`, false],
      [`uploaded-${routine}`, false],
      [`cloud-backup-${routine}`, false],
      ['frameleaf-db-backup-1.sql', false],
      ['.immich', false],
    ])('%s → %s', (filename, expected) => {
      expect(isDatabaseBackupDumpName(filename)).toBe(expected);
    });
  });

  describe('getDatabaseBackupTime', () => {
    it('reads the local timestamp in a current backup name', () => {
      expect(getDatabaseBackupTime(routine)?.toISO()).toBe(
        DateTime.fromObject({ year: 2026, month: 10, day: 1, hour: 10, minute: 15 }).toISO(),
      );
      expect(getDatabaseBackupTime(preUpgrade)?.toISO()).toBe(
        DateTime.fromObject({ year: 2026, month: 10, day: 1, hour: 10, minute: 15 }).toISO(),
      );
    });

    it('reads the epoch milliseconds in an old-style backup name', () => {
      expect(getDatabaseBackupTime('frameleaf-db-backup-1753789649000.sql.gz')?.toMillis()).toBe(1_753_789_649_000);
    });

    it('returns null when the name has no usable timestamp', () => {
      expect(getDatabaseBackupTime('frameleaf-db-backup-20261399T999999-v3.1.0-pg14.sql.gz')).toBeNull();
      expect(getDatabaseBackupTime('frameleaf-db-backup-1.sql.gz')).toBeNull();
      expect(getDatabaseBackupTime('something.sql.gz')).toBeNull();
    });
  });
});
