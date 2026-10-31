import type { AssetRepository } from 'src/repositories/asset.repository.js';
import type { JobRepository } from 'src/repositories/job.repository.js';
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
