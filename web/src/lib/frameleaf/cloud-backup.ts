/**
 * Cloud backup in the browser (FL-160): the own key made here, the key file and the recovery kit, and
 * the checks of your own bucket's settings. The same formats as the server
 * (server/src/utils/cloud-backup.ts) and the prototype (frameleaf-cloud-data.mjs:840-920): a key file
 * made here restores on any server, and a fingerprint here matches the one the server shows.
 */
import { CloudBackupKeyMode } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

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
