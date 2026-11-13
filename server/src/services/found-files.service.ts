import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { basename } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  FoundFileDetailResponseDto,
  FoundFileListDto,
  FoundFileListResponseDto,
  FoundFileResponseDto,
  FoundFilesDeleteSpareDto,
  FoundFilesDeleteSpareResponseDto,
  FoundFilesResolveDto,
  FoundFilesResolveResponseDto,
  FoundFilesSummaryResponseDto,
} from 'src/dtos/found-file.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { FoundFileOutcome, FoundFileReason, FoundFileStep } from 'src/schema/tables/found-file.table.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { AssetFileType, AssetStatus, CacheControl, FrameleafWorker, JobName, StorageFolder } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { type FoundFile, type FoundFileListed, FoundFileRepository } from 'src/repositories/found-file.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { MediaHealthService, type UntrackedPlacement } from 'src/services/media-health.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { executionSignal } from 'src/utils/execution-signal.js';
import { fileIdentity, moveFileWithin } from 'src/utils/file-trash.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { isLockedPath } from 'src/utils/locked-read.js';
import { isPathWithin } from 'src/utils/media-health-roots.js';
import { getErrorMessage } from 'src/utils/media-health.js';
import { mimeTypes } from 'src/utils/mime-types.js';

type Owner = { id: string; quotaSizeInBytes: number | null; quotaUsageInBytes: number; folders: string[] };

/** What sorting one file came to: its outcome, or `skipped` when it was left for the next check. */
type Sorted = 'back' | 'added' | 'spare' | 'needs' | 'skipped';

const OUTCOME: Record<
  UntrackedPlacement['outcome'],
  { outcome: Exclude<Sorted, 'skipped'>; reason: FoundFileReason | null }
> = {
  back: { outcome: 'back', reason: null },
  added: { outcome: 'added', reason: null },
  spare: { outcome: 'spare', reason: null },
  'no-owner': { outcome: 'needs', reason: 'no-owner' },
  'over-limit': { outcome: 'needs', reason: 'over-limit' },
  'wont-open': { outcome: 'needs', reason: 'wont-open' },
};

/**
 * A preview (`<photo>_preview.jpeg`) or a playback copy (`<photo>.mp4`) Frameleaf made, named after the
 * photo it was made from. Nothing else in those folders is touched: a person's face picture, say, is
 * named after the person.
 */
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const MADE_FOR_ASSET: [StorageFolder, RegExp][] = [
  [StorageFolder.Thumbnails, new RegExp(`^${UUID}_`)],
  [StorageFolder.EncodedVideo, new RegExp(String.raw`^${UUID}\.`)],
];

/** How many files one request decides or deletes; the caller asks again with the cursor it is given. */
const DECIDE_BATCH = 50;
const DELETE_BATCH = 25;

const now = () => new Date().toISOString();

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
 * FL-1537: files Frameleaf makes itself are tidied instead: a preview whose photo is gone is cleared,
 * and an XMP file beside an original of the same name is joined to that photo. A person can look at
 * what was done, undo it, and decide about the files that wait.
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
    private assetRepository: AssetRepository,
    private physicalFileRepository: PhysicalFileRepository,
    private jobRepository: JobRepository,
    private integrityRepository: IntegrityRepository,
    private mediaIntegrityService: MediaIntegrityService,
  ) {
    this.logger.setContext(FoundFilesService.name);
  }

  @OnEvent({ name: 'IntegrityUntrackedFound', workers: [FrameleafWorker.Microservices] })
  async onUntrackedFound({ paths, placed }: ArgOf<'IntegrityUntrackedFound'>): Promise<void> {
    const roots = [StorageFolder.Upload, StorageFolder.Library].map((folder) => StorageCore.getBaseFolder(folder));
    const originals = paths.filter((path) => mimeTypes.isAsset(path) && roots.some((root) => isPathWithin(root, path)));
    const settings = await this.mediaHealthService.careSettings();
    try {
      await this.tidy(paths, roots, placed, settings.clearGonePreviews);
    } catch (error) {
      // tidying is a courtesy: when it fails, the files are listed as they were before
      executionSignal()?.throwIfAborted();
      this.logger.warn(`Could not tidy previews and XMP files: ${getErrorMessage(error)}`);
    }
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
        const outcome = await this.sort(path, known.get(path), owners, added, settings.putBackFoundFiles);
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
    putBack: boolean,
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
    if (unchanged && known.outcome === 'left') {
      // FL-1537: a person undid what was done with this file, or left it; it is not offered again
      return 'skipped';
    }
    const steps: FoundFileStep[] = unchanged ? [...known.steps] : [{ step: 'found', at: at() }];
    const owner = owners.find(({ folders }) => folders.some((folder) => isPathWithin(folder, path)));
    const about = { path, sizeInBytes: settled.size, modifiedAt: settled.mtime, ownerId: owner?.id ?? null };

    let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
    if (unchanged) {
      if (!known.sha1 || !known.sha256) {
        // it could not be read, and it is the same file: reading it again gives the same answer
        return 'needs';
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

    if (!putBack) {
      // FL-1537: switched off, so the file is read and remembered, and waits to be asked
      if (!unchanged || known.outcome !== 'needs' || known.reason !== 'asked') {
        await this.foundFileRepository.upsert({
          ...about,
          sha1: digests.sha1,
          sha256: digests.sha256,
          outcome: 'needs',
          reason: 'asked' satisfies FoundFileReason,
          assetId: null,
          previousPath: null,
          steps,
        });
      }
      return 'needs';
    }

    const placement = await this.mediaHealthService.placeUntrackedFile(
      owner ?? null,
      path,
      settled.mtime,
      digests,
      owner ? (added.get(owner.id) ?? 0) : 0,
      { checkOpens: true },
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

  /**
   * FL-1537: the files Frameleaf makes itself, among what the check found. A preview or playback copy
   * whose photo is gone is deleted; an XMP file beside an original of the same name becomes that photo's.
   * Neither is a finding. One file's failure is its own.
   */
  private async tidy(paths: string[], originalRoots: string[], placed: string[], clearPreviews: boolean) {
    const made = MADE_FOR_ASSET.map(([folder, name]) => ({ root: StorageCore.getBaseFolder(folder), name }));
    const previews = clearPreviews
      ? paths.flatMap((path) => {
          const id = made.find(({ root }) => isPathWithin(root, path))?.name.exec(basename(path))?.[1];
          return id ? [{ path, id }] : [];
        })
      : [];
    const sidecars = paths.filter(
      (path) => path.toLowerCase().endsWith('.xmp') && originalRoots.some((root) => isPathWithin(root, path)),
    );
    if (previews.length === 0 && sidecars.length === 0) {
      return;
    }
    let cleared = 0;
    let joined = 0;
    const tidied = async (path: string, reason: FoundFileReason, size: number, mtime: Date, assetId: string) => {
      await this.foundFileRepository.upsert({
        path,
        sizeInBytes: size,
        modifiedAt: mtime,
        sha1: null,
        sha256: null,
        outcome: 'tidied',
        reason,
        ownerId: null,
        assetId,
        previousPath: null,
        steps: [{ step: reason === 'preview' ? 'cleared' : 'joined', at: now() }],
      });
      placed.push(path);
    };

    const present = await this.foundFileRepository.existingAssetIds(previews.map(({ id }) => id));
    for (const { path, id } of previews) {
      if (present.has(id)) {
        continue;
      }
      try {
        // a preview written moments ago may be of a photo that is still arriving
        const settled = await this.mediaHealthService.settledUntrackedFile(path);
        if (!settled) {
          continue;
        }
        await this.physicalFileRepository.deleteUnreferencedPath(path, () => this.storageRepository.unlink(path));
        if (await this.storageRepository.checkFileExists(path)) {
          continue;
        }
        await tidied(path, 'preview', settled.size, settled.mtime, id);
        cleared++;
      } catch (error) {
        executionSignal()?.throwIfAborted();
        this.logger.warn(`Could not clear the preview ${path}: ${getErrorMessage(error)}`);
      }
    }

    // ponytail: only `photo.jpg.xmp` beside `photo.jpg`, the name Frameleaf and Immich write. `photo.xmp`
    // needs a search by name without its ending; add it if such files turn up in the list.
    const beside = new Map(sidecars.map((path) => [path.slice(0, -'.xmp'.length), path]));
    for (const asset of await this.foundFileRepository.assetsWithoutSidecar(beside.keys().toArray())) {
      const path = beside.get(asset.originalPath)!;
      try {
        if (await isLockedPath(path)) {
          continue;
        }
        const settled = await this.mediaHealthService.settledUntrackedFile(path);
        if (!settled) {
          continue;
        }
        await this.assetRepository.upsertFile({ assetId: asset.id, type: AssetFileType.Sidecar, path });
        await this.jobRepository.queue({ name: JobName.SidecarCheck, data: { id: asset.id } });
        await tidied(path, 'sidecar', settled.size, settled.mtime, asset.id);
        joined++;
      } catch (error) {
        executionSignal()?.throwIfAborted();
        this.logger.warn(`Could not join the XMP file ${path} to its photo: ${getErrorMessage(error)}`);
      }
    }
    if (cleared > 0 || joined > 0) {
      this.logger.log(`Tidied ${cleared} preview(s) of photos that are gone and ${joined} XMP file(s)`);
    }
  }

  /** FL-1537: how many found files each outcome holds, and the groups that wait for a decision. */
  async getSummary(): Promise<FoundFilesSummaryResponseDto> {
    const counts = await this.foundFileRepository.counts();
    const of = (outcome: FoundFileOutcome, reason?: FoundFileReason) =>
      counts.filter((row) => row.outcome === outcome && (!reason || row.reason === reason));
    const total = (rows: typeof counts, key: 'count' | 'sizeInBytes' = 'count') =>
      rows.reduce((sum, row) => sum + row[key], 0);
    const groups = await this.foundFileRepository.needsGroups();
    return {
      back: total(of('back')),
      added: total(of('added')),
      spare: total(of('spare')),
      spareSizeInBytes: total(of('spare'), 'sizeInBytes'),
      needs: total(of('needs')),
      left: total(of('left')),
      tidied: {
        previews: total(of('tidied', 'preview')),
        previewSizeInBytes: total(of('tidied', 'preview'), 'sizeInBytes'),
        sidecars: total(of('tidied', 'sidecar')),
      },
      groups: groups.map((group) => ({ ...group, reason: group.reason as FoundFilesSummaryGroupReason })),
    };
  }

  async list(auth: AuthDto, dto: FoundFileListDto): Promise<FoundFileListResponseDto> {
    const size = dto.size ?? 100;
    const files = await this.foundFileRepository.list({ ...dto, size });
    return {
      items: files.map((file) => this.map(auth, file)),
      nextCursor: files.length === size ? files.at(-1)!.id : null,
    };
  }

  async get(auth: AuthDto, id: string): Promise<FoundFileDetailResponseDto> {
    const file = await this.find(id);
    return { ...this.map(auth, file), previousPath: file.previousPath, steps: file.steps };
  }

  /** The file itself, for its picture. Another account's file is never sent to an administrator. */
  async getFile(auth: AuthDto, id: string): Promise<FileDownloadResponse> {
    const file = await this.find(id);
    this.requireViewable(auth, file);
    return new FileDownloadResponse({
      path: file.path,
      fileName: basename(file.path),
      contentType: mimeTypes.lookup(file.path),
      cacheControl: CacheControl.PrivateWithoutCache,
    });
  }

  /**
   * Undo what was done by itself. A file that went back under a missing photo: the photo points where
   * it did before, and is missing again. A file that was added: the photo leaves the library. Either
   * way the file stays on the drive, untouched, and is not sorted again while it is the same file.
   */
  async undo(auth: AuthDto, id: string): Promise<FoundFileDetailResponseDto> {
    const file = await this.find(id);
    this.requireViewable(auth, file);
    if (file.outcome === 'back' && file.assetId && file.previousPath) {
      const reverted = await this.physicalFileRepository.revertRestoredOriginal({
        assetId: file.assetId,
        foundPath: file.path,
        previousPath: file.previousPath,
      });
      if (!reverted) {
        throw new BadRequestException('The photo has changed since this file was put back');
      }
    } else if (file.outcome === 'added' && file.assetId) {
      const asset = await this.assetRepository.getById(file.assetId);
      if (asset?.isLocked) {
        // FL-721: its file may be sealed by now; taking it out would leave only what nobody can open
        throw new BadRequestException('This photo is Locked now and cannot be taken out of the library from here');
      }
      if (asset && asset.originalPath !== file.path) {
        // the photo's file was moved to its dated folder since: that is the file to leave alone now
        const stat = await this.storageRepository.stat(asset.originalPath);
        await this.foundFileRepository.upsert({
          ...this.remembered(file),
          path: asset.originalPath,
          sizeInBytes: stat.size,
          modifiedAt: stat.mtime,
          outcome: 'left',
          steps: [...file.steps, { step: 'undone', at: now(), facts: { was: 'added' } }],
        });
      }
      if (asset) {
        // out of the library for good, and its file is kept: only what Frameleaf made from it goes
        await this.assetRepository.updateAll([asset.id], { deletedAt: new Date(), status: AssetStatus.Deleted });
        await this.jobRepository.queue({ name: JobName.AssetDelete, data: { id: asset.id, deleteOnDisk: false } });
      }
    } else {
      throw new BadRequestException('Nothing was done with this file that can be undone');
    }
    await this.foundFileRepository.upsert({
      ...this.remembered(file),
      outcome: 'left',
      reason: null,
      steps: [...file.steps, { step: 'undone', at: now(), facts: { was: file.outcome } }],
    });
    return this.get(auth, id);
  }

  /**
   * One decision for a group of files that wait: the account a folder's files go to, adding over an
   * account's storage limit this once, or sorting what was held back while putting back was off. A
   * batch per call; the caller asks again with `nextCursor` until it is null.
   */
  async resolve(dto: FoundFilesResolveDto): Promise<FoundFilesResolveResponseDto> {
    if (dto.reason === 'no-owner' && (!dto.ownerId || !dto.folder)) {
      throw new BadRequestException('Choose the folder and the account its photos go to');
    }
    const files = await this.foundFileRepository.list({
      outcome: 'needs',
      reason: dto.reason,
      folder: dto.reason === 'no-owner' ? dto.folder : undefined,
      ownerId: dto.reason === 'no-owner' ? undefined : dto.ownerId,
      cursor: dto.cursor,
      size: DECIDE_BATCH,
    });
    const users = new Map((await this.userRepository.getList()).map((user) => [user.id, user]));
    if (dto.reason === 'no-owner' && !users.has(dto.ownerId!)) {
      throw new BadRequestException('That account is not on this server');
    }
    const result = { back: 0, added: 0, spare: 0, waiting: 0, skipped: 0 };
    const added = new Map<string, number>();
    for (const file of files) {
      const ownerId = dto.reason === 'no-owner' ? dto.ownerId! : file.ownerId;
      const owner = ownerId ? users.get(ownerId) : undefined;
      try {
        const settled = await this.unchanged(file);
        if (!settled || !file.sha1 || !file.sha256 || (await isLockedPath(file.path))) {
          result.skipped++;
          continue;
        }
        const placement = await this.mediaHealthService.placeUntrackedFile(
          owner ?? null,
          file.path,
          settled.mtime,
          { sha1: file.sha1, sha256: file.sha256, sizeInBytes: settled.size },
          owner ? (added.get(owner.id) ?? 0) : 0,
          { ignoreQuota: dto.reason === 'over-limit', checkOpens: true },
        );
        const { outcome, reason } = OUTCOME[placement.outcome];
        if (outcome === 'needs' && reason === file.reason) {
          result.waiting++;
          continue;
        }
        if (placement.outcome === 'added' && owner) {
          added.set(owner.id, (added.get(owner.id) ?? 0) + settled.size);
        }
        const previousPath = placement.outcome === 'back' ? placement.previousPath : null;
        await this.foundFileRepository.upsert({
          ...this.remembered(file),
          ownerId: owner?.id ?? file.ownerId,
          outcome,
          reason,
          assetId: 'assetId' in placement ? (placement.assetId ?? null) : null,
          previousPath,
          steps: [
            ...file.steps,
            { step: 'decided', at: now(), facts: { decision: dto.reason } },
            { step: placement.outcome, at: now(), ...(previousPath && { facts: { previousPath } }) },
          ],
        });
        if (outcome === 'back' || outcome === 'added') {
          await this.integrityRepository.deleteUntrackedByPaths([file.path]);
        }
        result[outcome === 'needs' ? 'waiting' : outcome]++;
      } catch (error) {
        result.skipped++;
        this.logger.warn(`Could not sort found file ${file.path}: ${getErrorMessage(error)}`);
      }
    }
    return { ...result, nextCursor: files.length === DECIDE_BATCH ? files.at(-1)!.id : null };
  }

  /**
   * Delete spare copies. Each is deleted only after the photo it copies is shown to be in a library,
   * with the same contents, and to open; the copy itself must be the file that was read. A copy that
   * fails any of that is kept.
   */
  async deleteSpares(dto: FoundFilesDeleteSpareDto): Promise<FoundFilesDeleteSpareResponseDto> {
    const files = dto.ids
      ? (await Promise.all(dto.ids.map((id) => this.foundFileRepository.get(id)))).filter(
          (file): file is FoundFileListed => file?.outcome === 'spare',
        )
      : await this.foundFileRepository.list({ outcome: 'spare', cursor: dto.cursor, size: DELETE_BATCH });
    const result = { deleted: 0, freedBytes: 0, kept: 0 };
    for (const file of files) {
      try {
        if (await this.deleteSpare(file)) {
          result.deleted++;
          result.freedBytes += Number(file.sizeInBytes);
        } else {
          result.kept++;
        }
      } catch (error) {
        result.kept++;
        this.logger.warn(`Kept the spare copy ${file.path}: ${getErrorMessage(error)}`);
      }
    }
    return { ...result, nextCursor: !dto.ids && files.length === DELETE_BATCH ? files.at(-1)!.id : null };
  }

  private async deleteSpare(file: FoundFile): Promise<boolean> {
    const settled = await this.unchanged(file);
    if (!settled || !file.sha1 || !file.sha256 || (await isLockedPath(file.path))) {
      return false;
    }
    if ((await this.integrityRepository.getTrackedPaths([file.path])).length > 0) {
      // something uses this very file now: it is no spare
      return false;
    }
    const expected = { sha1: file.sha1, sha256: file.sha256, sizeInBytes: settled.size };
    const copies = await this.assetRepository.getByChecksumsForAnyOwner([file.sha1, file.sha256]);
    let kept = false;
    for (const asset of copies) {
      if (asset.deletedAt || asset.status !== AssetStatus.Active || asset.originalPath === file.path) {
        continue;
      }
      const check = await this.mediaIntegrityService.validate({
        path: asset.originalPath,
        originalFileName: basename(asset.originalPath),
        type: mimeTypes.assetType(asset.originalPath),
        expected,
        deep: true,
      });
      if (check.status === 'healthy') {
        kept = true;
        break;
      }
    }
    if (!kept) {
      return false;
    }
    await this.physicalFileRepository.deleteUnreferencedPath(
      file.path,
      () => this.storageRepository.unlink(file.path),
      {
        trash: { move: (from, to) => moveFileWithin(this.storageRepository, from, to) },
      },
    );
    if (await this.storageRepository.checkFileExists(file.path)) {
      return false;
    }
    await this.foundFileRepository.delete(file.id);
    await this.integrityRepository.deleteUntrackedByPaths([file.path]);
    return true;
  }

  /** The file as it is now, when it is still the file that was read; null when it changed or went. */
  private async unchanged(file: FoundFile) {
    const settled = await this.mediaHealthService.settledUntrackedFile(file.path);
    return settled &&
      settled.size === Number(file.sizeInBytes) &&
      settled.mtime.getTime() === new Date(file.modifiedAt).getTime()
      ? settled
      : null;
  }

  /** What is known about the file, to write back with a change. */
  private remembered(file: FoundFile) {
    const { id: _id, sortedAt: _sortedAt, effectiveOwnerId: _owner, ...known } = file as FoundFileListed;
    return known;
  }

  private async find(id: string): Promise<FoundFileListed> {
    const file = await this.foundFileRepository.get(id);
    if (!file || file.outcome === 'tidied') {
      throw new NotFoundException('Found file not found');
    }
    return file;
  }

  /** A file is its account's to see: its folder's account, else its photo's. One with neither is anyone's. */
  private viewable(auth: AuthDto, file: FoundFileListed): boolean {
    return !file.effectiveOwnerId || file.effectiveOwnerId === auth.user.id;
  }

  private requireViewable(auth: AuthDto, file: FoundFileListed): void {
    if (!this.viewable(auth, file)) {
      throw new ForbiddenException('This file belongs to another account');
    }
  }

  private map(auth: AuthDto, file: FoundFileListed): FoundFileResponseDto {
    return {
      id: file.id,
      fileName: basename(file.path),
      path: file.path,
      sizeInBytes: Number(file.sizeInBytes),
      outcome: file.outcome as FoundFileResponseDto['outcome'],
      reason: file.reason as FoundFileResponseDto['reason'],
      ownerId: file.effectiveOwnerId,
      assetId: file.assetId,
      viewable: this.viewable(auth, file),
      sortedAt: new Date(file.sortedAt).toISOString(),
    };
  }
}

type FoundFilesSummaryGroupReason = FoundFilesSummaryResponseDto['groups'][number]['reason'];
