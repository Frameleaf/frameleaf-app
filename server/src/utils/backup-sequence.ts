/**
 * FL-362: backups run from one schedule, one after another. The copy of the library data on this
 * server goes first, then Buddy Backup, then Cloud Backup; each starts when the one before it has
 * finished, and a place that is switched off is left out. This module is the order and the rules; the
 * service (`BackupSequenceService`) does the work.
 */

/** The places a backup is kept, in the order a run visits them. */
export const BACKUP_SEQUENCE = ['local', 'buddy', 'cloud'] as const;
export type BackupSequencePlace = (typeof BACKUP_SEQUENCE)[number];

export type BackupSequenceRun = {
  startedAt: string;
  /** The place the run has reached. */
  place: BackupSequencePlace;
  /** Its backup has been started; the run waits for it to finish before moving on. */
  begun: boolean;
  /** What each place the run has left behind did. */
  results: Partial<Record<BackupSequencePlace, 'done' | 'off' | 'failed'>>;
};

export type BackupSequenceState = {
  run: BackupSequenceRun | null;
  /** The schedule came round while a run was still going: another starts when this one ends. */
  dueAt?: string | null;
  /** When the last run ended. */
  finishedAt?: string | null;
};

/** The schedule a server had before there was one for every backup, as far as it was set up. */
export type StoredBackupSchedules = {
  /** The library data copy: always stored, used only while it is on. */
  database: { enabled: boolean; cronExpression: string };
  /** Buddy Backup's own schedule, when Buddy Backup is set up. */
  buddy?: string | null;
  /** Cloud Backup's own schedule, when Cloud Backup is on. */
  cloud?: string | null;
};

/**
 * The one schedule of a server that has not chosen one yet, from what it stored before: the schedule
 * of the first place in the run's order that is in use, so the night starts when it used to. A server
 * with nothing in use keeps the library data copy's time for the day something is turned on.
 */
export const deriveBackupSchedule = (stored: StoredBackupSchedules): string =>
  (stored.database.enabled ? stored.database.cronExpression : null) ||
  stored.buddy ||
  stored.cloud ||
  stored.database.cronExpression;

/** The schedule in force: the one chosen in Backup settings, else the one derived from before. */
export const effectiveBackupSchedule = (chosen: string | null | undefined, stored: StoredBackupSchedules): string =>
  chosen?.trim() || deriveBackupSchedule(stored);

/** The place after `place` in a run, or null after the last. */
export const nextBackupPlace = (place: BackupSequencePlace): BackupSequencePlace | null =>
  BACKUP_SEQUENCE[BACKUP_SEQUENCE.indexOf(place) + 1] ?? null;
