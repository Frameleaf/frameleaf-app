import { dirname, extname, join } from 'node:path';
import type { CryptoRepository } from 'src/repositories/crypto.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { ChecksumAlgorithm, StorageFolder } from 'src/enum.js';
import { CloudBackupStoreError } from 'src/repositories/cloud-backup-store.repository.js';
import { ManagedBackupAuthorizationError } from 'src/utils/managed-backup-session.js';
import { LIBRARY_CARE_FOLDER, isPathWithin, publishVerifiedCopy, retainFile } from 'src/utils/media-health-roots.js';
import { getErrorMessage } from 'src/utils/media-health.js';

/**
 * Cloud Backup's answer to Library care's "put this original back" (FL-1337):
 * - `restored`: the photo's own bytes are at its path again (or already were).
 * - `not-in-backup`: no kept backup holds them.
 * - `busy`: a backup operation or restore holds the bucket, or it could not be reached: ask again later.
 * - `not-set-up`: there is no Cloud Backup this server can read now.
 * - `skipped`: never restored this way (Locked, an external library's, in the trash, or not a stored file).
 */
export type LostOriginalOutcome = 'restored' | 'not-in-backup' | 'busy' | 'not-set-up' | 'skipped';

export type LostOriginalRestore = {
  outcome: LostOriginalOutcome;
  /** `restored` and `not-in-backup`: when the oldest kept Cloud Backup began (ISO), when there is one. */
  since?: string;
  /** `restored`: where a changed file that was at the original's path was moved aside, when one was. */
  retainedPath?: string;
};

/** The asset as a system restore reads it. */
export type LostOriginalTarget = {
  assetId: string;
  ownerId: string;
  originalPath: string;
  /** The photo's own checksum: SHA-256 for new uploads, SHA-1 for older ones. */
  checksum: Buffer;
  checksumAlgorithm: ChecksumAlgorithm;
  isExternal: boolean;
  active: boolean;
  locked: boolean;
};

type Crypto = Pick<CryptoRepository, 'hashFileMatching' | 'hashFileDigests'>;

const FILE_CHECKSUMS: ReadonlySet<ChecksumAlgorithm> = new Set([
  ChecksumAlgorithm.sha1File,
  ChecksumAlgorithm.sha256File,
]);

/**
 * Whether a system restore may put this asset's original back: an item in the library, neither Locked (its
 * backed-up bytes are sealed, and the owner keeps Locked items in their own hands) nor in an external library
 * (Library care never writes there), whose checksum is of the file's contents, stored in Frameleaf's folders.
 */
export const isRestorableOriginal = (target: LostOriginalTarget) =>
  target.active &&
  !target.locked &&
  !target.isExternal &&
  FILE_CHECKSUMS.has(target.checksumAlgorithm) &&
  [StorageFolder.Upload, StorageFolder.Library].some((folder) =>
    isPathWithin(StorageCore.getBaseFolder(folder), target.originalPath),
  );

/**
 * The backups to try, newest first: one per distinct backed-up file, so the same bytes are never fetched
 * twice. A SHA-256 checksum names the photo's own file outright; an older SHA-1 one needs each fetched to tell.
 */
export const lostOriginalCandidates = <T extends { sha256: string }>(rows: T[], checksum: Buffer): T[] => {
  const own = checksum.length === 32 ? checksum.toString('hex') : undefined;
  const seen = new Set<string>();
  return rows.filter((row) => {
    if ((own && row.sha256 !== own) || seen.has(row.sha256)) {
      return false;
    }
    seen.add(row.sha256);
    return true;
  });
};

/** A backup that does not hold what it names: the object is gone, or it does not hash to its name. */
export const backupLacksFile = (error: unknown) =>
  error instanceof CloudBackupStoreError &&
  (error.status === 404 || error.code === 'NoSuchKey' || error.code === 'ChecksumMismatch');

/** The bucket could not be read just now (unreachable, refused or an expired key): never a verdict on a backup. */
export const bucketUnavailable = (error: unknown) =>
  error instanceof ManagedBackupAuthorizationError ||
  (error instanceof CloudBackupStoreError && !backupLacksFile(error));

/** The file's digest in its checksum's algorithm, or null when nothing is at that path. */
const digestOf = async (crypto: Crypto, file: string, checksum: Buffer): Promise<Buffer | null> => {
  try {
    return await crypto.hashFileMatching(file, checksum);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

/** Whether the photo's own bytes are at its path now. */
export const holdsOwnBytes = async (crypto: Crypto, target: LostOriginalTarget) =>
  !!(await digestOf(crypto, target.originalPath, target.checksum))?.equals(target.checksum);

/**
 * Put a downloaded copy, already proven to be the photo's own bytes, at the original's path; never over
 * anything. A changed file there is moved aside first into the owner's Library care folder, as a repair keeps
 * a damaged file, and put back if the copy cannot be placed. The photo's own bytes already there are left as
 * they are. Answers where a moved file went.
 */
export const placeLostOriginal = async (
  deps: { crypto: Crypto; logger: LoggingRepository },
  target: LostOriginalTarget,
  staged: string,
): Promise<{ retainedPath?: string }> => {
  const { crypto, logger } = deps;
  const present = await digestOf(crypto, target.originalPath, target.checksum);
  if (present?.equals(target.checksum)) {
    return {};
  }
  let retainedPath: string | undefined;
  if (present) {
    const extension = extname(target.originalPath).toLowerCase();
    retainedPath = join(
      dirname(StorageCore.getNestedPath(StorageFolder.Upload, target.ownerId, target.assetId)),
      LIBRARY_CARE_FOLDER,
      `${target.assetId}-${present.toString('hex').slice(0, 8)}.damaged${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''}`,
    );
    // never replaces, and removes the changed file's old name only once the new one holds the same bytes
    await retainFile(target.originalPath, retainedPath);
  }
  try {
    await publishVerifiedCopy({
      source: staged,
      destination: target.originalPath,
      expected: await crypto.hashFileDigests(staged),
      hash: (file) => crypto.hashFileDigests(file),
    });
  } catch (error) {
    if (retainedPath) {
      // the path stays as it was: the changed file goes back, unless something else is there by now
      await retainFile(retainedPath, target.originalPath).catch((error_: unknown) =>
        logger.warn(
          `Library care kept the changed file of ${target.assetId} at ${retainedPath}: ${getErrorMessage(error_)}`,
        ),
      );
    }
    throw error;
  }
  return retainedPath ? { retainedPath } : {};
};
