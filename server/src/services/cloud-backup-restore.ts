import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { CryptoRepository } from 'src/repositories/crypto.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { StorageRepository } from 'src/repositories/storage.repository.js';
import type { RestoreDetailsMode } from 'src/utils/cloud-backup-details.js';
import { CloudBackupStoreError, CloudBackupStoreRepository } from 'src/repositories/cloud-backup-store.repository.js';
import { CloudBackupBucket, CloudBackupCheckpoint } from 'src/services/cloud-backup-maintenance.js';
import { flushBuddyDirectory } from 'src/utils/buddy-backup-vault.js';
import { assertOwnerRestoreFile, captureOwnerRestoreFile } from 'src/utils/cloud-backup-owner-path.js';
import { CloudBackupManifest, objectKey } from 'src/utils/cloud-backup.js';
import { compareCodeUnits } from 'src/utils/compare.js';
import { isValidDatabaseBackupName } from 'src/utils/database-backups.js';

/**
 * What a restore brings back (FL-164, CLD-302):
 * - `files`: the chosen assets' files (every asset when none is chosen, with the profile images) into
 *   `<media>/frameleaf/restore/<operation>`, where Library Care's search for missing originals finds them.
 *   Nothing in the library is touched.
 * - `asset`: one asset's files back where the library expects them. A file already there that is not the
 *   backed-up one is moved to `<media>/frameleaf/restore/replaced/<operation>` first, never deleted. A
 *   deleted asset is made again from its manifest record, and one still in the library gets its details
 *   back as the snapshot's `details` says (manifest v2).
 * - `album`: the album's members as `asset` does for one, then the album itself made again, or its lost
 *   members added back (manifest v2).
 * - `database`: the manifest's database dump into `<media>/backups`, where the maintenance restore lists it.
 * - `library`: every file back in its place, as `asset` does for one, and the database dump as `database`.
 */
export type CloudBackupRestoreScope = 'files' | 'asset' | 'album' | 'database' | 'library';

/** Called for a no-op read preflight, then for publication; each guard releases before whole-file I/O. */
export type OwnerRestorePublisher = (
  file: CloudBackupRestoreFile,
  staged: string,
  publish: () => Promise<'written' | 'skipped' | 'replaced'>,
  phase?: 'inspect' | 'publish',
) => Promise<'written' | 'skipped' | 'replaced'>;
export type BackupObjectReader = (
  key: string,
  destination: string,
  sha256: string,
) => Promise<{ size: number; sha256: string }>;

export type CloudBackupRestoreSnapshot = {
  version: 1;
  /** Absent on admin operations. Credentials are never persisted. */
  owner?: {
    ownerId: string;
    sessionId: string;
    assetHashes: Record<string, string>;
    current: Record<
      string,
      { ownerId: string; originalPath: string; checksum: string; checksumAlgorithm: string; isExternal: boolean }
    >;
  };
  bucketRef: string;
  keyFingerprint: string;
  manifestKey: string;
  scope: CloudBackupRestoreScope;
  assetIds: string[] | null;
  /** `album`: the album the members in `assetIds` belong to. */
  albumId?: string | null;
  /** `asset` and `album`: how the details of items still in the library come back; `keep` when absent. */
  details?: RestoreDetailsMode;
};

/** Where a restore has got to, kept on the operation row as its result. */
export type CloudBackupRestoreResult = {
  task: 'restore';
  /** `library`: the files are back; items, details and the album are being put back. */
  phase: 'files' | 'library' | 'database' | 'done';
  /** The last file written, in the plan's order: a resumed restore carries on after it. */
  cursor: string | null;
  files: number;
  filesTotal: number;
  bytes: number;
  bytesTotal: number;
  /** Files already in place with the backed-up content. */
  skipped: number;
  /** Files that were in the way and moved aside. */
  replaced: number;
  /** The folder a `files` restore writes to. */
  destination: string | null;
  /** The dump's name in `<media>/backups`, once it is there. */
  databaseFile: string | null;
  /** Assets whose files went back in place: their thumbnails and previews are made again. */
  restoredAssetIds: string[];
  /** Deleted items made again from their manifest record. */
  recreated: number;
  /** Items still in the library whose details came back. */
  detailsRestored: number;
};

/** One file a restore writes, verified against `sha256` before it lands at `target`. */
export type CloudBackupRestoreFile = {
  fileKey: string;
  assetId: string | null;
  /** The manifest's role for the file: `original`, `sidecar`, a thumbnail, or `profile`. */
  role: string;
  sha256: string;
  size: number;
  target: string;
  inPlace: boolean;
};

/** Scopes that put files back where the library expects them rather than into a restore folder. */
export const IN_PLACE_SCOPES: ReadonlySet<CloudBackupRestoreScope> = new Set(['asset', 'album', 'library']);

export const RESTORE_FOLDER = join('frameleaf', 'restore');
export const RESTORE_REPLACED_FOLDER = join('frameleaf', 'restore', 'replaced');
/** Files written between two checkpoints. */
const RESTORE_BATCH = 25;
/** Assets a restore lists for thumbnails to be made again; the rest are made by the nightly jobs. */
const RESTORED_ASSETS_KEPT = 5000;

export const emptyRestoreResult = (): CloudBackupRestoreResult => ({
  task: 'restore',
  phase: 'files',
  cursor: null,
  files: 0,
  filesTotal: 0,
  bytes: 0,
  bytesTotal: 0,
  skipped: 0,
  replaced: 0,
  destination: null,
  databaseFile: null,
  restoredAssetIds: [],
  recreated: 0,
  detailsRestored: 0,
});

/** Whether `path` is inside `folder`, after resolving `..` and the like. */
const isInside = (folder: string, path: string) => {
  const root = resolve(folder);
  const target = resolve(path);
  return target.startsWith(`${root}${sep}`);
};

/** A file name that cannot climb out of the folder it is written to. */
const safeName = (path: string, fallback: string) => {
  const name = basename(path).replaceAll(/[\0/\\]/g, '_');
  return name && name !== '.' && name !== '..' ? name : fallback;
};

/** The name a restored dump gets in `<media>/backups`: listed by the maintenance restore, never pruned by it. */
export const restoredDumpName = (key: string) => {
  const name = `cloud-restore-${safeName(key, 'database.sql.gz').replace(/^cloud-backup-/, '')}`;
  if (!isValidDatabaseBackupName(name)) {
    throw new Error('The backup names a database dump this server cannot restore.');
  }
  return name;
};

/**
 * The files a restore writes, in a fixed order (`fileKey`), from the manifest and the scope. In-place
 * targets outside the media folder (a manifest from another layout) go to the restore folder instead;
 * an asset's original goes back to where the library expects it now, which a storage template may have
 * changed since the backup. Only assets the manifest holds are restored.
 */
export const restorePlan = (options: {
  manifest: CloudBackupManifest;
  scope: CloudBackupRestoreScope;
  assetIds: string[] | null;
  operationId: string;
  mediaLocation: string;
  currentOriginals: ReadonlyMap<string, string>;
}): { files: CloudBackupRestoreFile[]; destination: string | null } => {
  const { manifest, scope, operationId, mediaLocation } = options;
  if (scope === 'database') {
    return { files: [], destination: null };
  }
  const restoreRoot = join(mediaLocation, RESTORE_FOLDER, operationId);
  const inPlace = IN_PLACE_SCOPES.has(scope);
  const chosen = options.assetIds ? new Set(options.assetIds) : null;
  const files: CloudBackupRestoreFile[] = [];

  for (const [assetId, asset] of Object.entries(manifest.assets)) {
    if (chosen && !chosen.has(assetId)) {
      continue;
    }
    for (const [index, file] of asset.files.entries()) {
      const fileKey = `${assetId}:${String(index).padStart(3, '0')}`;
      const name = `${safeName(file.role, 'file')}-${safeName(file.path, file.sha256)}`;
      const inFolder = join(restoreRoot, safeName(assetId, 'asset'), name);
      let target = inFolder;
      if (inPlace) {
        const current = file.role === 'original' ? options.currentOriginals.get(assetId) : undefined;
        const wanted = current ?? file.path;
        target = isInside(mediaLocation, wanted) ? wanted : inFolder;
      }
      files.push({
        fileKey,
        assetId,
        role: file.role,
        sha256: file.sha256,
        size: file.size,
        target,
        inPlace: inPlace && target !== inFolder,
      });
    }
  }
  if (!chosen) {
    for (const [userId, file] of Object.entries(manifest.profiles)) {
      const inFolder = join(restoreRoot, 'profiles', `${safeName(userId, 'user')}-${safeName(file.path, file.sha256)}`);
      const target = inPlace && isInside(mediaLocation, file.path) ? file.path : inFolder;
      files.push({
        fileKey: `~profile:${userId}`,
        assetId: null,
        role: 'profile',
        sha256: file.sha256,
        size: file.size,
        target,
        inPlace: target !== inFolder,
      });
    }
  }
  return {
    files: files.toSorted((a, b) => compareCodeUnits(a.fileKey, b.fileKey)),
    destination: inPlace ? null : restoreRoot,
  };
};

/**
 * Restores from a manifest (FL-164). Every object is fetched with the bucket key (SSE-C), streamed to a
 * partial file and moved into place only when it hashes to its name; a missing or mismatched object stops
 * the restore, names the object, and leaves everything already restored as it is. A file that is already
 * in place with the backed-up content is left alone. Used by the `cloud_restore` worker and by the
 * `frameleaf-admin cloud-backup restore` command, which has no web app to report to.
 */
export class CloudBackupRestorer {
  constructor(
    private store: Pick<CloudBackupStoreRepository, 'download'> | null,
    private storage: StorageRepository,
    private crypto: CryptoRepository,
    private logger: LoggingRepository,
  ) {}

  async restore(options: {
    bucket?: CloudBackupBucket;
    read?: BackupObjectReader;
    /** Stage on the target volume so external-library publication remains an atomic rename. */
    stageBesideTarget?: boolean;
    manifest: CloudBackupManifest;
    scope: CloudBackupRestoreScope;
    files: CloudBackupRestoreFile[];
    destination: string | null;
    mediaLocation: string;
    backupsFolder: string;
    operationId: string;
    start: CloudBackupRestoreResult;
    checkpoint: CloudBackupCheckpoint<CloudBackupRestoreResult>;
    /** After the files: puts items, details and albums back (`asset` and `album`). Safe to run again. */
    library?: (result: CloudBackupRestoreResult) => Promise<CloudBackupRestoreResult>;
    /** Owner-only mode: stage and verify before invoking a current authorization/target guard. */
    publish?: OwnerRestorePublisher;
    /** Persist verified file evidence before advancing a destination-specific cursor. */
    completedFile?: (file: CloudBackupRestoreFile, outcome: 'written' | 'skipped' | 'replaced') => Promise<void>;
  }): Promise<CloudBackupRestoreResult | null> {
    const { bucket, manifest, scope, files, checkpoint } = options;
    const database = scope === 'database' || scope === 'library' ? manifest.database : null;
    if ((scope === 'database' || scope === 'library') && !database) {
      throw new Error('This backup has no database dump to restore.');
    }
    let result: CloudBackupRestoreResult = {
      ...options.start,
      destination: options.destination,
      filesTotal: files.length + (database ? 1 : 0),
      bytesTotal: files.reduce((total, file) => total + file.size, 0) + (database?.size ?? 0),
    };

    if (result.phase === 'files') {
      const { cursor } = result;
      const pending = cursor ? files.filter((file) => compareCodeUnits(file.fileKey, cursor) > 0) : files;
      for (let at = 0; at < pending.length; at += RESTORE_BATCH) {
        for (const file of pending.slice(at, at + RESTORE_BATCH)) {
          const outcome = await this.restoreFile(bucket, objectKey(file.sha256), file, options);
          await options.completedFile?.(file, outcome);
          result = {
            ...result,
            cursor: file.fileKey,
            files: result.files + 1,
            bytes: result.bytes + file.size,
            skipped: result.skipped + (outcome === 'skipped' ? 1 : 0),
            replaced: result.replaced + (outcome === 'replaced' ? 1 : 0),
            restoredAssetIds:
              file.inPlace &&
              file.assetId &&
              outcome !== 'skipped' &&
              !result.restoredAssetIds.includes(file.assetId) &&
              result.restoredAssetIds.length < RESTORED_ASSETS_KEPT
                ? [...result.restoredAssetIds, file.assetId]
                : result.restoredAssetIds,
          };
          if (options.publish && !(await checkpoint(result))) return null;
        }
        if (!options.publish && !(await checkpoint(result))) {
          return null;
        }
      }
      result = { ...result, phase: 'library' };
      if (!(await checkpoint(result))) {
        return null;
      }
    }

    if (result.phase === 'library') {
      if (options.library) {
        result = await options.library(result);
      }
      result = { ...result, phase: database ? 'database' : 'done' };
    }

    if (result.phase === 'database' && database) {
      const name = restoredDumpName(database.key);
      const target = join(options.backupsFolder, name);
      const outcome = await this.restoreFile(
        bucket,
        database.key,
        {
          fileKey: '~database',
          assetId: null,
          role: 'database',
          sha256: database.sha256,
          size: database.size,
          target,
          inPlace: true,
        },
        options,
      );
      result = {
        ...result,
        phase: 'done',
        databaseFile: name,
        files: result.files + 1,
        bytes: result.bytes + database.size,
        skipped: result.skipped + (outcome === 'skipped' ? 1 : 0),
        replaced: result.replaced + (outcome === 'replaced' ? 1 : 0),
      };
    }
    return result;
  }

  /**
   * One file: left alone when it is already there with the backed-up content; otherwise whatever is there
   * is moved aside only after the object has been downloaded and verified beside the target.
   */
  private async restoreFile(
    bucket: CloudBackupBucket | undefined,
    key: string,
    file: CloudBackupRestoreFile,
    options: {
      mediaLocation: string;
      operationId: string;
      publish?: OwnerRestorePublisher;
      read?: BackupObjectReader;
      stageBesideTarget?: boolean;
    },
  ): Promise<'written' | 'skipped' | 'replaced'> {
    const download: BackupObjectReader =
      options.read ??
      ((object, destination, sha256) => {
        if (!this.store || !bucket) throw new Error('Backup reader unavailable');
        return this.store.download(bucket.connection, object, bucket.bucketKey, destination, sha256);
      });
    if (options.publish) {
      if (options.stageBesideTarget) await options.publish(file, '', () => Promise.resolve('skipped'), 'inspect');
      const staged = options.stageBesideTarget
        ? join(dirname(file.target), `.buddy-restore-${randomUUID()}.tmp`)
        : join(options.mediaLocation, RESTORE_FOLDER, options.operationId, 'staging', randomUUID());
      this.storage.mkdirSync(dirname(staged));
      try {
        const downloaded = await download(key, staged, file.sha256);
        if (downloaded.size !== file.size || downloaded.sha256 !== file.sha256) {
          throw new Error('Owner restore staging size or checksum mismatch');
        }
        // Preflight is not a file outcome and must never enter checkpoint/result accounting.
        await options.publish(file, staged, () => Promise.resolve('skipped'), 'inspect');
        const evidence = await captureOwnerRestoreFile(file.target, async (target) =>
          (await this.crypto.hashFile(target, 'sha256')).toString('hex'),
        );
        const stagedEvidence = await captureOwnerRestoreFile(staged, async (target) =>
          (await this.crypto.hashFile(target, 'sha256')).toString('hex'),
        );
        if (stagedEvidence.sha256 !== file.sha256 || stagedEvidence.size !== BigInt(file.size))
          throw new Error('Owner restore staging size or checksum mismatch');
        return await options.publish(
          file,
          staged,
          async () => {
            await assertOwnerRestoreFile(staged, stagedEvidence.identity);
            await assertOwnerRestoreFile(file.target, evidence.identity);
            const present = evidence.sha256;
            if (present === file.sha256) return 'skipped';
            if (present !== null) {
              // Each owner replacement keeps its own aside copy, including a replay of the same operation.
              await this.moveAside(
                file.target,
                options.mediaLocation,
                join(options.operationId, file.assetId ?? 'item', randomUUID()),
                options.stageBesideTarget,
              );
            }
            this.storage.mkdirSync(dirname(file.target));
            await assertOwnerRestoreFile(file.target, null);
            await assertOwnerRestoreFile(staged, stagedEvidence.identity);
            await this.storage.rename(staged, file.target);
            if (options.stageBesideTarget) await flushBuddyDirectory(dirname(file.target));
            await assertOwnerRestoreFile(file.target, stagedEvidence.identity, true);
            return present === null ? 'written' : 'replaced';
          },
          'publish',
        );
      } finally {
        // A refused guard must never leave verified bytes at the public/current destination.
        if (await this.storage.checkFileExists(staged)) await this.storage.unlink(staged);
      }
    }
    const present = await this.sha256Of(file.target);
    if (present === file.sha256) {
      return 'skipped';
    }
    this.storage.mkdirSync(dirname(file.target));
    const staged = join(dirname(file.target), `.cloud-restore-${randomUUID()}.tmp`);
    try {
      const downloaded = await download(key, staged, file.sha256);
      if (downloaded.size !== file.size || downloaded.sha256 !== file.sha256) {
        throw new Error('Restore staging size or checksum mismatch');
      }
      if (present !== null) {
        await this.moveAside(file.target, options.mediaLocation, options.operationId);
      }
      await this.storage.rename(staged, file.target);
    } catch (error) {
      if (error instanceof CloudBackupStoreError && error.status === 404) {
        throw new Error(`The backup copy of ${key} is missing from the bucket. The restore stopped before it.`, {
          cause: error,
        });
      }
      if (error instanceof CloudBackupStoreError && error.code === 'ChecksumMismatch') {
        throw new Error(`The backup copy of ${key} does not match its checksum. The restore stopped before it.`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      if (await this.storage.checkFileExists(staged)) await this.storage.unlink(staged);
    }
    return present === null ? 'written' : 'replaced';
  }

  private async sha256Of(path: string): Promise<string | null> {
    if (!(await this.storage.checkFileExists(path))) {
      return null;
    }
    return (await this.crypto.hashFile(path, 'sha256')).toString('hex');
  }

  /** Move a file that is in the way to the replaced folder, keeping its path below the media folder. */
  private async moveAside(path: string, mediaLocation: string, operationId: string, besideTarget = false) {
    const below = isInside(mediaLocation, path) ? relative(resolve(mediaLocation), resolve(path)) : basename(path);
    const target = besideTarget
      ? join(dirname(path), `.${basename(path)}.buddy-rollback-${randomUUID()}`)
      : join(mediaLocation, RESTORE_REPLACED_FOLDER, operationId, below);
    this.storage.mkdirSync(dirname(target));
    try {
      await this.storage.rename(path, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw error;
      }
      await this.storage.copyFile(path, target);
      await this.storage.unlink(path);
    }
    if (besideTarget) await flushBuddyDirectory(dirname(path));
    this.logger.log(`Cloud backup restore ${operationId}: moved ${path} aside to ${target}`);
  }
}
