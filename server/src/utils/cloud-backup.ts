import { createHash } from 'node:crypto';
import type { CloudBackupKeyMode } from 'src/types.js';

/**
 * Cloud backup (FL-160): the bucket layout, the bucket key's formats and the checks every part of the
 * backup agent shares. Nothing here reads a file or talks to a provider.
 *
 * Bucket layout (cloud backup service contract): `frameleaf-backup.json` (the claim), `db/<file>`
 * database dumps, `o/<sha256>` one object per unique file, `m/<ISO>.json.gz` one manifest per run.
 */

/** The root marker that claims a bucket for one server. */
export const CLOUD_BACKUP_MARKER = 'frameleaf-backup.json';
export const CLOUD_BACKUP_DB_PREFIX = 'db/';
export const CLOUD_BACKUP_OBJECT_PREFIX = 'o/';
export const CLOUD_BACKUP_MANIFEST_PREFIX = 'm/';
/** Where the capability check writes its throwaway test file (and deletes it again). */
export const CLOUD_BACKUP_PROBE_PREFIX = 'frameleaf-backup-probe/';
/** Multipart part size; files up to this size go up in one PUT. */
export const CLOUD_BACKUP_PART_BYTES = 8 * 1024 * 1024;
/** Assets between two cursor writes. */
export const CLOUD_BACKUP_BATCH = 25;
/** Database dumps kept in the bucket; older ones are removed after a new one is uploaded. */
export const CLOUD_BACKUP_DB_DUMPS_KEPT = 7;
/** A bucket key is 256 bits (SSE-C AES256). */
export const CLOUD_BACKUP_KEY_BYTES = 32;
/** The typed acknowledgement own-memory mode needs. */
export const CLOUD_BACKUP_OWN_MEMORY_ACKNOWLEDGEMENT = 'i understand';

export const CLOUD_BACKUP_KEY_FILE_FORMAT = 'frameleaf-backup-key';
export const CLOUD_BACKUP_MARKER_FORMAT = 'frameleaf-backup';
export const CLOUD_BACKUP_MANIFEST_FORMAT = 'frameleaf-backup-manifest';

const HEX_SHA256 = /^[\da-f]{64}$/;

export const isSha256Hex = (value: string) => HEX_SHA256.test(value);

export const objectKey = (sha256: string) => {
  if (!isSha256Hex(sha256)) {
    throw new Error('A backup object is named by a lowercase hex SHA-256');
  }
  return `${CLOUD_BACKUP_OBJECT_PREFIX}${sha256}`;
};

/** ISO 8601 basic format in UTC, `20260926T030000Z`: sorts by time and needs no escaping. */
export const compactIso = (date: Date) =>
  date
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

export const manifestKey = (date: Date) => `${CLOUD_BACKUP_MANIFEST_PREFIX}${compactIso(date)}.json.gz`;

/** The claimed bucket's address, the index key in `cloud_backup_object`. */
export const bucketRef = (endpoint: string, bucket: string) => `${endpoint.replace(/\/+$/, '')}/${bucket}`;

/**
 * Short display fingerprint of a key (FNV-1a over its bytes, `ABCD-1234`), the same function the
 * prototype and the browser use, so a key file can be matched to its bucket anywhere. Thirty-two bits
 * of a 256-bit key reveal nothing useful about it.
 */
export const keyFingerprint = (key: Uint8Array) => {
  let hash = 0x81_1c_9d_c5;
  for (const byte of key) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, '0').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
};

/** The SSE-C headers every PUT, GET, HEAD, UploadPart and CompleteMultipartUpload carries. */
export const sseCustomerHeaders = (key: Buffer): Record<string, string> => {
  if (key.length !== CLOUD_BACKUP_KEY_BYTES) {
    throw new Error('A bucket key is 256 bits');
  }
  return {
    'x-amz-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-server-side-encryption-customer-key': key.toString('base64'),
    'x-amz-server-side-encryption-customer-key-md5': createHash('md5').update(key).digest('base64'),
  };
};

// Crockford base32: no I, L, O or U, so a written-down code is hard to misread.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_PREFIX = 'FLRK';

/** The bucket key as a recovery code for the recovery kit: `FLRK-XXXX-…` (52 symbols in 13 groups). */
export const recoveryCode = (key: Buffer) => {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) {
    output += RECOVERY_ALPHABET[(value << (5 - bits)) & 31];
  }
  return [RECOVERY_PREFIX, ...(output.match(/.{1,4}/g) ?? [])].join('-');
};

const decodeRecoveryCode = (code: string): Buffer | null => {
  const symbols = code
    .toUpperCase()
    .replaceAll(/[\s-]/g, '')
    .replace(/^FLRK/, '')
    .replaceAll('O', '0')
    .replaceAll(/[IL]/g, '1');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const symbol of symbols) {
    const index = RECOVERY_ALPHABET.indexOf(symbol);
    if (index === -1) {
      return null;
    }
    value = ((value << 5) | index) & 0xff_ff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length === CLOUD_BACKUP_KEY_BYTES ? Buffer.from(bytes) : null;
};

/**
 * A bucket key as an administrator can give it: the key file's JSON, the base64 key, or the recovery
 * kit's code. Anything else, or anything that is not 256 bits, is refused. The value is never echoed.
 */
export const parseBackupKey = (input: string): Buffer => {
  const text = input.trim();
  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('This is not a Frameleaf backup key file.');
    }
    const file = parsed as { format?: unknown; key?: unknown };
    if (file.format !== CLOUD_BACKUP_KEY_FILE_FORMAT || typeof file.key !== 'string') {
      throw new Error('This is not a Frameleaf backup key file.');
    }
    return parseBackupKey(file.key);
  }

  if (/^flrk[\s-]/i.test(text)) {
    const decoded = decodeRecoveryCode(text);
    if (!decoded) {
      throw new Error('This recovery code is not complete. Check it against the recovery kit.');
    }
    return decoded;
  }

  if (/^[\d+/A-Za-z]{43}=$/.test(text)) {
    return Buffer.from(text, 'base64');
  }
  throw new Error('Enter the key file, the key or the recovery code from the recovery kit.');
};

/** The key file an administrator downloads or the server keeps (0600) for the stored key modes. */
export type CloudBackupKeyFile = {
  format: typeof CLOUD_BACKUP_KEY_FILE_FORMAT;
  version: 1;
  algorithm: 'AES256 (SSE-C)';
  instanceId: string;
  bucket: string;
  mode: CloudBackupKeyMode;
  fingerprint: string;
  key: string;
  createdAt: string;
};

export const backupKeyFile = (options: {
  key: Buffer;
  instanceId: string;
  bucket: string;
  mode: CloudBackupKeyMode;
  createdAt: Date;
}): CloudBackupKeyFile => ({
  format: CLOUD_BACKUP_KEY_FILE_FORMAT,
  version: 1,
  algorithm: 'AES256 (SSE-C)',
  instanceId: options.instanceId,
  bucket: options.bucket,
  mode: options.mode,
  fingerprint: keyFingerprint(options.key),
  key: options.key.toString('base64'),
  createdAt: options.createdAt.toISOString(),
});

/** The claim written to the bucket root. It is encrypted like every other object. */
export type CloudBackupMarker = {
  format: typeof CLOUD_BACKUP_MARKER_FORMAT;
  version: 1;
  instanceId: string;
  keyFingerprint: string;
  claimedAt: string;
};

export const parseMarker = (body: Buffer): CloudBackupMarker | null => {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as Partial<CloudBackupMarker>;
    if (parsed.format !== CLOUD_BACKUP_MARKER_FORMAT || typeof parsed.instanceId !== 'string') {
      return null;
    }
    return {
      format: CLOUD_BACKUP_MARKER_FORMAT,
      version: 1,
      instanceId: parsed.instanceId,
      keyFingerprint: typeof parsed.keyFingerprint === 'string' ? parsed.keyFingerprint : '',
      claimedAt: typeof parsed.claimedAt === 'string' ? parsed.claimedAt : '',
    };
  } catch {
    return null;
  }
};

/**
 * The problem with your own bucket's settings, in plain words, or null. SSE-C needs HTTPS, so the
 * storage address must be an HTTPS URL without credentials in it.
 */
export const s3SettingsProblem = (s3: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): string | null => {
  let url: URL;
  try {
    url = new URL(s3.endpoint);
  } catch {
    return 'Enter the storage address, for example https://s3.eu-central-2.wasabisys.com.';
  }
  if (url.protocol !== 'https:') {
    return 'Encrypted uploads with your key (SSE-C) need an HTTPS storage address.';
  }
  if (url.username || url.password || url.search || url.hash) {
    return 'Keep credentials and options out of the storage address.';
  }
  if (
    !/^[\da-z][\d.a-z-]{1,61}[\da-z]$/.test(s3.bucket) ||
    s3.bucket.includes('..') ||
    /^\d+(\.\d+){3}$/.test(s3.bucket)
  ) {
    return 'Bucket names use 3–63 lowercase letters, numbers, dots or hyphens.';
  }
  if (!s3.accessKeyId.trim()) {
    return 'Enter the access key ID.';
  }
  if (!s3.secretAccessKey) {
    return 'Enter the secret access key.';
  }
  return null;
};

/** The signing region: the configured one, else read from a `s3.<region>.` storage address, else us-east-1. */
export const signingRegion = (endpoint: string, configured: string) => {
  if (configured.trim()) {
    return configured.trim();
  }
  try {
    // s3.<region>.…, s3-<region>.…, s3.dualstack.<region>.… and <bucket>.s3.<region>.…
    const match = /(?:^|\.)s3(?:[.-]dualstack)?[.-]([\da-z-]+)\./.exec(new URL(endpoint).hostname);
    if (match && match[1] !== 'amazonaws' && match[1] !== 'dualstack') {
      return match[1];
    }
  } catch {
    // an invalid address is refused elsewhere
  }
  return 'us-east-1';
};

/** One file a manifest records. */
export type CloudBackupManifestFile = {
  role: string;
  path: string;
  sha256: string;
  size: number;
  mtime: string | null;
};

/** The manifest written to `m/<ISO>.json.gz`: asset id → its files, plus profile images and the dump. */
export type CloudBackupManifest = {
  format: typeof CLOUD_BACKUP_MANIFEST_FORMAT;
  version: 1;
  instanceId: string;
  createdAt: string;
  database: { key: string; sha256: string; size: number } | null;
  assets: Record<string, { owner: string | null; files: CloudBackupManifestFile[] }>;
  profiles: Record<string, CloudBackupManifestFile>;
};

/** What a run has done so far, kept on the `media_operation` row as its result. */
export type CloudBackupRunResult = {
  phase: 'database' | 'reconcile' | 'assets' | 'profiles' | 'manifest' | 'done';
  manifestId: string | null;
  manifestKey: string | null;
  cursor: string | null;
  database: { key: string; sha256: string; size: number } | null;
  uploaded: number;
  skipped: number;
  missing: number;
  changed: number;
  bytesUploaded: number;
  assets: number;
  total: number | null;
};

export const emptyRunResult = (): CloudBackupRunResult => ({
  phase: 'database',
  manifestId: null,
  manifestKey: null,
  cursor: null,
  database: null,
  uploaded: 0,
  skipped: 0,
  missing: 0,
  changed: 0,
  bytesUploaded: 0,
  assets: 0,
  total: null,
});

const PHASES: ReadonlySet<CloudBackupRunResult['phase']> = new Set([
  'database',
  'reconcile',
  'assets',
  'profiles',
  'manifest',
  'done',
]);

const count = (value: unknown) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

/** A run's recorded result read back; anything missing or malformed starts from the beginning. */
export const parseRunResult = (value: unknown): CloudBackupRunResult => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyRunResult();
  }
  const result = value as Record<string, unknown>;
  const phase = PHASES.has(result.phase as CloudBackupRunResult['phase'])
    ? (result.phase as CloudBackupRunResult['phase'])
    : 'database';
  const database = result.database as Record<string, unknown> | null | undefined;
  const databaseKey = database ? text(database.key) : null;
  const databaseHash = database ? text(database.sha256) : null;
  return {
    phase,
    manifestId: text(result.manifestId),
    manifestKey: text(result.manifestKey),
    cursor: text(result.cursor),
    database:
      databaseKey && databaseHash && database
        ? { key: databaseKey, sha256: databaseHash, size: count(database.size) }
        : null,
    uploaded: count(result.uploaded),
    skipped: count(result.skipped),
    missing: count(result.missing),
    changed: count(result.changed),
    bytesUploaded: count(result.bytesUploaded),
    assets: count(result.assets),
    total: result.total === null || result.total === undefined ? null : count(result.total),
  };
};

/** Progress as a percentage: the database is the first 5, assets the next 90, the rest the last 5. */
export const runProgress = (result: CloudBackupRunResult) => {
  switch (result.phase) {
    case 'database':
    case 'reconcile': {
      return result.database ? 5 : 0;
    }
    case 'assets': {
      const total = result.total ?? 0;
      return total > 0 ? 5 + Math.min(90, Math.floor((result.assets / total) * 90)) : 5;
    }
    case 'profiles':
    case 'manifest': {
      return 96;
    }
    case 'done': {
      return 100;
    }
  }
};
