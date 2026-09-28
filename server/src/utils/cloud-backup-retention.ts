import { gunzipSync } from 'node:zlib';
import {
  CLOUD_BACKUP_DB_PREFIX,
  CLOUD_BACKUP_MANIFEST_FORMAT,
  CLOUD_BACKUP_OBJECT_PREFIX,
  CloudBackupManifest,
  CloudBackupManifestFile,
  cloudBackupAlbumSchema,
  cloudBackupPersonSchema,
  isSha256Hex,
  readManifestAsset,
  readManifestSection,
} from 'src/utils/cloud-backup.js';
import { compareCodeUnits } from 'src/utils/compare.js';

/**
 * Cloud backup retention, verification sampling and manifest reading (FL-164, CLD-302). Pure functions:
 * nothing here reads a file or talks to a provider, so the rules that decide what may be deleted can be
 * tested on their own.
 *
 * - **Retention** keeps the newest manifest, then the newest manifest of each of the last `keepDaily`
 *   days, `keepWeekly` ISO weeks and `keepMonthly` months that have one (UTC). Every other manifest is
 *   removed, and with it only the objects that no kept manifest names.
 * - **Weekly verification** checks the objects whose SHA-256 falls in this week's 1/52 slice, so every
 *   object is fetched and checked once a year; the monthly pass HEADs every referenced object.
 */

export type CloudBackupRetention = { keepDaily: number; keepWeekly: number; keepMonthly: number };

/** One manifest a retention pass decides about: its bucket key and when its run made it. */
export type CloudBackupRetentionCandidate = { key: string; createdAt: Date };

/** Weeks in the verification cycle: each week checks 1/52 of the objects. */
export const CLOUD_BACKUP_VERIFY_SLICES = 52;
/** How long after a full verification the next one is due. */
export const CLOUD_BACKUP_FULL_VERIFY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long after a sampled verification the next one is due. */
export const CLOUD_BACKUP_SAMPLE_VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** A manifest larger than this once decompressed is refused rather than read into memory. */
export const CLOUD_BACKUP_MANIFEST_MAX_BYTES = 1024 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** When a run made its manifest, read from the name `m/20260926T030000Z.json.gz`; null for any other name. */
export const manifestTime = (key: string): Date | null => {
  const match = /^m\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json\.gz$/.exec(key);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

/** The ISO 8601 week, `2026-W39`, in UTC. */
export const isoWeekOf = (date: Date) => {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday decides which year a week belongs to
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

/**
 * Which manifests to keep and which to remove. The newest is always kept, whatever the settings say, so
 * a bucket is never left without a restore point. Ties on time are broken by key, so the answer is the
 * same however the list arrives.
 */
export const retentionPlan = <T extends CloudBackupRetentionCandidate>(
  manifests: readonly T[],
  retention: CloudBackupRetention,
): { keep: T[]; remove: T[] } => {
  const newestFirst = manifests.toSorted(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareCodeUnits(b.key, a.key),
  );
  const kept = new Set<string>();
  if (newestFirst.length > 0) {
    kept.add(newestFirst[0].key);
  }
  const rules: Array<[number, (date: Date) => string]> = [
    [retention.keepDaily, dayOf],
    [retention.keepWeekly, isoWeekOf],
    [retention.keepMonthly, monthOf],
  ];
  for (const [count, periodOf] of rules) {
    const periods = new Set<string>();
    for (const manifest of newestFirst) {
      if (periods.size >= count) {
        break;
      }
      const period = periodOf(manifest.createdAt);
      if (!periods.has(period)) {
        periods.add(period);
        kept.add(manifest.key);
      }
    }
  }
  return {
    keep: newestFirst.filter(({ key }) => kept.has(key)),
    remove: newestFirst.filter(({ key }) => !kept.has(key)),
  };
};

/** Objects under `o/` that no kept manifest names. Anything else in the bucket is never offered for deletion. */
export const unreferencedObjects = <T extends { key: string }>(
  objects: readonly T[],
  referenced: ReadonlySet<string>,
): T[] => {
  return objects.filter(({ key }) => {
    if (!key.startsWith(CLOUD_BACKUP_OBJECT_PREFIX)) {
      return false;
    }
    const sha256 = key.slice(CLOUD_BACKUP_OBJECT_PREFIX.length);
    return isSha256Hex(sha256) && !referenced.has(sha256);
  });
};

/** Database dumps under `db/` that no kept manifest names. */
export const unreferencedDumps = <T extends { key: string }>(objects: readonly T[], referenced: ReadonlySet<string>) =>
  objects.filter(({ key }) => key.startsWith(CLOUD_BACKUP_DB_PREFIX) && !referenced.has(key));

/** This week's verification slice, 0 to 51, counted in whole weeks since the epoch. */
export const verifySliceOf = (date: Date) => Math.floor(date.getTime() / WEEK_MS) % CLOUD_BACKUP_VERIFY_SLICES;

/** Whether an object falls in a week's slice: the first 32 bits of its SHA-256, modulo 52. */
export const inVerifySlice = (sha256: string, slice: number) =>
  Number.parseInt(sha256.slice(0, 8), 16) % CLOUD_BACKUP_VERIFY_SLICES === slice;

/** Which verification is due now, if any: the monthly full pass first, else the weekly sample. */
export const verificationDue = (
  options: { verifyWeekly: boolean; lastFullAt?: string | null; lastSampleAt?: string | null },
  now: Date,
): 'full' | 'sample' | null => {
  if (!options.verifyWeekly) {
    return null;
  }
  const since = (value?: string | null) => {
    const at = value ? Date.parse(value) : NaN;
    return Number.isNaN(at) ? Infinity : now.getTime() - at;
  };
  if (since(options.lastFullAt) >= CLOUD_BACKUP_FULL_VERIFY_INTERVAL_MS) {
    return 'full';
  }
  if (since(options.lastSampleAt) >= CLOUD_BACKUP_SAMPLE_VERIFY_INTERVAL_MS) {
    return 'sample';
  }
  return null;
};

const isFile = (value: unknown): value is CloudBackupManifestFile => {
  const file = value as Partial<CloudBackupManifestFile> | null;
  return (
    !!file &&
    typeof file === 'object' &&
    typeof file.role === 'string' &&
    typeof file.path === 'string' &&
    typeof file.sha256 === 'string' &&
    isSha256Hex(file.sha256) &&
    typeof file.size === 'number' &&
    Number.isFinite(file.size) &&
    // `file` is untrusted manifest data, not a Map or Set: its `size` can be negative
    // eslint-disable-next-line unicorn/no-impossible-length-comparison
    file.size >= 0
  );
};

/**
 * A manifest as a run wrote it (`m/<ISO>.json.gz`), decompressed and checked. Anything that is not a
 * Frameleaf manifest, or names an object by anything but a SHA-256, is refused: retention must never
 * compute what to keep from a manifest it could not read in full.
 */
export const readManifest = (body: Buffer): CloudBackupManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(body, { maxOutputLength: CLOUD_BACKUP_MANIFEST_MAX_BYTES }).toString('utf8'));
  } catch {
    throw new Error('This backup manifest could not be read.');
  }
  const manifest = parsed as Partial<CloudBackupManifest> | null;
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.format !== CLOUD_BACKUP_MANIFEST_FORMAT ||
    (manifest.version !== 1 && manifest.version !== 2) ||
    typeof manifest.instanceId !== 'string' ||
    !manifest.assets ||
    typeof manifest.assets !== 'object'
  ) {
    throw new Error('This is not a Frameleaf backup manifest.');
  }
  for (const asset of Object.values(manifest.assets)) {
    if (!asset || !Array.isArray(asset.files) || asset.files.some((file) => !isFile(file))) {
      throw new Error('This backup manifest names a file without a valid checksum.');
    }
  }
  const profiles = manifest.profiles ?? {};
  if (typeof profiles !== 'object' || Object.values(profiles).some((file) => !isFile(file))) {
    throw new Error('This backup manifest names a file without a valid checksum.');
  }
  const database = manifest.database ?? null;
  if (database && (typeof database.key !== 'string' || !isSha256Hex(database.sha256))) {
    throw new Error('This backup manifest names a database dump without a valid checksum.');
  }
  const v2 = manifest.version === 2;
  return {
    format: CLOUD_BACKUP_MANIFEST_FORMAT,
    version: v2 ? 2 : 1,
    instanceId: manifest.instanceId,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
    database,
    assets: v2
      ? Object.fromEntries(Object.entries(manifest.assets).map(([id, asset]) => [id, readManifestAsset(asset)]))
      : Object.fromEntries(
          Object.entries(manifest.assets).map(([id, asset]) => [id, { owner: asset.owner, files: asset.files }]),
        ),
    profiles,
    albums: v2 ? readManifestSection(manifest.albums, cloudBackupAlbumSchema) : {},
    people: v2 ? readManifestSection(manifest.people, cloudBackupPersonSchema) : {},
  };
};

/** Every object a manifest names (by SHA-256) with its size, and the database dump it names. */
export const manifestReferences = (manifest: CloudBackupManifest) => {
  const objects = new Map<string, number>();
  for (const asset of Object.values(manifest.assets)) {
    for (const file of asset.files) {
      objects.set(file.sha256, file.size);
    }
  }
  for (const file of Object.values(manifest.profiles)) {
    objects.set(file.sha256, file.size);
  }
  return { objects, database: manifest.database?.key ?? null };
};
