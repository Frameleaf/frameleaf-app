import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { FoundFileOutcome, FoundFileReason, FoundFileStep } from 'src/schema/tables/found-file.table.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { FrameleafWorker, StorageFolder } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { type FoundFile, FoundFileRepository } from 'src/repositories/found-file.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { MediaHealthService, type UntrackedPlacement } from 'src/services/media-health.service.js';
import { executionSignal } from 'src/utils/execution-signal.js';
import { fileIdentity } from 'src/utils/file-trash.js';
import { isLockedPath } from 'src/utils/locked-read.js';
import { isPathWithin } from 'src/utils/media-health-roots.js';
import { getErrorMessage } from 'src/utils/media-health.js';
import { mimeTypes } from 'src/utils/mime-types.js';

type Owner = { id: string; quotaSizeInBytes: number | null; quotaUsageInBytes: number; folders: string[] };

/** What sorting one file came to: its outcome, or `skipped` when it was left for the next check. */
type Sorted = FoundFileOutcome | 'skipped';

const OUTCOME: Record<UntrackedPlacement['outcome'], { outcome: FoundFileOutcome; reason: FoundFileReason | null }> = {
  back: { outcome: 'back', reason: null },
  added: { outcome: 'added', reason: null },
  spare: { outcome: 'spare', reason: null },
  'no-owner': { outcome: 'needs', reason: 'no-owner' },
  'over-limit': { outcome: 'needs', reason: 'over-limit' },
};

/**
 * FL-1532: photos found on the drive that no library lists are put back by themselves.
 *
 * The stray-file check hands over what it found. Each photo or video among it is read once, and the
 * file's digests are remembered for the size and modified time it had, so a file that has not changed
 * is never read again. From its contents the file is one of: the original of a photo that went missing
 * (it goes back under that photo), a photo no library has (it is added to the library of the account
 * whose folder it is in), a second copy of a photo that is already there (left where it is), or one a
 * person has to decide about (a folder no account owns, a file that cannot be read, an account that
 * has no room for it). Nothing is moved, renamed or deleted.
 *
 * Previews and other files Frameleaf makes itself are not sorted here.
 */
@Injectable()
export class FoundFilesService {
  constructor(
    private logger: LoggingRepository,
    private foundFileRepository: FoundFileRepository,
    private mediaHealthService: MediaHealthService,
    private cryptoRepository: CryptoRepository,
    private storageRepository: StorageRepository,
    private userRepository: UserRepository,
  ) {
    this.logger.setContext(FoundFilesService.name);
  }

  @OnEvent({ name: 'IntegrityUntrackedFound', workers: [FrameleafWorker.Microservices] })
  async onUntrackedFound({ paths, placed }: ArgOf<'IntegrityUntrackedFound'>): Promise<void> {
    const roots = [StorageFolder.Upload, StorageFolder.Library].map((folder) => StorageCore.getBaseFolder(folder));
    const originals = paths.filter((path) => mimeTypes.isAsset(path) && roots.some((root) => isPathWithin(root, path)));
    if (originals.length === 0) {
      return;
    }
    const owners = await this.owners();
    const known = new Map((await this.foundFileRepository.getByPaths(originals)).map((file) => [file.path, file]));
    /** What this pass already added to each account, which its storage limit has to leave room for. */
    const added = new Map<string, number>();
    const counts: Record<Sorted, number> = { back: 0, added: 0, spare: 0, needs: 0, skipped: 0 };
    for (const path of originals) {
      try {
        const outcome = await this.sort(path, known.get(path), owners, added);
        counts[outcome]++;
        if (outcome === 'back' || outcome === 'added') {
          placed.push(path);
        }
      } catch (error) {
        // a check that was stopped stops here too; any other failure is this file's alone
        executionSignal()?.throwIfAborted();
        counts.skipped++;
        this.logger.warn(`Could not sort found file ${path}: ${getErrorMessage(error)}`);
      }
    }
    this.logger.log(
      `Sorted ${originals.length} found file(s): ${counts.back} put back, ${counts.added} added, ` +
        `${counts.spare} spare, ${counts.needs} waiting for a person, ${counts.skipped} left for the next check`,
    );
  }

  /** Every account's own folders, where its uploads and its sorted originals are kept. */
  private async owners(): Promise<Owner[]> {
    const users = await this.userRepository.getList();
    return users.map((user) => ({
      id: user.id,
      quotaSizeInBytes: user.quotaSizeInBytes,
      quotaUsageInBytes: user.quotaUsageInBytes,
      folders: [StorageCore.getFolderLocation(StorageFolder.Upload, user.id), StorageCore.getLibraryFolder(user)],
    }));
  }

  private async sort(
    path: string,
    known: FoundFile | undefined,
    owners: Owner[],
    added: Map<string, number>,
  ): Promise<Sorted> {
    if (await isLockedPath(path)) {
      // FL-721: a sealed Locked file is never brought back as a new photo of its ciphertext
      return 'skipped';
    }
    const settled = await this.mediaHealthService.settledUntrackedFile(path);
    if (!settled) {
      return 'skipped';
    }
    const at = () => new Date().toISOString();
    const unchanged =
      !!known &&
      Number(known.sizeInBytes) === settled.size &&
      new Date(known.modifiedAt).getTime() === settled.mtime.getTime();
    const steps: FoundFileStep[] = unchanged ? [...known.steps] : [{ step: 'found', at: at() }];
    const owner = owners.find(({ folders }) => folders.some((folder) => isPathWithin(folder, path)));
    const about = { path, sizeInBytes: settled.size, modifiedAt: settled.mtime, ownerId: owner?.id ?? null };

    let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
    if (unchanged) {
      if (!known.sha1 || !known.sha256) {
        // it could not be read, and it is the same file: reading it again gives the same answer
        return known.outcome;
      }
      digests = { sha1: known.sha1, sha256: known.sha256, sizeInBytes: settled.size };
    } else {
      try {
        digests = await this.cryptoRepository.hashFileDigests(path);
      } catch (error) {
        executionSignal()?.throwIfAborted();
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          return 'skipped';
        }
        await this.foundFileRepository.upsert({
          ...about,
          sha1: null,
          sha256: null,
          outcome: 'needs',
          reason: 'wont-open' satisfies FoundFileReason,
          assetId: null,
          previousPath: null,
          steps: [...steps, { step: 'read', at: at(), outcome: 'failed', facts: { error: code ?? 'unreadable' } }],
        });
        return 'needs';
      }
      // the digests speak for the file only if it is still the same file, unchanged, that was read
      const after = await fileIdentity(this.storageRepository, path);
      if (!after || after.key !== settled.key || digests.sizeInBytes !== settled.size) {
        return 'skipped';
      }
      steps.push({ step: 'read', at: at(), outcome: 'ok' });
    }

    const placement = await this.mediaHealthService.placeUntrackedFile(
      owner ?? null,
      path,
      settled.mtime,
      digests,
      owner ? (added.get(owner.id) ?? 0) : 0,
    );
    if (placement.outcome === 'added' && owner) {
      added.set(owner.id, (added.get(owner.id) ?? 0) + digests.sizeInBytes);
    }
    const { outcome, reason } = OUTCOME[placement.outcome];
    if (unchanged && known.outcome === outcome && known.reason === reason) {
      // the same file with the same answer: nothing new to remember
      return outcome;
    }
    const assetId = 'assetId' in placement ? (placement.assetId ?? null) : null;
    const previousPath = placement.outcome === 'back' ? placement.previousPath : null;
    await this.foundFileRepository.upsert({
      ...about,
      sha1: digests.sha1,
      sha256: digests.sha256,
      outcome,
      reason,
      assetId,
      previousPath,
      steps: [
        ...steps,
        {
          step: placement.outcome,
          at: at(),
          ...(previousPath && { facts: { previousPath } }),
        },
      ],
    });
    return outcome;
  }
}
