import type { AssetRepository } from 'src/repositories/asset.repository.js';
import type { JobRepository } from 'src/repositories/job.repository.js';
import type { LockedEncryptionRepository } from 'src/repositories/locked-encryption.repository.js';
import type { LockedFileRepository } from 'src/repositories/locked-file.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import { JobName } from 'src/enum.js';

/**
 * FL-721 (spec §7.2), for services outside `BaseService` (which has `queueLockedSeal`): after a job
 * wrote new or derived files for `assetIds`, each one in an encrypted set
 * (`LockedFileRepository.encryptedSetOwner`) is sealed again. A failure to queue never fails the job
 * that wrote the files; the hourly sweep seals them.
 */
export async function queueLockedSealOf(
  deps: {
    lockedFile?: Pick<LockedFileRepository, 'encryptedSetOwner'>;
    job: Pick<JobRepository, 'queueAll'>;
    logger: Pick<LoggingRepository, 'warn'>;
  },
  assetIds: string[],
): Promise<void> {
  if (!deps.lockedFile || assetIds.length === 0) {
    return;
  }
  try {
    const sealed: string[] = [];
    for (const id of new Set(assetIds)) {
      if (await deps.lockedFile.encryptedSetOwner(id)) {
        sealed.push(id);
      }
    }
    if (sealed.length > 0) {
      await deps.job.queueAll(sealed.map((id) => ({ name: JobName.LockedSeal, data: { id } })));
    }
  } catch (error) {
    deps.logger.warn(`Could not queue sealing of new Locked files; the hourly sweep seals them: ${error}`);
  }
}

/** The same, for services that have the `AssetRepository` (`getLockedEncryptionItems`, the same test in bulk). */
export async function queueLockedSealFor(
  deps: {
    asset: Pick<AssetRepository, 'getLockedEncryptionItems'>;
    job: Pick<JobRepository, 'queueAll'>;
    logger: Pick<LoggingRepository, 'warn'>;
  },
  assetIds: string[],
): Promise<void> {
  if (assetIds.length === 0) {
    return;
  }
  try {
    const items = (await deps.asset.getLockedEncryptionItems([...new Set(assetIds)])).filter(({ pending }) => !pending);
    if (items.length > 0) {
      await deps.job.queueAll(items.map(({ id }) => ({ name: JobName.LockedSeal, data: { id } })));
    }
  } catch (error) {
    deps.logger.warn(`Could not queue sealing of new Locked files; the hourly sweep seals them: ${error}`);
  }
}

/**
 * FL-721 (spec §6.2, Ruling 11): `userId`'s key pair was created, replaced or deleted, so the encrypted
 * Locked items of everyone who shares with them may name a key that is gone or miss the new one. Each
 * such owner gets a sweep, which queues the re-wraps (`LockedRewrap` brings every file to exactly the
 * owner and their current partners) once the owner's key is open. A failure to queue never fails the
 * change; the hourly sweep finds the same work.
 */
export async function queueLockedPartnerChecks(
  deps: {
    lockedEncryption: Pick<LockedEncryptionRepository, 'getOwnersSharingWith'>;
    job: Pick<JobRepository, 'queueAll'>;
    logger: Pick<LoggingRepository, 'warn'>;
  },
  userId: string,
): Promise<void> {
  try {
    const owners = await deps.lockedEncryption.getOwnersSharingWith(userId);
    if (owners.length > 0) {
      await deps.job.queueAll(owners.map((ownerId) => ({ name: JobName.LockedSweep, data: { userId: ownerId } })));
    }
  } catch (error) {
    deps.logger.warn(`Could not queue the Locked partner re-wrap checks; the hourly sweep finds them: ${error}`);
  }
}
