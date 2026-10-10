/**
 * Cloud backup in the browser (FL-160): the own key made here, the key file and the recovery kit, and
 * the checks of your own bucket's settings. The same formats as the server
 * (server/src/utils/cloud-backup.ts) and the prototype (frameleaf-cloud-data.mjs:840-920): a key file
 * made here restores on any server, and a fingerprint here matches the one the server shows.
 */
import {
  CloudBackupKeyMode,
  CloudBackupRestoreScope,
  CloudBackupRunState,
  CloudBackupTask,
  type CloudBackupStatusResponseDto,
} from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import type { ActivityProgressStage } from '$lib/frameleaf/activity';

/** The marker that claims a bucket for one server. */
export const BUCKET_MARKER = 'frameleaf-backup.json';

export const KEY_FILE_FORMAT = 'frameleaf-backup-key';

/** What own-memory mode asks the administrator to type, compared without case or surrounding spaces. */
export const OWN_MEMORY_ACKNOWLEDGEMENT = 'i understand';

export const isOwnMemoryAcknowledged = (typed: string) => typed.trim().toLowerCase() === OWN_MEMORY_ACKNOWLEDGEMENT;

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);

/** Short display fingerprint (FNV-1a over the key's bytes, `ABCD-1234`), as on the server. */
export const keyFingerprint = (bytes: Uint8Array) => {
  let hash = 0x81_1c_9d_c5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, '0').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
};

export type BackupKey = { key: string; fingerprint: string };

/** A new 256-bit key made in this browser. It leaves the browser only in the file you download and to this server. */
export const createBackupKey = (random: Pick<Crypto, 'getRandomValues'> = crypto): BackupKey => {
  const bytes = new Uint8Array(32);
  random.getRandomValues(bytes);
  return { key: toBase64(bytes), fingerprint: keyFingerprint(bytes) };
};

export const backupKeyFile = (options: {
  key: string;
  fingerprint: string;
  instanceId: string;
  bucket: string;
  mode: CloudBackupKeyMode;
  createdAt?: Date;
}) =>
  JSON.stringify(
    {
      format: KEY_FILE_FORMAT,
      version: 1,
      algorithm: 'AES256 (SSE-C)',
      instanceId: options.instanceId,
      bucket: options.bucket,
      mode: options.mode,
      fingerprint: options.fingerprint,
      key: options.key,
      createdAt: (options.createdAt ?? new Date()).toISOString(),
    },
    null,
    2,
  );

export const keyFileName = (fingerprint: string) => `frameleaf-backup-key-${fingerprint}.json`;

/**
 * The key in a key file, checked against the bucket's fingerprint when one is known. Answers the key or
 * the i18n key of what is wrong; the key itself is never shown.
 */
export const readBackupKeyFile = (
  text: string,
  expectedFingerprint?: string | null,
): { key: string } | { error: Translations } => {
  let parsed: { format?: unknown; key?: unknown };
  try {
    parsed = JSON.parse(text) as { format?: unknown; key?: unknown };
  } catch {
    return { error: 'frameleaf_cloud_backup_key_file_invalid' };
  }
  if (parsed.format !== KEY_FILE_FORMAT || typeof parsed.key !== 'string') {
    return { error: 'frameleaf_cloud_backup_key_file_invalid' };
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(parsed.key);
  } catch {
    return { error: 'frameleaf_cloud_backup_key_file_invalid' };
  }
  if (bytes.length !== 32) {
    return { error: 'frameleaf_cloud_backup_key_file_invalid' };
  }
  if (expectedFingerprint && keyFingerprint(bytes) !== expectedFingerprint) {
    return { error: 'frameleaf_cloud_backup_key_file_other_bucket' };
  }
  return { key: parsed.key };
};

export type BucketSettings = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };

/** What is wrong with each field of your own bucket's settings, as i18n keys; empty when nothing is. */
export const bucketSettingsErrors = (settings: BucketSettings): Partial<Record<keyof BucketSettings, Translations>> => {
  const errors: Partial<Record<keyof BucketSettings, Translations>> = {};
  try {
    const url = new URL(settings.endpoint);
    if (url.protocol !== 'https:') {
      errors.endpoint = 'frameleaf_cloud_backup_endpoint_https';
    } else if (url.username || url.password) {
      errors.endpoint = 'frameleaf_cloud_backup_endpoint_credentials';
    }
  } catch {
    errors.endpoint = 'frameleaf_cloud_backup_endpoint_invalid';
  }
  if (
    !/^[\da-z][\d.a-z-]{1,61}[\da-z]$/.test(settings.bucket) ||
    settings.bucket.includes('..') ||
    /^\d+(\.\d+){3}$/.test(settings.bucket)
  ) {
    errors.bucket = 'frameleaf_cloud_backup_bucket_invalid';
  }
  if (!settings.accessKeyId.trim()) {
    errors.accessKeyId = 'frameleaf_cloud_backup_access_key_missing';
  }
  if (!settings.secretAccessKey) {
    errors.secretAccessKey = 'frameleaf_cloud_backup_secret_missing';
  }
  return errors;
};

/** The recovery kit's text: shown once, downloaded or printed, and holding the key as its recovery code. */
export const recoveryKitText = (lines: {
  heading: string;
  instance: string;
  bucket: string;
  fingerprint: string;
  code: string;
  keep: string;
}) => [lines.heading, '', lines.instance, lines.bucket, lines.fingerprint, '', lines.keep, '', lines.code].join('\n');

/** The storage address without its scheme, for "On s3.example.com". */
export const endpointHost = (endpoint: string | null | undefined) => {
  if (!endpoint) {
    return '';
  }
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
};

/** FL-164: the schedule choices of the prototype's Schedule & retention card, in the server's time zone. */
export const BACKUP_SCHEDULES: ReadonlyArray<{ cron: string; labelKey: Translations }> = [
  { cron: '0 3 * * *', labelKey: 'frameleaf_cloud_backup_schedule_nightly' },
  { cron: '0 */6 * * *', labelKey: 'frameleaf_cloud_backup_schedule_six_hours' },
  { cron: '0 3 * * 0', labelKey: 'frameleaf_cloud_backup_schedule_sundays' },
];

export type RetentionField = 'keepDaily' | 'keepWeekly' | 'keepMonthly';

/** FL-164: the retention inputs, with the bounds the server accepts. */
export const RETENTION_FIELDS: ReadonlyArray<{
  field: RetentionField;
  labelKey: Translations;
  unitKey: Translations;
  min: number;
  max: number;
}> = [
  {
    field: 'keepDaily',
    labelKey: 'frameleaf_cloud_backup_keep_daily',
    unitKey: 'frameleaf_cloud_backup_unit_days',
    min: 1,
    max: 90,
  },
  {
    field: 'keepWeekly',
    labelKey: 'frameleaf_cloud_backup_keep_weekly',
    unitKey: 'frameleaf_cloud_backup_unit_weeks',
    min: 0,
    max: 52,
  },
  {
    field: 'keepMonthly',
    labelKey: 'frameleaf_cloud_backup_keep_monthly',
    unitKey: 'frameleaf_cloud_backup_unit_months',
    min: 0,
    max: 120,
  },
];

/** A retention value typed into its input, or null while it is not a whole number within its bounds. */
export const retentionValue = (field: RetentionField, typed: string): number | null => {
  const bounds = RETENTION_FIELDS.find((entry) => entry.field === field)!;
  const value = Number(typed);
  return typed.trim() !== '' && Number.isSafeInteger(value) && value >= bounds.min && value <= bounds.max
    ? value
    : null;
};

/** FL-164: the bucket Frameleaf Cloud makes for this server, `fl-<region>-<instanceId>`. */
export const managedBucketName = (dataRegion: string | null | undefined, instanceId: string) =>
  `fl-${dataRegion || 'eu'}-${instanceId}`;

/** FL-164: the shortest escrow passphrase the server accepts. */
export const ESCROW_MIN_PASSPHRASE = 12;

/** FL-164: an escrow passphrase typed twice, long enough and the same both times. */
export const isEscrowPassphraseValid = (first: string, second: string) =>
  first.length >= ESCROW_MIN_PASSPHRASE && first === second;

/** What the prototype's restore confirmation asks the administrator to type (FrameleafCloud.jsx). */
export const WHOLE_LIBRARY_CONFIRMATION = 'RESTORE';

/** The steps of a whole-library restore, in the order the prototype lists them (`libraryRestoreSteps`). */
export const LIBRARY_RESTORE_STEPS: ReadonlyArray<{ titleKey: Translations; detailKey: Translations }> = [
  { titleKey: 'frameleaf_cloud_restore_step_database', detailKey: 'frameleaf_cloud_restore_step_database_detail' },
  { titleKey: 'frameleaf_cloud_restore_step_files', detailKey: 'frameleaf_cloud_restore_step_files_detail' },
  { titleKey: 'frameleaf_cloud_restore_step_verify', detailKey: 'frameleaf_cloud_restore_step_verify_detail' },
  { titleKey: 'frameleaf_cloud_restore_step_thumbnails', detailKey: 'frameleaf_cloud_restore_step_thumbnails_detail' },
];

/**
 * The prototype's stage model (activity-feed.mjs): what a person sees a job as. Background work is only
 * ever in progress, so it uses Activity's In progress stages (FL-162), the same words and order.
 */
export type CloudWorkStage = ActivityProgressStage;

/** One read-only row of Activity's background work: a cloud backup operation or restore in progress. */
export type CloudWorkRow = {
  id: string;
  operationId: string;
  titleKey: Translations;
  stage: CloudWorkStage;
  /** Percent, or null while nothing has been counted. */
  progress: number | null;
  /** Files done and in total, when the operation counts them. */
  files: { done: number; total: number | null } | null;
  /** Bytes uploaded or restored so far. */
  bytes: number | null;
};

const stageOf = (state: CloudBackupRunState, progress: number): CloudWorkStage => {
  switch (state) {
    case CloudBackupRunState.Queued: {
      return 'queued';
    }
    case CloudBackupRunState.Paused: {
      return 'paused';
    }
    case CloudBackupRunState.Running:
    case CloudBackupRunState.Pausing:
    case CloudBackupRunState.Cancelling: {
      // a worker holds it but has counted nothing yet: it is still getting the bucket and key ready
      return progress > 0 ? 'running' : 'starting';
    }
  }
};

const TASK_TITLE: Record<CloudBackupTask, Translations> = {
  [CloudBackupTask.Backup]: 'frameleaf_cloud_work_backup',
  [CloudBackupTask.Verify]: 'frameleaf_cloud_work_verify',
  [CloudBackupTask.Prune]: 'frameleaf_cloud_work_prune',
};

const RESTORE_TITLE: Record<CloudBackupRestoreScope, Translations> = {
  [CloudBackupRestoreScope.Files]: 'frameleaf_cloud_work_restore_files',
  [CloudBackupRestoreScope.Asset]: 'frameleaf_cloud_work_restore_asset',
  [CloudBackupRestoreScope.Album]: 'frameleaf_cloud_work_restore_album',
  [CloudBackupRestoreScope.Database]: 'frameleaf_cloud_work_restore_database',
  [CloudBackupRestoreScope.Library]: 'frameleaf_cloud_work_restore_library',
};

/**
 * FL-164: the cloud backup operation and restore in progress, as Activity's read-only background work
 * rows (the prototype's `summariseCloudWork`): queued, starting, running or paused, with files and bytes.
 */
export const cloudWorkRows = (status: CloudBackupStatusResponseDto | null): CloudWorkRow[] => {
  const rows: CloudWorkRow[] = [];
  const run = status?.activeRun;
  if (run) {
    const stage = stageOf(run.state, run.progress);
    rows.push({
      id: 'cloud-backup-run',
      operationId: run.operationId,
      titleKey: TASK_TITLE[run.task],
      stage,
      progress: stage === 'queued' ? null : Math.round(run.progress),
      files:
        run.task === CloudBackupTask.Backup
          ? { done: run.uploaded, total: null }
          : run.task === CloudBackupTask.Verify
            ? { done: run.checked, total: null }
            : null,
      bytes: run.task === CloudBackupTask.Backup ? run.bytesUploaded : null,
    });
  }
  const restore = status?.activeRestore;
  if (restore) {
    const stage = stageOf(restore.state, restore.progress);
    rows.push({
      id: 'cloud-restore-run',
      operationId: restore.operationId,
      titleKey: RESTORE_TITLE[restore.scope],
      stage,
      progress: stage === 'queued' ? null : Math.round(restore.progress),
      files: { done: restore.files, total: restore.filesTotal || null },
      bytes: restore.bytes,
    });
  }
  return rows;
};

/**
 * FL-164: what an administrator can do with a backup operation or restore in progress, as the server
 * allows it (media-operation.repository `requestPause`, `resume`, `requestCancel`): pause while queued
 * or running, resume while paused or pausing (which withdraws the pause), and cancel until cancelling.
 */
export type CloudWorkActions = { pause: boolean; resume: boolean; cancel: boolean };

export const cloudWorkActions = (state: CloudBackupRunState): CloudWorkActions => {
  switch (state) {
    case CloudBackupRunState.Queued:
    case CloudBackupRunState.Running: {
      return { pause: true, resume: false, cancel: true };
    }
    case CloudBackupRunState.Pausing:
    case CloudBackupRunState.Paused: {
      return { pause: false, resume: true, cancel: true };
    }
    case CloudBackupRunState.Cancelling: {
      return { pause: false, resume: false, cancel: false };
    }
  }
};
