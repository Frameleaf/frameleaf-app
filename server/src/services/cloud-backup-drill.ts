import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import type { CloudBackupBucket } from 'src/services/cloud-backup-maintenance.js';
import {
  CloudBackupStoreError,
  type CloudBackupStoreRepository,
} from 'src/repositories/cloud-backup-store.repository.js';
import { readManifest } from 'src/utils/cloud-backup-retention.js';
import { type CloudBackupManifest, manifestFileObjectKey } from 'src/utils/cloud-backup.js';
import { assertExecutionActive } from 'src/utils/execution-signal.js';

/**
 * FL-879: the restore drill. Now and then the server proves its Cloud Backup (Frameleaf-managed or your
 * own bucket) really restores: it fetches the newest backup's list of files, checks it is the one the
 * signed snapshot history names, unlocks it with the recovery key, rebuilds the library data in a scratch
 * database, and takes a random sample of originals back to compare them file by file. Everything lands
 * in a scratch folder and a scratch database that are removed afterwards; the library is never touched.
 */
export type DrillStep = 'fetch' | 'unlock' | 'rebuild' | 'compare';
export const DRILL_STEPS: readonly DrillStep[] = Object.freeze(['fetch', 'unlock', 'rebuild', 'compare']);
/** Originals taken back per drill (all of them when the backup holds fewer). */
export const DRILL_SAMPLE_SIZE = 500;
/** How often the schedule runs a drill. */
export const DRILL_INTERVAL_DAYS = 30;
/** A drill that failed is not tried again by the schedule for this long. */
export const DRILL_FAILED_BACKOFF_MS = 24 * 60 * 60_000;

/** What went wrong at a step, in words an administrator can act on (the report and the email use them). */
export const DRILL_FAILURE_WORDS: Record<DrillStep, string> = {
  fetch: 'Frameleaf couldn’t fetch the sample from your backup.',
  unlock: 'The recovery key on this server didn’t unlock the backup.',
  rebuild: 'The library data in the backup couldn’t be rebuilt.',
  compare: 'Some photos in the backup didn’t match the originals.',
};

export type DrillMismatch = {
  assetId: string;
  /** different: the bytes changed; missing: not in the bucket; not-in-library-data: absent from the rebuilt data. */
  problem: 'different' | 'missing' | 'not-in-library-data';
};

export type DrillOutcome = {
  result: 'passed' | 'failed';
  failedStep: DrillStep | null;
  manifestKey: string | null;
  /** When the backup that was used was made. */
  backupFrom: string | null;
  library: { items: number; photos: number; videos: number; albums: number };
  restored: { asset: number; user: number; album: number } | null;
  sampleSize: number;
  checked: number;
  matched: number;
  mismatches: DrillMismatch[];
};

export class DrillStepError extends Error {
  constructor(
    readonly step: DrillStep,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DrillStepError';
  }
}

export type DrillDeps = {
  store: Pick<CloudBackupStoreRepository, 'exportObject' | 'get' | 'download'>;
  makeDirectory: (path: string) => Promise<void>;
  removeDirectory: (path: string) => Promise<void>;
  /** Rebuild the dump in a scratch database: what it holds, and which of `assetIds` it has. */
  rehearse: (
    dumpPath: string,
    assetIds: string[],
  ) => Promise<{ counts: { asset: number; user: number; album: number }; presentAssetIds: string[] }>;
  /** When each of these items was added to the live library (read only); unknown ids are left out. */
  addedAt: (assetIds: string[]) => Promise<Map<string, Date>>;
  /** Reports progress (0–100); false when the drill must stop (cancelled, paused or claim lost). */
  progress: (percent: number, checked: number) => Promise<boolean>;
  /** FL-362: whose items the licence lets this server read back; your own bucket has no gate. */
  eligible?: (ownerId: string | null) => boolean;
  random?: (max: number) => number;
};

const isMissing = (error: unknown) => error instanceof CloudBackupStoreError && error.status === 404;
const isMismatch = (error: unknown) => error instanceof CloudBackupStoreError && error.code === 'ChecksumMismatch';

/** A random sample of `size` from `items` (all of them when there are fewer), without repeats. */
export const drillSample = <T>(items: T[], size: number, random: (max: number) => number = randomInt): T[] => {
  const pool = [...items];
  const count = Math.min(size, pool.length);
  for (let index = 0; index < count; index++) {
    const pick = index + random(pool.length - index);
    const chosen = pool[pick];
    pool[pick] = pool[index];
    pool[index] = chosen;
  }
  return pool.slice(0, count);
};

const libraryOf = (manifest: CloudBackupManifest) => {
  let photos = 0;
  let videos = 0;
  for (const asset of Object.values(manifest.assets)) {
    if (asset.type === 'VIDEO') videos++;
    else photos++;
  }
  return { items: photos + videos, photos, videos, albums: Object.keys(manifest.albums ?? {}).length };
};

/**
 * Run one drill against an opened bucket, inside `scratch` (created here, removed afterwards whatever
 * happens). Answers the outcome, or null when it was stopped part-way (nothing to report).
 */
export async function runRestoreDrill(
  bucket: CloudBackupBucket,
  scratch: string,
  deps: DrillDeps,
): Promise<DrillOutcome | null> {
  const outcome: DrillOutcome = {
    result: 'failed',
    failedStep: null,
    manifestKey: bucket.connection.trustedManifestHead ?? null,
    backupFrom: null,
    library: { items: 0, photos: 0, videos: 0, albums: 0 },
    restored: null,
    sampleSize: 0,
    checked: 0,
    matched: 0,
    mismatches: [],
  };
  await deps.removeDirectory(scratch);
  await deps.makeDirectory(scratch);
  try {
    const manifestKey = outcome.manifestKey;
    // (a) fetch: the newest backup the signed snapshot history names, byte for byte as it was recorded
    if (!manifestKey) {
      throw new DrillStepError('fetch', 'No finished backup is recorded in the signed snapshot history');
    }
    try {
      await deps.store.exportObject(bucket.connection, manifestKey, bucket.bucketKey, join(scratch, 'manifest'));
    } catch (error) {
      throw new DrillStepError('fetch', `The newest backup’s list of files could not be fetched intact`, {
        cause: error,
      });
    }
    if (!(await deps.progress(10, 0))) return null;

    // (b) unlock: the list of files with the recovery key, then the library data it names
    let manifest: CloudBackupManifest;
    try {
      manifest = readManifest(await deps.store.get(bucket.connection, manifestKey, bucket.bucketKey));
    } catch (error) {
      throw new DrillStepError('unlock', 'The newest backup could not be unlocked', { cause: error });
    }
    outcome.backupFrom = manifest.createdAt;
    outcome.library = libraryOf(manifest);
    if (!manifest.database) {
      throw new DrillStepError('rebuild', 'The newest backup holds no library data');
    }
    const dumpPath = join(scratch, 'library-data.sql.gz');
    try {
      await deps.store.download(
        bucket.connection,
        manifest.database.key,
        bucket.bucketKey,
        dumpPath,
        manifest.database.sha256,
      );
    } catch (error) {
      if (isMissing(error))
        throw new DrillStepError('fetch', 'The library data is missing from the backup', { cause: error });
      if (isMismatch(error))
        throw new DrillStepError('rebuild', 'The library data in the backup is damaged', { cause: error });
      throw new DrillStepError('fetch', 'The library data could not be fetched', { cause: error });
    }
    if (!(await deps.progress(25, 0))) return null;

    // the sample is chosen before the rebuild, so the rebuilt data can be asked about the same items
    const originals = Object.entries(manifest.assets).flatMap(([assetId, asset]) =>
      deps.eligible && !deps.eligible(asset.owner)
        ? []
        : asset.files.filter((file) => file.role === 'original').map((file) => ({ assetId, file })),
    );
    if (originals.length === 0 && outcome.library.items > 0) {
      throw new DrillStepError('fetch', 'The licence covers none of the backed-up items, so none can be taken back');
    }
    const sample = drillSample(originals, DRILL_SAMPLE_SIZE, deps.random);
    outcome.sampleSize = sample.length;

    // (c) rebuild: the library data in a scratch database, which must hold every sampled item that was
    // in the library when the backup started (items added during that backup may come after its data)
    let rehearsal: Awaited<ReturnType<DrillDeps['rehearse']>>;
    try {
      rehearsal = await deps.rehearse(
        dumpPath,
        sample.map(({ assetId }) => assetId),
      );
    } catch (error) {
      assertExecutionActive();
      throw new DrillStepError('rebuild', 'The library data could not be rebuilt in a scratch copy', { cause: error });
    }
    outcome.restored = rehearsal.counts;
    if (outcome.library.items > 0 && (rehearsal.counts.asset === 0 || rehearsal.counts.user === 0)) {
      throw new DrillStepError('rebuild', 'The rebuilt library data holds no items or no accounts');
    }
    const present = new Set(rehearsal.presentAssetIds);
    const absent = [...new Set(sample.map(({ assetId }) => assetId).filter((id) => !present.has(id)))];
    if (absent.length > 0) {
      const added = await deps.addedAt(absent);
      const started = Date.parse(manifest.createdAt);
      for (const assetId of absent) {
        const at = added.get(assetId);
        if (!at || Number.isNaN(started) || at.getTime() < started) {
          outcome.mismatches.push({ assetId, problem: 'not-in-library-data' });
        }
      }
      if (outcome.mismatches.length > 0) {
        throw new DrillStepError('rebuild', 'Items in the backup are missing from its library data');
      }
    }
    if (!(await deps.progress(50, 0))) return null;

    // (d) compare: each sampled original taken back and checked against the SHA-256 the backup recorded
    const target = join(scratch, 'original');
    for (const [index, { assetId, file }] of sample.entries()) {
      try {
        await deps.store.download(
          bucket.connection,
          manifestFileObjectKey(file),
          bucket.bucketKey,
          target,
          file.sha256,
        );
        outcome.matched++;
      } catch (error) {
        if (isMissing(error)) outcome.mismatches.push({ assetId, problem: 'missing' });
        else if (isMismatch(error)) outcome.mismatches.push({ assetId, problem: 'different' });
        else throw new DrillStepError('fetch', 'An original could not be fetched from the backup', { cause: error });
      } finally {
        await deps.removeDirectory(target);
      }
      outcome.checked = index + 1;
      if (!(await deps.progress(50 + (outcome.checked / Math.max(1, sample.length)) * 50, outcome.checked)))
        return null;
    }
    if (outcome.mismatches.length > 0) {
      throw new DrillStepError('compare', `${outcome.mismatches.length} sampled originals did not match the backup`);
    }
    outcome.result = 'passed';
    return outcome;
  } catch (error) {
    if (!(error instanceof DrillStepError)) throw error;
    outcome.result = 'failed';
    outcome.failedStep = error.step;
    throw Object.assign(error, { outcome });
  } finally {
    await deps.removeDirectory(scratch);
  }
}

/** The outcome a failed step carries, so the caller can report it. */
export const drillOutcomeOf = (error: unknown): DrillOutcome | null =>
  error instanceof DrillStepError ? ((error as DrillStepError & { outcome?: DrillOutcome }).outcome ?? null) : null;
