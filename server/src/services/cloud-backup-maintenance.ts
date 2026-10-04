import type { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  CloudBackupConnection,
  CloudBackupObjectInfo,
  CloudBackupStoreError,
  CloudBackupStoreRepository,
} from 'src/repositories/cloud-backup-store.repository.js';
import {
  CloudBackupRetention,
  inVerifySlice,
  manifestReferences,
  manifestTime,
  readManifest,
  retentionPlan,
  unreferencedDumps,
  unreferencedObjects,
  verifySliceOf,
} from 'src/utils/cloud-backup-retention.js';
import {
  CLOUD_BACKUP_DB_DUMPS_KEPT,
  CLOUD_BACKUP_DB_PREFIX,
  CLOUD_BACKUP_MANIFEST_PREFIX,
  CLOUD_BACKUP_OBJECT_PREFIX,
  objectKey,
} from 'src/utils/cloud-backup.js';
import { compareCodeUnits } from 'src/utils/compare.js';
import { advanceExecutionProgress } from 'src/utils/execution-signal.js';

/** The claimed bucket an operation works on, opened with its key for this operation only. */
export type CloudBackupBucket = {
  bucketRef: string;
  connection: CloudBackupConnection;
  bucketKey: Buffer;
};

/**
 * Written between batches: answers whether to carry on (no on a pause, a cancel or a lost claim). The
 * command-line restore passes one that always carries on.
 */
export type CloudBackupCheckpoint<T> = (result: T) => Promise<boolean>;

/** What a clean-up did, or (as a dry run) would do. Kept on the operation row as its result. */
export type CloudBackupPruneResult = {
  task: 'prune';
  dryRun: boolean;
  done: boolean;
  manifestsKept: number;
  manifestsRemoved: number;
  objectsRemoved: number;
  bytesRemoved: number;
  dumpsRemoved: number;
  /** Objects deleted so far, of `objectsRemoved`. */
  deleted: number;
};

/** What a verification has checked so far. Kept on the operation row, with its cursor, as its result. */
export type CloudBackupVerifyResult = {
  task: 'verify';
  depth: 'sample' | 'full';
  done: boolean;
  /** The week slice a sampled verification checks, fixed when it starts so a resumed one checks the same. */
  slice: number;
  total: number;
  checked: number;
  missing: number;
  mismatched: number;
  degradedManifests: number;
  /** The manifests marked degraded so far (at most `VERIFY_BAD_KEPT`), so a resumed check counts each once. */
  degradedKeys: string[];
  /** The last object checked, in SHA-256 order: a resumed verification carries on after it. */
  cursor: string | null;
  /** The objects found missing or damaged (at most `VERIFY_BAD_KEPT` of them). */
  bad: string[];
};

/** Objects checked, or deleted, between two checkpoints. */
const MAINTENANCE_BATCH = 200;
/** Objects forgotten in the index per query. */
const FORGET_BATCH = 1000;
/** How many bad objects a verification lists on its result; the counts cover all of them. */
const VERIFY_BAD_KEPT = 1000;

export const emptyPruneResult = (dryRun: boolean): CloudBackupPruneResult => ({
  task: 'prune',
  dryRun,
  done: false,
  manifestsKept: 0,
  manifestsRemoved: 0,
  objectsRemoved: 0,
  bytesRemoved: 0,
  dumpsRemoved: 0,
  deleted: 0,
});

export const emptyVerifyResult = (depth: 'sample' | 'full', now: Date): CloudBackupVerifyResult => ({
  task: 'verify',
  depth,
  done: false,
  slice: verifySliceOf(now),
  total: 0,
  checked: 0,
  missing: 0,
  mismatched: 0,
  degradedManifests: 0,
  degradedKeys: [],
  cursor: null,
  bad: [],
});

const listAll = async (store: CloudBackupStoreRepository, bucket: CloudBackupBucket, prefix: string) => {
  const objects: CloudBackupObjectInfo[] = [];
  await store.listAll(bucket.connection, prefix, (page) => {
    objects.push(...page);
    return Promise.resolve();
  });
  return objects;
};

/**
 * Retention and verification of a claimed bucket (FL-164, CLD-302). Both read the manifests in the bucket
 * itself, never a copy on this server, so what they decide is what a restore would find.
 *
 * - **Retention** keeps the manifests the settings keep, reads every one of them in full, and removes
 *   only the objects and dumps that none of them names; if any kept manifest cannot be read, nothing is
 *   removed. Each object is forgotten by the index before it is deleted, so an interrupted clean-up can
 *   only cost a second upload, never a skipped one. A dry run counts and removes nothing.
 * - **Verification** reads every manifest, then either fetches this week's 1/52 of the objects and checks
 *   each against its SHA-256 (weekly), or HEADs every referenced object and dump (monthly). A missing or
 *   damaged object is forgotten by the index, so the next run uploads it again from this server's files,
 *   and every manifest that names it is marked `degraded`.
 */
export class CloudBackupMaintenance {
  constructor(
    private store: CloudBackupStoreRepository,
    private index: CloudBackupIndexRepository,
    private logger: LoggingRepository,
  ) {}

  async prune(
    bucket: CloudBackupBucket,
    retention: CloudBackupRetention,
    dryRun: boolean,
    checkpoint: CloudBackupCheckpoint<CloudBackupPruneResult>,
  ): Promise<CloudBackupPruneResult | null> {
    const listed = await listAll(this.store, bucket, CLOUD_BACKUP_MANIFEST_PREFIX);
    // a name that is not a manifest's is never a candidate for removal
    const candidates = listed.flatMap(({ key }) => {
      const createdAt = manifestTime(key);
      return createdAt ? [{ key, createdAt }] : [];
    });
    const plan = retentionPlan(candidates, retention);

    // Every kept manifest is read in full before anything is removed; one that cannot be read stops the
    // clean-up, so an object it might name is never removed.
    const referenced = new Set<string>();
    const referencedDumps = new Set<string>();
    for (const manifest of plan.keep) {
      const references = await this.readReferences(bucket, manifest.key);
      for (const sha256 of references.objects.keys()) {
        referenced.add(sha256);
      }
      if (references.database) {
        referencedDumps.add(references.database);
      }
    }

    const objects = unreferencedObjects(await listAll(this.store, bucket, CLOUD_BACKUP_OBJECT_PREFIX), referenced);
    // the newest dumps are kept whatever names them, as a run keeps them
    const dumps = await listAll(this.store, bucket, CLOUD_BACKUP_DB_PREFIX);
    const newestDumps = new Set(
      dumps
        .map(({ key }) => key)
        .toSorted((a, b) => compareCodeUnits(b, a))
        .slice(0, CLOUD_BACKUP_DB_DUMPS_KEPT),
    );
    const staleDumps = unreferencedDumps(dumps, referencedDumps).filter(({ key }) => !newestDumps.has(key));

    const result: CloudBackupPruneResult = {
      ...emptyPruneResult(dryRun),
      manifestsKept: plan.keep.length,
      manifestsRemoved: plan.remove.length,
      objectsRemoved: objects.length,
      bytesRemoved: objects.reduce((total, { size }) => total + size, 0),
      dumpsRemoved: staleDumps.length,
    };
    this.logger.log(
      `Cloud backup clean-up${dryRun ? ' (dry run)' : ''}: ${plan.keep.length} runs kept, ${plan.remove.length} past retention, ${objects.length} unreferenced files (${result.bytesRemoved} bytes), ${staleDumps.length} old database dumps`,
    );
    if (dryRun) {
      return { ...result, done: true };
    }

    // The manifests go first, marked pruned before they are deleted so nothing offers a restore from one
    // that is going; the objects only they named are unreferenced whichever way this is interrupted.
    await this.index.markManifests(
      bucket.bucketRef,
      plan.remove.map(({ key }) => key),
      'pruned',
    );
    for (const manifest of plan.remove) {
      await this.store.delete(bucket.connection, manifest.key);
      advanceExecutionProgress(1);
    }

    let progress = result;
    for (let start = 0; start < objects.length; start += MAINTENANCE_BATCH) {
      const batch = objects.slice(start, start + MAINTENANCE_BATCH);
      const hashes = batch.map(({ key }) => key.slice(CLOUD_BACKUP_OBJECT_PREFIX.length));
      for (let at = 0; at < hashes.length; at += FORGET_BATCH) {
        await this.index.forget(bucket.bucketRef, hashes.slice(at, at + FORGET_BATCH));
      }
      for (const { key } of batch) {
        await this.store.delete(bucket.connection, key);
        advanceExecutionProgress(1);
      }
      progress = { ...progress, deleted: progress.deleted + batch.length };
      // a pause or cancel stops here; the next clean-up plans again from the bucket as it is then
      if (!(await checkpoint(progress))) {
        return null;
      }
    }
    for (const { key } of staleDumps) {
      await this.store.delete(bucket.connection, key);
      advanceExecutionProgress(1);
    }
    return { ...progress, done: true };
  }

  async verify(
    bucket: CloudBackupBucket,
    start: CloudBackupVerifyResult,
    checkpoint: CloudBackupCheckpoint<CloudBackupVerifyResult>,
    claim: { operationId: string; claimToken: string },
  ): Promise<CloudBackupVerifyResult | null> {
    // what every manifest names: object → its size and the manifests naming it, and each named dump
    const named = new Map<string, { size: number; manifests: string[] }>();
    const dumps = new Map<string, string[]>();
    const unreadable: string[] = [];
    const manifests = await listAll(this.store, bucket, CLOUD_BACKUP_MANIFEST_PREFIX);
    for (const { key } of manifests) {
      if (!manifestTime(key)) {
        continue;
      }
      let references: ReturnType<typeof manifestReferences>;
      try {
        references = await this.readReferences(bucket, key);
      } catch (error) {
        this.logger.warn(`Cloud backup verification: manifest ${key} could not be read: ${String(error)}`);
        unreadable.push(key);
        continue;
      }
      for (const [sha256, size] of references.objects) {
        const entry = named.get(sha256);
        if (entry) {
          entry.manifests.push(key);
        } else {
          named.set(sha256, { size, manifests: [key] });
        }
      }
      if (references.database) {
        dumps.set(references.database, [...(dumps.get(references.database) ?? []), key]);
      }
    }

    const hashes = named
      .keys()
      .filter((sha256) => start.depth === 'full' || inVerifySlice(sha256, start.slice))
      .toArray()
      .toSorted(compareCodeUnits);
    let result: CloudBackupVerifyResult = {
      ...start,
      total: hashes.length + (start.depth === 'full' ? dumps.size : 0),
    };
    // manifests marked degraded, counted once each across a resumed verification's claims
    const degraded = new Set<string>([...(start.degradedKeys ?? []), ...unreadable]);
    const bad: string[] = [];
    const degradedCount = () => Math.max(start.degradedManifests, degraded.size);

    const record = (sha256: string, problem: 'missing' | 'mismatched') => {
      bad.push(sha256);
      for (const key of named.get(sha256)?.manifests ?? []) {
        degraded.add(key);
      }
      result = {
        ...result,
        [problem]: result[problem] + 1,
        bad: result.bad.length < VERIFY_BAD_KEPT ? [...result.bad, sha256] : result.bad,
      };
    };

    const { cursor } = start;
    const pending = cursor ? hashes.filter((sha256) => compareCodeUnits(sha256, cursor) > 0) : hashes;
    for (let at = 0; at < pending.length; at += MAINTENANCE_BATCH) {
      for (const sha256 of pending.slice(at, at + MAINTENANCE_BATCH)) {
        const problem = await this.checkObject(bucket, sha256, named.get(sha256)!.size, start.depth);
        await this.index.recordObjectVerification({
          bucket: bucket.bucketRef,
          sha256,
          ...claim,
          method: start.depth === 'full' ? 'size-head' : 'sha256-get',
          result: problem ?? 'passed',
        });
        advanceExecutionProgress(1);
        if (problem) {
          record(sha256, problem);
        }
        result = { ...result, checked: result.checked + 1, cursor: sha256 };
      }
      const settling = [...bad];
      bad.length = 0;
      await this.settleBad(bucket, settling, degraded);
      result = {
        ...result,
        degradedManifests: degradedCount(),
        degradedKeys: [...degraded].slice(0, VERIFY_BAD_KEPT),
      };
      if (!(await checkpoint(result))) {
        return null;
      }
    }

    if (start.depth === 'full') {
      for (const [key, names] of dumps) {
        const found = await this.store.head(bucket.connection, key, bucket.bucketKey).catch((error: unknown) => {
          if (error instanceof CloudBackupStoreError && error.status !== null && error.status < 500) {
            return null;
          }
          throw error;
        });
        if (!found) {
          result = { ...result, missing: result.missing + 1 };
          for (const manifest of names) {
            degraded.add(manifest);
          }
        }
        result = { ...result, checked: result.checked + 1 };
        advanceExecutionProgress(1);
      }
    }
    await this.settleBad(bucket, [], degraded);
    return { ...result, degradedManifests: degradedCount(), done: true };
  }

  private async readReferences(bucket: CloudBackupBucket, key: string) {
    return manifestReferences(readManifest(await this.store.get(bucket.connection, key, bucket.bucketKey)));
  }

  /** One object: HEAD (monthly) or a full read hashed against its name (weekly). */
  private async checkObject(
    bucket: CloudBackupBucket,
    sha256: string,
    size: number,
    depth: 'sample' | 'full',
  ): Promise<'missing' | 'mismatched' | null> {
    try {
      if (depth === 'full') {
        const found = await this.store.head(bucket.connection, objectKey(sha256), bucket.bucketKey);
        if (!found) {
          return 'missing';
        }
        return found.size === size ? null : 'mismatched';
      }
      const read = await this.store.hashObject(bucket.connection, objectKey(sha256), bucket.bucketKey);
      return read.sha256 === sha256 && read.size === size ? null : 'mismatched';
    } catch (error) {
      if (error instanceof CloudBackupStoreError && error.status === 404) {
        return 'missing';
      }
      // an object the key cannot read (403 on an SSE-C read) is as good as damaged
      if (error instanceof CloudBackupStoreError && error.status !== null && error.status < 500) {
        return 'mismatched';
      }
      throw error;
    }
  }

  /** Forget bad objects in the index, so the next run uploads them again, and mark the manifests naming them. */
  private async settleBad(bucket: CloudBackupBucket, bad: string[], degraded: ReadonlySet<string>) {
    for (let at = 0; at < bad.length; at += FORGET_BATCH) {
      await this.index.forget(bucket.bucketRef, bad.slice(at, at + FORGET_BATCH));
    }
    await this.index.markManifests(bucket.bucketRef, [...degraded], 'degraded');
  }
}
