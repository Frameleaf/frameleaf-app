import { DateTime } from 'luxon';

export function isValidDatabaseBackupName(filename: string) {
  return filename.match(/^[\d\w-.]+\.sql(?:\.gz)?$/);
}

export function isValidDatabaseRoutineBackupName(filename: string) {
  const oldBackupStyle = filename.match(/^frameleaf-db-backup-\d+\.sql\.gz$/);
  //frameleaf-db-backup-20250729T114018-v1.136.0-pg14.17.sql.gz
  const newBackupStyle = filename.match(/^frameleaf-db-backup-\d{8}T\d{6}-v.*-pg.*\.sql\.gz$/);
  return oldBackupStyle || newBackupStyle;
}

/**
 * FL-160: the dumps a cloud backup run makes for the bucket (`cloud-backup-frameleaf-db-backup-…`), and
 * their unfinished `.tmp` files. They are the run's own temporary files: removed once uploaded, or by the
 * next run, and never offered for a restore on this server.
 */
export const CLOUD_BACKUP_DUMP_PREFIX = 'cloud-backup-';

export function isCloudBackupDumpName(filename: string) {
  return filename.startsWith(`${CLOUD_BACKUP_DUMP_PREFIX}frameleaf-db-backup-`);
}

export function isFailedDatabaseBackupName(filename: string) {
  return filename.match(/^frameleaf-db-backup-.*\.sql\.gz\.tmp$/);
}

/**
 * FL-295: the safety copy the first Frameleaf start takes of a library the official server created,
 * before anything upgrades it. It keeps the `frameleaf-db-backup-<timestamp>-…` shape so the existing
 * backup tools (Frameleaf's and the official server's) list and restore it, with `pre-upgrade` between
 * the timestamp and the version. That also keeps it out of the routine-backup pattern above, so the
 * rotation (`keepLastAmount`) of either server never removes it.
 */
export const PRE_UPGRADE_BACKUP_LABEL = 'pre-upgrade';

export function isPreUpgradeBackupName(filename: string) {
  return /^frameleaf-db-backup-\d{8}T\d{6}-pre-upgrade-v.*-pg.*\.sql\.gz$/.test(filename);
}

/** A finished database dump made by a server's own backup (routine or pre-upgrade), not a restore point or upload. */
export function isDatabaseBackupDumpName(filename: string) {
  return /^frameleaf-db-backup-.+\.sql\.gz$/.test(filename);
}

/**
 * When a backup was taken, from its name: the local `yyyyLLdd'T'HHmmss` timestamp of a current name,
 * or the epoch milliseconds of an old-style one. Null when the name carries no usable timestamp.
 */
export function getDatabaseBackupTime(filename: string): DateTime | null {
  const current = /^frameleaf-db-backup-(\d{8}T\d{6})-/.exec(filename)?.[1];
  if (current) {
    const time = DateTime.fromFormat(current, "yyyyLLdd'T'HHmmss");
    return time.isValid ? time : null;
  }

  const legacy = /^frameleaf-db-backup-(\d{13})\.sql\.gz$/.exec(filename)?.[1];
  if (legacy) {
    const time = DateTime.fromMillis(Number(legacy));
    return time.isValid ? time : null;
  }

  return null;
}

export function findDatabaseBackupVersion(filename: string) {
  return /-v(.*)-/.exec(filename)?.[1];
}

export class UnsupportedPostgresError extends Error {
  constructor(databaseVersion: string) {
    super(`Unsupported PostgreSQL version: ${databaseVersion}`);
  }
}
