import { type Repository, prune, verify } from '@frameleaf/backup-core';
import type { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import type { CloudBackupConnection } from 'src/repositories/cloud-backup-store.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import { summarizeCatalog } from 'src/services/cloud-backup-run.js';
import {
  type CloudBackupRetention,
  inVerifySlice,
  retentionPlan,
  verifySliceOf,
} from 'src/utils/cloud-backup-retention.js';
import {
  parseSnapshotObjectKey,
  readVaultCatalog,
  readVaultSnapshot,
  snapshotObjectKey,
} from 'src/utils/cloud-backup-vault.js';

/** The claimed bucket an operation works on, opened for this operation only. */
export type CloudBackupBucket = {
  bucketRef: string;
  /** Where the bucket is, with what this server knows of its own backups (vault, keys, signed history). */
  connection: CloudBackupConnection;
  /**
   * The bucket key: what the recovery kit holds and the claim is made with. It encrypts nothing in storage
   * (the repository is opened with the keyring's root); operations still need it loaded, so that a server
   * whose key is locked away does not touch its backups.
   */
  bucketKey: Buffer;
};

/**
 * Written between steps: answers whether to carry on (no on a pause, a cancel or a lost claim). The
 * command-line restore passes one that always carries on.
 */
export type CloudBackupCheckpoint<T> = (result: T) => Promise<boolean>;

/** What a clean-up did, or (as a dry run) would do. Kept on the operation row as its result. */
export type CloudBackupPruneResult = {
  task: 'prune';
  dryRun: boolean;
  done: boolean;
  /** Backups kept, and backups past retention that were removed. */
  manifestsKept: number;
  manifestsRemoved: number;
  /** Stored objects (packs) removed or rewritten without what nothing needs any more, and the bytes that frees. */
  objectsRemoved: number;
  bytesRemoved: number;
  /** Always 0 now: a dump is part of its backup and goes with it. Kept for the API. */
  dumpsRemoved: number;
  /** Objects deleted so far, of `objectsRemoved`. */
  deleted: number;
};

/** What a verification found. Kept on the operation row as its result. */
export type CloudBackupVerifyResult = {
  task: 'verify';
  depth: 'sample' | 'full';
  done: boolean;
  /** The week slice a sampled verification reads, fixed when it starts so a resumed one reads the same. */
  slice: number;
  /** Pieces the kept backups need. */
  total: number;
  /** A full check: the pieces looked for. A sample: the stored objects read byte for byte. */
  checked: number;
  /** Pieces a backup needs that storage does not hold. */
  missing: number;
  /** Stored objects whose content no longer matches what was written, and backups that cannot be opened. */
  mismatched: number;
  degradedManifests: number;
  degradedKeys: string[];
  cursor: string | null;
  /** The pieces and objects found missing or damaged (at most `VERIFY_BAD_KEPT` of them). */
  bad: string[];
};

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

/**
 * Retention and verification of a claimed bucket (FL-164, FL-1676). Both work on the repository in the
 * bucket itself, never on a copy on this server, so what they decide is what a restore would find. The
 * backup engine does the storage work; this class decides which backups to keep and keeps this server's
 * own list of them in step.
 *
 * - **Retention** keeps the backups the settings keep (by day, week and month) and always the newest and
 *   the one the signed history ends in. The engine then removes the stored data only the others needed.
 *   It stops before changing anything if a kept backup is missing a piece, never removes data stored less
 *   than 90 days ago (storage is billed that long anyway), and is safe to stop at any point. A dry run
 *   counts and removes nothing.
 * - **Verification** walks every kept backup and checks that every piece it needs is stored (`full`), and
 *   for a `sample` also reads this week's 1/52 of the stored objects and checks every piece in them
 *   against its name, so each object is read once a year.
 */
export class CloudBackupMaintenance {
  constructor(
    private index: Pick<
      CloudBackupIndexRepository,
      'getManifestKeys' | 'adoptManifests' | 'markManifests' | 'listKeptManifests' | 'restorePrunedManifests'
    >,
    private logger: LoggingRepository,
  ) {}

  /**
   * Backups in storage that this server has no record of (a bucket claimed again, or a database restored
   * from before later runs) are recorded as kept, so they can be listed and restored from. One that
   * cannot be read is left out and logged; the clean-up still decides about it from storage.
   */
  async adopt(bucket: CloudBackupBucket, repository: Repository, except: string | null = null): Promise<number> {
    const vaultId = bucket.connection.vaultId!;
    const stored = (await repository.listSnapshots()).map(({ key }) => ({
      key,
      name: snapshotObjectKey(vaultId, key),
    }));
    const known = await this.index.getManifestKeys(
      bucket.bucketRef,
      stored.map(({ name }) => name),
    );
    const adopted = [];
    for (const { key, name } of stored) {
      if (known.has(name) || name === except) {
        continue;
      }
      try {
        const snapshot = await readVaultSnapshot(repository, key, bucket.connection.trustedManifests?.[name]);
        const summary = summarizeCatalog(await readVaultCatalog(repository, snapshot));
        adopted.push({
          key: name,
          createdAt: new Date(snapshot.time),
          databaseKey: summary.database?.key ?? null,
          assetCount: summary.assets,
          fileCount: summary.files,
          bytes: summary.bytes,
        });
      } catch (error) {
        this.logger.warn(`Cloud backup: the stored backup ${name} could not be read: ${String(error)}`);
      }
    }
    return this.index.adoptManifests(bucket.bucketRef, adopted);
  }

  async prune(
    bucket: CloudBackupBucket,
    repository: Repository,
    retention: CloudBackupRetention,
    dryRun: boolean,
  ): Promise<CloudBackupPruneResult> {
    const vaultId = bucket.connection.vaultId!;
    const stored = await repository.listSnapshots();
    const head = bucket.connection.trustedManifestHead
      ? parseSnapshotObjectKey(bucket.connection.trustedManifestHead)?.key
      : undefined;
    if (bucket.connection.trustedManifestHead && stored.every(({ key }) => key !== head)) {
      throw new Error('The anchored backup head is missing from storage; clean-up is refused');
    }

    // Each backup's time is the one sealed inside it, never the provider's. One that cannot be opened is kept.
    const candidates: Array<{ key: string; createdAt: Date }> = [];
    const keep = new Set<string>();
    for (const { key } of stored) {
      try {
        const at = new Date((await repository.readSnapshot(key)).time);
        if (Number.isNaN(at.getTime())) {
          keep.add(key);
        } else {
          candidates.push({ key, createdAt: at });
        }
      } catch {
        keep.add(key);
      }
    }
    for (const { key } of retentionPlan(candidates, retention).keep) {
      keep.add(key);
    }
    if (head) {
      keep.add(head);
    }
    const remove = candidates.filter(({ key }) => !keep.has(key));

    // Marked pruned before anything is deleted, so nothing offers a restore from a backup that is going.
    // FL-1769: what each was before, so a clean-up the engine refuses or stops can show the ones still stored again.
    const before = dryRun
      ? new Map<string, 'complete' | 'degraded'>()
      : new Map(
          (await this.index.listKeptManifests(bucket.bucketRef)).map(({ key, status }) => [key, status] as const),
        );
    if (!dryRun) {
      await this.index.adoptManifests(
        bucket.bucketRef,
        remove.map(({ key, createdAt }) => ({
          key: snapshotObjectKey(vaultId, key),
          createdAt,
          databaseKey: null,
          assetCount: 0,
          fileCount: 0,
          bytes: 0,
        })),
        'pruned',
      );
      await this.index.markManifests(
        bucket.bucketRef,
        remove.map(({ key }) => snapshotObjectKey(vaultId, key)),
        'pruned',
      );
    }
    let report: Awaited<ReturnType<typeof prune>>;
    try {
      report = await prune(repository, { keep: () => keep, dryRun });
    } catch (error) {
      if (!dryRun && remove.length > 0) {
        await this.unmarkStillStored(bucket, repository, remove, before);
      }
      throw error;
    }
    this.logger.log(
      `Cloud backup clean-up${dryRun ? ' (dry run)' : ''}: ${report.keptSnapshots} backups kept, ${report.removedSnapshots.length} past retention, ${report.deletedPacks} stored objects (${report.freedBytes} bytes) no longer needed`,
    );
    return {
      ...emptyPruneResult(dryRun),
      done: true,
      manifestsKept: report.keptSnapshots,
      manifestsRemoved: report.removedSnapshots.length,
      objectsRemoved: report.deletedPacks,
      bytesRemoved: Math.max(0, report.freedBytes),
      deleted: dryRun ? 0 : report.deletedPacks,
    };
  }

  /**
   * FL-1769: the engine refused or stopped a clean-up after this server marked its backups pruned. The
   * ones still in storage are shown again as they were (a backup this server had no record of as complete).
   */
  private async unmarkStillStored(
    bucket: CloudBackupBucket,
    repository: Repository,
    remove: Array<{ key: string }>,
    before: Map<string, 'complete' | 'degraded'>,
  ) {
    const vaultId = bucket.connection.vaultId!;
    try {
      const stored = new Set((await repository.listSnapshots()).map(({ key }) => key));
      const restored = remove
        .filter(({ key }) => stored.has(key))
        .map(({ key }) => {
          const objectKey = snapshotObjectKey(vaultId, key);
          return { key: objectKey, status: before.get(objectKey) ?? ('complete' as const) };
        });
      await this.index.restorePrunedManifests(bucket.bucketRef, restored);
    } catch (error) {
      this.logger.warn(`Cloud backup: backups kept by a stopped clean-up could not be shown again: ${String(error)}`);
    }
  }

  async verify(
    bucket: CloudBackupBucket,
    repository: Repository,
    start: CloudBackupVerifyResult,
  ): Promise<CloudBackupVerifyResult> {
    const vaultId = bucket.connection.vaultId!;
    const sample = start.depth === 'sample';
    const report = await verify(repository, {
      // `p/<32 hex>`: a pack's random name puts it in one of the year's 52 slices
      readPack: (pack) => sample && inVerifySlice(pack.slice(2).padEnd(64, '0'), start.slice),
    });
    const bad = [...report.damagedSnapshots, ...report.damagedPacks, ...report.missing];
    // ponytail: the engine says which pieces are bad, not which backups need them, so every kept backup
    // is marked when any piece is. Have the engine's verify name the backups to mark only those.
    const degraded =
      bad.length > 0
        ? (await repository.listSnapshots()).map(({ key }) => snapshotObjectKey(vaultId, key))
        : ([] as string[]);
    const marked = await this.index.markManifests(bucket.bucketRef, degraded, 'degraded');
    return {
      ...start,
      done: true,
      total: report.blobs,
      checked: sample ? report.packsRead : report.blobs,
      missing: report.missing.length,
      mismatched: report.damagedPacks.length + report.damagedSnapshots.length,
      degradedManifests: Math.max(start.degradedManifests, marked),
      degradedKeys: degraded.slice(0, VERIFY_BAD_KEPT),
      bad: bad.slice(0, VERIFY_BAD_KEPT),
    };
  }
}
