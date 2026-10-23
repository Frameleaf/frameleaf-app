import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join, parse, relative, sep } from 'node:path';
import { v5 } from 'uuid';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { JobOf } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import {
  IdenticalFilesChangeDto,
  IdenticalFilesProblemKind,
  IdenticalFilesStage,
  IdenticalFilesState,
  IdenticalFilesStatusDto,
  IdenticalFilesTrigger,
  emptyIdenticalFilesCounts,
} from 'src/dtos/identical-files.dto.js';
import {
  AlbumUserRole,
  AssetFileType,
  AssetVisibility,
  ChecksumAlgorithm,
  DatabaseLock,
  DuplicateDecisionKind,
  JobName,
  JobStatus,
  MediaOperationBulkAction,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { advanceJobProgress, jobSignal } from 'src/queue/context.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import {
  IdenticalFilesContent,
  IdenticalFilesMember,
  IdenticalFilesOriginal,
  IdenticalFilesRepository,
} from 'src/repositories/identical-files.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileTrashRepository } from 'src/repositories/physical-file-trash.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { fileIdentity, moveFileWithin, verifyStoredCopy } from 'src/utils/file-trash.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/** The album every recovered photo goes into, exactly as the owner named it (not translated). */
export const RECOVERED_MEDIA_ALBUM = 'Recovered Media';
/** Photos read per batch; the run's cursor is saved after every batch. */
export const IDENTICAL_FILES_BATCH = 100;
/** Files walked per orphan batch. */
export const IDENTICAL_FILES_WALK_BATCH = 500;
/** Problems the report keeps; the counts keep counting past it. */
export const IDENTICAL_FILES_PROBLEMS_KEPT = 200;
/** A file changed this recently may be an upload still being written: never an orphan yet. */
export const ORPHAN_SETTLE_MS = 60 * 60_000;
/** Groups per duplicate decision job, well under the bulk job's own limit. */
const MERGE_GROUPS_PER_JOB = 200;
const RUN_NAMESPACE = 'b1f2c0a4-4c55-4d39-9b0d-4d7d1d3f1a11';

const STAGES: IdenticalFilesStage[] = ['scan', 'link', 'merge', 'orphans', 'done'];

type ContentKey = string;
const contentKey = (content: IdenticalFilesContent): ContentKey =>
  `${content.sha256.toString('hex')}:${content.sizeInBytes}`;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * FL-413: identical files are stored once, automatically, for the whole server. There is no account to
 * choose: storage is global (owner, 2026-10-15).
 *
 * One run (`IdenticalFilesCheck`, on the storage queue so it never interleaves with storage template
 * moves and pauses with a library move) works through five stages, saving its stage and cursor after
 * every batch, so a restart, a pause or a lost worker carries on where it stopped:
 *
 * 1. **scan**: every managed original is read once: SHA-1, SHA-256 and size. The stored checksum must
 *    match (a mismatch or an unreadable file is a problem and the photo is left alone). The digests are
 *    recorded, SHA-1 records are upgraded to SHA-256 (devices keep seeing the SHA-1), and a file with no
 *    storage record gets one.
 * 2. **link**: files with the same SHA-256 and size across people share the oldest (the photo added
 *    first whose file is still there and unchanged). Each other person keeps their own photo, pointed at
 *    that file; their own copy moves to Unused files once nothing uses it. Both files are proved from disk
 *    first, and the kept file is checked unchanged again under the locks of the link.
 * 3. **merge**: two identical photos in one library become one: the oldest is kept and the other goes to
 *    the Trash through a duplicate decision job (FL-61), which carries albums, tags, favourite, rating and
 *    description over and can be undone. Pairs it cannot carry over (edits, stacks, Live Photo motion,
 *    shares, partner copies, face corrections, a different Locked state, an undone merge) are listed
 *    "check before merging" and grouped for Duplicate review instead.
 * 4. **orphans**: media files in the managed folders that nothing points at. The owner comes from the
 *    folder. Content already in the owner's library goes to Unused files; content in someone else's comes
 *    back as a photo sharing that file; anything else is imported in place. Every recovered photo goes
 *    into the owner's "Recovered Media" album. Damaged files are not imported: they go to Unused files.
 * 5. **done**: the report.
 *
 * No step deletes a file: extra copies go to Unused files, which only an administrator empties. External
 * libraries are never touched. Every link is journalled (`identical_file_change`) and can be undone; an
 * undone link or merge is never redone automatically.
 */
@Injectable()
export class IdenticalFilesService {
  constructor(
    private logger: LoggingRepository,
    private repository: IdenticalFilesRepository,
    private assetRepository: AssetRepository,
    private albumRepository: AlbumRepository,
    private checksums: AssetChecksumRepository,
    private cryptoRepository: CryptoRepository,
    private databaseRepository: DatabaseRepository,
    private eventRepository: EventRepository,
    private jobRepository: JobRepository,
    private physicalFileRepository: PhysicalFileRepository,
    private fileTrashRepository: PhysicalFileTrashRepository,
    private storageRepository: StorageRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private userRepository: UserRepository,
    private integrityService: MediaIntegrityService,
    private mediaOperations: MediaOperationService,
  ) {
    this.logger.setContext(IdenticalFilesService.name);
  }

  /* ------------------------------------------------------------------------ */
  /* API                                                                       */
  /* ------------------------------------------------------------------------ */

  async getStatus(): Promise<IdenticalFilesStatusDto> {
    const state = await this.getState();
    if (!state) {
      return {
        status: 'never-run',
        stage: null,
        trigger: null,
        startedAt: null,
        finishedAt: null,
        totalOriginals: 0,
        counts: emptyIdenticalFilesCounts(),
        recovered: [],
        problems: [],
      };
    }
    return {
      status: state.status,
      stage: state.stage,
      trigger: state.trigger,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      totalOriginals: state.totalOriginals,
      counts: state.counts,
      recovered: Object.entries(state.recovered ?? {}).map(([ownerId, photos]) => ({
        ownerId,
        photos,
        albumId: state.recoveredAlbums?.[ownerId] ?? null,
      })),
      problems: state.problems,
    };
  }

  /**
   * "Check again": start a full run. A run already in progress carries on instead: its job is queued
   * again only when none is queued or running (one that stopped with the worker).
   */
  async check(auth: AuthDto, trigger: IdenticalFilesTrigger = 'manual'): Promise<IdenticalFilesStatusDto> {
    const state = await this.getState();
    if (state?.status === 'running') {
      if (!(await this.jobRepository.hasDedupJob(QueueName.StorageTemplateMigration, JobName.IdenticalFilesCheck))) {
        await this.jobRepository.queue({ name: JobName.IdenticalFilesCheck, data: { resume: true } });
      }
      return this.getStatus();
    }
    await this.start(trigger, auth.user.id);
    await this.jobRepository.queue({ name: JobName.IdenticalFilesCheck, data: { resume: true } });
    return this.getStatus();
  }

  /** Starts a fresh run's state (keeping the Recovered Media albums), for `check` and the import stage. */
  async start(trigger: IdenticalFilesTrigger, requestedBy: string | null, importRunId: string | null = null) {
    const previous = await this.getState();
    await this.saveState({
      runId: randomUUID(),
      trigger,
      requestedBy,
      importRunId,
      status: 'running',
      stage: 'scan',
      cursor: null,
      walk: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      totalOriginals: await this.repository.countOriginals(),
      counts: emptyIdenticalFilesCounts(),
      recovered: {},
      recoveredAlbums: previous?.recoveredAlbums ?? {},
      problems: [],
    });
  }

  /** The journalled changes of one photo, newest first. */
  async getChanges(assetId: string): Promise<IdenticalFilesChangeDto[]> {
    const rows = await this.repository.listChanges(assetId);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as 'link',
      keptAssetId: row.keptAssetId,
      createdAt: new Date(row.createdAt).toISOString(),
      undoneAt: row.undoneAt ? new Date(row.undoneAt).toISOString() : null,
      restorable: row.restorable && !row.undoneAt,
    }));
  }

  /**
   * "Restore own file": undo one link. The photo's own file comes back out of Unused files to where it
   * was, is checked to still hold the same bytes, and the photo points at it again. The photo is never
   * linked again automatically.
   */
  async undoChange(id: string): Promise<IdenticalFilesChangeDto> {
    const change = await this.repository.getChange(id);
    if (!change) {
      throw new NotFoundException('Change not found');
    }
    if (change.undoneAt) {
      throw new BadRequestException('This change was already undone');
    }
    if (!change.trashEntryId) {
      throw new ConflictException('The photo’s own file is not in Unused files; nothing can be restored');
    }
    const entry = await this.fileTrashRepository.getById(change.trashEntryId);
    if (!entry) {
      throw new ConflictException('The photo’s own file is no longer in Unused files');
    }
    if (await this.storageRepository.checkFileExists(change.ownPath)) {
      throw new ConflictException('Another file now sits where the photo’s own file was');
    }
    await this.databaseRepository.withLock(DatabaseLock.StorageTemplateMigration, async () => {
      const restored = await this.fileTrashRepository.untrash(entry.id, change.ownPath, (from, to) =>
        moveFileWithin(this.storageRepository, from, to),
      );
      if (!restored) {
        throw new ConflictException('The photo’s own file is no longer in Unused files');
      }
      const proven = await verifyStoredCopy(this.storageRepository, this.cryptoRepository, change.ownPath, {
        checksum: change.checksum,
        sizeInBytes: change.sizeInBytes,
      });
      if (!proven) {
        // never point the photo at bytes that are not its own; the file stays where it is, for review
        throw new ConflictException('The restored file does not hold the photo’s bytes; the photo was left as it is');
      }
      await this.physicalFileRepository.restoreOriginalPhysicalFile(change.assetId, {
        path: change.ownPath,
        checksum: change.checksum,
        sizeInBytes: change.sizeInBytes,
      });
      await this.repository.markUndone(change.id);
    });
    return (await this.getChanges(change.assetId)).find((item) => item.id === change.id)!;
  }

  /* ------------------------------------------------------------------------ */
  /* The run                                                                   */
  /* ------------------------------------------------------------------------ */

  /** Retired per-account jobs (FL-413): a job queued before the upgrade changes nothing. */
  @OnJob({ name: JobName.PhysicalDeduplicationMigrationDryRun, queue: QueueName.StorageTemplateMigration })
  handleRetiredDryRun(): Promise<JobStatus> {
    return Promise.resolve(JobStatus.Skipped);
  }

  @OnJob({ name: JobName.PhysicalDeduplicationMigrationApply, queue: QueueName.StorageTemplateMigration })
  handleRetiredApply(): Promise<JobStatus> {
    return Promise.resolve(JobStatus.Skipped);
  }

  @OnJob({ name: JobName.IdenticalFilesCheck, queue: QueueName.StorageTemplateMigration })
  async handleCheck(job?: JobOf<JobName.IdenticalFilesCheck>): Promise<JobStatus> {
    let state = await this.getState();
    if (job?.importRunId && state?.importRunId !== job.importRunId) {
      // FL-414: an Immich import was activated: a full run of its own, whatever ran before
      await this.start('immich-import', null, job.importRunId);
      state = (await this.getState())!;
    } else if (job?.importRunId && state?.status === 'completed') {
      // this import's run finished already: a retried item changes nothing
      return JobStatus.Skipped;
    }
    if (state?.status !== 'running') {
      if (job?.resume) {
        // the run this job was queued to carry on has finished
        return JobStatus.Skipped;
      }
      // the manual job ("identical-files-check") starts a fresh run
      await this.start('manual', null);
      state = (await this.getState())!;
    }

    try {
      while (state.stage !== 'done') {
        if (await this.shouldYield()) {
          // a library move paused the storage queue: stop between batches; the queued job carries on
          await this.saveState(state);
          await this.jobRepository.queue({ name: JobName.IdenticalFilesCheck, data: { resume: true } });
          return JobStatus.Success;
        }
        const finishedStage = await this.runBatch(state);
        if (finishedStage) {
          state.stage = STAGES[STAGES.indexOf(state.stage) + 1];
          state.cursor = null;
          state.walk = null;
        }
        await this.saveState(state);
      }
      state.status = 'completed';
      state.finishedAt = new Date().toISOString();
      await this.saveState(state);
      this.logger.log(
        `Identical files: ${state.counts.scanned} read, ${state.counts.linked} stored once, ${state.counts.photosMerged} merged, ${state.counts.photosRecovered} recovered`,
      );
      return JobStatus.Success;
    } catch (error) {
      if (!jobSignal()?.aborted) {
        this.addProblem(state, 'failed', { detail: errorMessage(error) });
        await this.saveState(state);
      }
      // every finished batch is in the cursor; a retry or "Check again" carries on from it
      throw error;
    }
  }

  /** One batch of the current stage. True when the stage has nothing left. */
  private runBatch(state: IdenticalFilesState): Promise<boolean> {
    jobSignal()?.throwIfAborted();
    switch (state.stage) {
      case 'scan': {
        return this.scanBatch(state);
      }
      case 'link': {
        return this.linkBatch(state);
      }
      case 'merge': {
        return this.mergeBatch(state);
      }
      case 'orphans': {
        return this.orphanBatch(state);
      }
      default: {
        return Promise.resolve(true);
      }
    }
  }

  private async shouldYield() {
    return (await this.jobRepository.isPaused(QueueName.StorageTemplateMigration)) === true;
  }

  /* ------------------------------------------------------------------------ */
  /* 1. Scan                                                                   */
  /* ------------------------------------------------------------------------ */

  private async scanBatch(state: IdenticalFilesState): Promise<boolean> {
    const originals = await this.repository.getOriginals(state.cursor, IDENTICAL_FILES_BATCH);
    if (originals.length === 0) {
      return true;
    }
    // a shared file is read once per batch, however many photos use it
    const read = new Map<string, Awaited<ReturnType<IdenticalFilesService['readFile']>>>();
    for (const original of originals) {
      let digests = read.get(original.originalPath);
      if (!digests) {
        digests = await this.readFile(original.originalPath);
        read.set(original.originalPath, digests);
      }
      await this.scanOne(state, original, digests);
      state.counts.scanned++;
      state.cursor = original.id;
    }
    advanceJobProgress(originals.length);
    return originals.length < IDENTICAL_FILES_BATCH;
  }

  /** SHA-1, SHA-256 and size in one read, while the file did not change; a status when it could not be read. */
  private async readFile(path: string) {
    const before = await fileIdentity(this.storageRepository, path);
    if (!before) {
      return { status: 'missing' as const };
    }
    try {
      const digests = await this.cryptoRepository.hashFileDigests(path);
      const after = await fileIdentity(this.storageRepository, path);
      if (after?.key !== before.key) {
        return { status: 'changing' as const };
      }
      return { status: 'read' as const, ...digests, identity: before.key };
    } catch {
      return { status: 'unreadable' as const };
    }
  }

  private async scanOne(
    state: IdenticalFilesState,
    original: IdenticalFilesOriginal,
    digests: Awaited<ReturnType<IdenticalFilesService['readFile']>>,
  ) {
    if (digests.status !== 'read') {
      this.addProblem(
        state,
        digests.status === 'missing' ? 'missing' : digests.status === 'changing' ? 'changed' : 'unreadable',
        {
          assetId: original.id,
        },
      );
      return;
    }
    const expected =
      original.checksumAlgorithm === ChecksumAlgorithm.sha256File
        ? digests.sha256
        : original.checksumAlgorithm === ChecksumAlgorithm.sha1File
          ? digests.sha1
          : null;
    if (!expected || !expected.equals(original.checksum)) {
      // the file on disk is not what the photo recorded: a media-health matter, never merged
      this.addProblem(state, 'changed', { assetId: original.id });
      return;
    }
    await this.repository.recordDigests({
      assetId: original.id,
      sha1: digests.sha1,
      sha256: digests.sha256,
      sizeInBytes: digests.sizeInBytes,
      path: original.originalPath,
    });
    if (
      original.checksumAlgorithm === ChecksumAlgorithm.sha1File &&
      (await this.repository.upgradeChecksum(original.id, original.checksum, digests.sha256))
    ) {
      state.counts.upgraded++;
    }
    if (
      !original.physicalOriginalFileId &&
      (await this.physicalFileRepository.ensureOriginalPhysicalFile(original.id))
    ) {
      state.counts.registered++;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 2. Merge files across people                                              */
  /* ------------------------------------------------------------------------ */

  private async linkBatch(state: IdenticalFilesState): Promise<boolean> {
    const contents = await this.repository.getSharedContents(state.cursor, IDENTICAL_FILES_BATCH);
    for (const content of contents) {
      await this.databaseRepository.withLock(DatabaseLock.StorageTemplateMigration, () =>
        this.linkContent(state, content),
      );
      state.cursor = contentKey(content);
    }
    advanceJobProgress(Math.max(contents.length, 1));
    return contents.length < IDENTICAL_FILES_BATCH;
  }

  /**
   * One content held in several files: the oldest photo whose file proves to hold the bytes keeps its
   * file; every other person's oldest photo of it is pointed there, and their own copy moves to Unused
   * files. A person's other photos of it are the merge stage's.
   */
  private async linkContent(state: IdenticalFilesState, content: IdenticalFilesContent) {
    const members = await this.repository.getMembers(content);
    const owners = new Set(members.map(({ ownerId }) => ownerId));
    if (owners.size < 2) {
      return;
    }

    let kept: { member: IdenticalFilesMember; file: { id: string; path: string }; identity: string } | undefined;
    for (const member of members) {
      const file = await this.physicalFileRepository.ensureOriginalPhysicalFile(member.id);
      if (!file) {
        continue;
      }
      const identity = await verifyStoredCopy(this.storageRepository, this.cryptoRepository, file.path, {
        checksum: content.sha256,
        sizeInBytes: content.sizeInBytes,
      });
      if (identity) {
        kept = { member, file, identity };
        break;
      }
      this.addProblem(state, 'changed', { assetId: member.id });
    }
    if (!kept) {
      return;
    }

    const seen = new Set([kept.member.ownerId]);
    for (const member of members) {
      if (seen.has(member.ownerId)) {
        continue;
      }
      seen.add(member.ownerId);
      if (member.originalPath === kept.file.path) {
        continue;
      }
      if (await this.repository.wasUndone(member.id)) {
        this.addProblem(state, 'undone', { assetId: member.id });
        continue;
      }
      await this.linkMember(state, content, kept, member);
    }
  }

  private async linkMember(
    state: IdenticalFilesState,
    content: IdenticalFilesContent,
    kept: { member: IdenticalFilesMember; file: { id: string; path: string }; identity: string },
    member: IdenticalFilesMember,
  ) {
    const ownPath = member.originalPath;
    // the photo's own file must hold the same bytes too; a missing one is simply relinked
    const own = await verifyStoredCopy(this.storageRepository, this.cryptoRepository, ownPath, {
      checksum: content.sha256,
      sizeInBytes: content.sizeInBytes,
    });
    const ownExists = !!(await fileIdentity(this.storageRepository, ownPath));
    if (!own && ownExists) {
      this.addProblem(state, 'changed', { assetId: member.id });
      return;
    }
    if (ownExists) {
      // its own file is registered first, so it can move to Unused files once nothing uses it
      await this.physicalFileRepository.ensureOriginalPhysicalFile(member.id);
      // FL-412: a sidecar beside its own file is its own and never ends up beside another person's file
      await this.keepSidecar(member.id, member.ownerId, ownPath);
    }

    const changeId = await this.repository.linkToKept({
      runId: state.runId,
      assetId: member.id,
      ownPath,
      keptAssetId: kept.member.id,
      kept: kept.file,
      content,
      unchanged: async () => (await fileIdentity(this.storageRepository, kept.file.path))?.key === kept.identity,
    });
    if (!changeId) {
      this.addProblem(state, 'changed', { assetId: member.id });
      return;
    }
    state.counts.linked++;
    if (ownExists) {
      await this.moveToUnused(state, { changeId, assetId: member.id, ownerId: member.ownerId, path: ownPath, content });
    }
  }

  /** The photo's own former file goes to Unused files, only once nothing references it. */
  private async moveToUnused(
    state: IdenticalFilesState,
    input: { changeId?: string; assetId: string | null; ownerId: string; path: string; content: IdenticalFilesContent },
  ): Promise<boolean> {
    let outcome: { deleted: boolean; references: number };
    try {
      outcome = await this.physicalFileRepository.deleteUnreferencedPath(
        input.path,
        () => Promise.reject(new Error('An original is never unlinked')),
        {
          trash: {
            move: (from, to) => moveFileWithin(this.storageRepository, from, to),
            original: {
              checksum: input.content.sha256,
              sizeInBytes: input.content.sizeInBytes,
              ownerId: input.ownerId,
              assetId: input.assetId,
              originalFileName: parse(input.path).base,
            },
          },
        },
      );
    } catch (error) {
      // a read-only folder, a vanished file or a busy path: the file stays where it is
      this.addProblem(state, 'kept-for-now', { assetId: input.assetId ?? undefined, detail: errorMessage(error) });
      return false;
    }
    const { deleted, references } = outcome;
    if (!deleted) {
      // a backup still holds it, or something else uses it: kept for now, the next run tries again
      this.addProblem(state, 'kept-for-now', {
        assetId: input.assetId ?? undefined,
        detail: `${references} reference(s)`,
      });
      return false;
    }
    state.counts.filesMovedToUnused++;
    state.counts.bytesMovedToUnused += input.content.sizeInBytes;
    if (input.changeId && input.assetId) {
      const entry = await this.repository.findUnusedEntry(input.assetId, input.path);
      if (entry) {
        await this.repository.setUnusedEntry(input.changeId, entry);
      }
    }
    return true;
  }

  /** Moves a photo's sidecar from beside its own file into its own upload folder (as FL-412 does). */
  private async keepSidecar(assetId: string, ownerId: string, originalPath: string) {
    const { dir, name } = parse(originalPath);
    for (const candidate of [`${originalPath}.xmp`, `${join(dir, name)}.xmp`]) {
      if (!(await this.storageRepository.checkFileExists(candidate))) {
        continue;
      }
      const target = StorageCore.getNestedPath(StorageFolder.Upload, ownerId, `${assetId}.xmp`);
      if (target !== candidate && !(await this.storageRepository.checkFileExists(target))) {
        this.storageRepository.mkdirSync(parse(target).dir);
        await this.storageRepository.copyFile(candidate, target);
      }
      await this.assetRepository.upsertFile({ assetId, type: AssetFileType.Sidecar, path: target });
      return;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 3. Merge photos inside one library                                        */
  /* ------------------------------------------------------------------------ */

  private async mergeBatch(state: IdenticalFilesState): Promise<boolean> {
    const contents = await this.repository.getLibraryContents(state.cursor, IDENTICAL_FILES_BATCH);
    const decisions = new Map<string, Array<{ duplicateId: string; memberIds: string[]; keepAssetIds: string[] }>>();
    for (const content of contents) {
      const members = await this.repository.getMembers(content, content.ownerId);
      state.cursor = `${content.ownerId}:${contentKey(content)}`;
      if (members.length < 2) {
        continue;
      }
      const [kept, ...newer] = members;
      const guards = await this.repository.getMergeGuards(
        kept.id,
        newer.map(({ id }) => id),
      );
      const mergeable = newer.filter(({ id }) => !guards.has(id));
      for (const [assetId, guard] of guards) {
        this.addProblem(state, 'check-before-merging', { assetId, detail: guard });
      }
      if (mergeable.length === 0) {
        if (guards.size > 0 && !kept.checksum.equals(content.sha256)) {
          await this.repository.swapChecksums(content.ownerId, kept.id, newer, content.sha256);
        }
        if (guards.size > 0) {
          // Duplicate review lists them, as identical files to check before merging
          await this.repository.groupPhotos(content.ownerId, [kept.id, ...guards.keys()], this.groupId(state, kept.id));
        }
        continue;
      }
      await this.repository.swapChecksums(content.ownerId, kept.id, newer, content.sha256);
      const duplicateId = this.groupId(state, kept.id);
      const memberIds = [kept.id, ...mergeable.map(({ id }) => id)];
      await this.repository.groupPhotos(content.ownerId, memberIds, duplicateId);
      const owned = decisions.get(content.ownerId) ?? [];
      owned.push({ duplicateId, memberIds, keepAssetIds: [kept.id] });
      decisions.set(content.ownerId, owned);
      state.counts.photosMerged += mergeable.length;
    }

    for (const [ownerId, groups] of decisions) {
      for (let index = 0; index < groups.length; index += MERGE_GROUPS_PER_JOB) {
        await this.submitMerge(state, ownerId, groups.slice(index, index + MERGE_GROUPS_PER_JOB), index);
      }
    }
    advanceJobProgress(Math.max(contents.length, 1));
    return contents.length < IDENTICAL_FILES_BATCH;
  }

  /** A stable group id per run and kept photo, so a resumed batch makes the same group. */
  private groupId(state: IdenticalFilesState, keptId: string) {
    return v5(`${state.runId}:${keptId}`, RUN_NAMESPACE);
  }

  /**
   * The merge itself is the owner's own duplicate decision job (FL-61): it keeps the oldest photo, carries
   * the others' albums, tags, favourite, rating and description into it and moves them to the Trash. It
   * shows in the owner's Activity and decision history, and Undo there brings them back.
   */
  private async submitMerge(
    state: IdenticalFilesState,
    ownerId: string,
    groups: Array<{ duplicateId: string; memberIds: string[]; keepAssetIds: string[] }>,
    page: number,
  ) {
    const owner = await this.userRepository.get(ownerId, { withDeleted: false });
    if (!owner) {
      return;
    }
    const auth: AuthDto = {
      user: {
        id: owner.id,
        isAdmin: owner.isAdmin,
        name: owner.name,
        email: owner.email,
        quotaUsageInBytes: owner.quotaUsageInBytes,
        quotaSizeInBytes: owner.quotaSizeInBytes,
      },
      session: { id: randomUUID(), hasElevatedPermission: true },
    };
    try {
      await this.mediaOperations.createBulk(auth, {
        action: MediaOperationBulkAction.ResolveDuplicates,
        assetIds: groups.flatMap(({ memberIds }) => memberIds),
        payload: {
          duplicateGroups: groups.map((group) => ({ ...group, decision: DuplicateDecisionKind.Keepers })),
        },
        // the same batch resumed after a restart answers with the job it already queued
        requestId: v5(`${state.runId}:${ownerId}:${state.cursor}:${page}`, RUN_NAMESPACE),
        scope: { source: 'identical-files', runId: state.runId },
      });
    } catch (error) {
      this.addProblem(state, 'failed', { detail: `Merge for one library was not queued: ${errorMessage(error)}` });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 4. Orphans                                                                */
  /* ------------------------------------------------------------------------ */

  private async orphanBatch(state: IdenticalFilesState): Promise<boolean> {
    state.walk ??= [
      { path: StorageCore.getBaseFolder(StorageFolder.Library) },
      { path: StorageCore.getBaseFolder(StorageFolder.Upload) },
    ];
    const paths: string[] = [];
    for await (const path of this.storageRepository.walkWithCursor(state.walk, IDENTICAL_FILES_WALK_BATCH)) {
      paths.push(path);
    }
    const external = await this.repository.getExternalImportPaths();
    const candidates = paths.filter(
      (path) =>
        mimeTypes.isAsset(path) &&
        external.every((root) => !(path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))),
    );
    const known = await this.repository.getKnownPaths(candidates);
    const owners = await this.repository.getOwners();
    for (const path of candidates) {
      if (known.has(path)) {
        continue;
      }
      await this.recoverOrphan(state, path, owners);
    }
    advanceJobProgress(Math.max(paths.length, 1));
    return state.walk.length === 0;
  }

  private ownerOf(
    state: IdenticalFilesState,
    path: string,
    owners: Awaited<ReturnType<IdenticalFilesRepository['getOwners']>>,
  ) {
    const segments = relative(StorageCore.getMediaLocation(), path).split(sep);
    const [folder, owner] = segments;
    const live = owners.filter((user) => !user.deletedAt);
    const found =
      folder === StorageFolder.Upload
        ? live.find((user) => user.id === owner)
        : live.find((user) => (user.storageLabel || user.id) === owner || user.id === owner);
    // a folder whose user no longer exists belongs to the administrator who ran the import
    return (
      found ?? live.find((user) => user.id === state.requestedBy && user.isAdmin) ?? live.find((user) => user.isAdmin)
    );
  }

  private async recoverOrphan(
    state: IdenticalFilesState,
    path: string,
    owners: Awaited<ReturnType<IdenticalFilesRepository['getOwners']>>,
  ) {
    const identity = await fileIdentity(this.storageRepository, path);
    if (!identity) {
      return;
    }
    const stat = await this.storageRepository.stat(path);
    if (Date.now() - stat.mtimeMs < ORPHAN_SETTLE_MS) {
      return;
    }
    // the authoritative check, under the path's lock: a file any feature still uses is never an orphan
    if (!(await this.repository.isUnreferenced(path))) {
      return;
    }
    const owner = this.ownerOf(state, path, owners);
    if (!owner) {
      this.addProblem(state, 'needs-a-look', { path: this.shown(path), detail: 'no owner' });
      return;
    }
    state.counts.orphansFound++;

    const originalFileName = parse(path).base;
    const type = mimeTypes.assetType(path);
    const checked = await this.integrityService.validate({ path, originalFileName, type, deep: true });
    if (checked.status !== 'healthy') {
      if (checked.status === 'corrupt' || checked.status === 'unsupported') {
        // damaged files (often a failed upload) are never imported: they wait in Unused files
        const digests = await this.readFile(path);
        if (digests.status === 'read') {
          await this.moveToUnused(state, {
            assetId: null,
            ownerId: owner.id,
            path,
            content: { sha256: digests.sha256, sizeInBytes: digests.sizeInBytes },
          });
        }
        state.counts.damaged++;
        this.addProblem(state, 'damaged', { path: this.shown(path) });
      } else {
        this.addProblem(state, 'unreadable', { path: this.shown(path) });
      }
      return;
    }
    const content = { sha256: checked.sha256, sizeInBytes: checked.sizeInBytes };

    if (await this.repository.ownerHolds(owner.id, { ...content, sha1: checked.sha1 })) {
      // already in the owner's library: a duplicate
      state.counts.orphanDuplicates++;
      await this.moveToUnused(state, { assetId: null, ownerId: owner.id, path, content });
      return;
    }

    if (
      owner.quotaSizeInBytes !== null &&
      Number(owner.quotaUsageInBytes) + content.sizeInBytes > Number(owner.quotaSizeInBytes)
    ) {
      this.addProblem(state, 'over-quota', { path: this.shown(path) });
      return;
    }

    const asset = await this.assetRepository.create({
      ownerId: owner.id,
      libraryId: null,
      checksum: checked.sha256,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      originalPath: path,
      fileCreatedAt: stat.mtime,
      fileModifiedAt: stat.mtime,
      localDateTime: stat.mtime,
      type,
      isFavorite: false,
      duration: null,
      visibility: AssetVisibility.Timeline,
      livePhotoVideoId: null,
      originalFileName,
    });
    await this.assetRepository.upsertExif({
      exif: { assetId: asset.id, fileSizeInByte: content.sizeInBytes },
      lockedPropertiesBehavior: 'override',
    });
    await this.checksums.recordAssetChecksums({
      assetId: asset.id,
      sha1: checked.sha1,
      sha256: checked.sha256,
      sizeInBytes: content.sizeInBytes,
      path,
      source: 'recovery',
    });

    // in someone else's library already: the recovered photo shares that file, using no space
    const elsewhere = (await this.repository.findContent(content)).find(
      (row) => row.id !== asset.id && row.ownerId !== owner.id && row.physicalOriginalFileId,
    );
    let shared = false;
    if (elsewhere?.physicalOriginalFileId) {
      const file = await this.physicalFileRepository.getPhysicalFile(elsewhere.physicalOriginalFileId);
      const identity =
        file &&
        (await verifyStoredCopy(this.storageRepository, this.cryptoRepository, file.path, {
          checksum: content.sha256,
          sizeInBytes: content.sizeInBytes,
        }));
      if (file && identity) {
        const changeId = await this.repository.linkToKept({
          runId: state.runId,
          assetId: asset.id,
          ownPath: path,
          keptAssetId: elsewhere.id,
          kept: file,
          content,
          unchanged: async () => (await fileIdentity(this.storageRepository, file.path))?.key === identity,
        });
        if (changeId) {
          shared = true;
          state.counts.linked++;
          await this.moveToUnused(state, { changeId, assetId: asset.id, ownerId: owner.id, path, content });
        }
      }
    }
    if (!shared) {
      await this.physicalFileRepository.ensureOriginalPhysicalFile(asset.id);
    }

    await this.addToRecoveredMedia(state, owner.id, asset.id);
    state.counts.photosRecovered++;
    state.recovered[owner.id] = (state.recovered[owner.id] ?? 0) + 1;
    await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });
    await this.eventRepository.emit('AssetCreate', {
      asset,
      file: {
        uuid: asset.id,
        checksum: checked.sha256,
        legacyChecksum: checked.sha1,
        originalPath: path,
        originalName: originalFileName,
        size: content.sizeInBytes,
      },
    });
  }

  /**
   * The owner's "Recovered Media" album: made on first use, owned by them, with no notification; its id is
   * remembered, so a later run adds to the same album even after it was renamed. Never made empty.
   */
  private async addToRecoveredMedia(state: IdenticalFilesState, ownerId: string, assetId: string) {
    let albumId: string | undefined = state.recoveredAlbums[ownerId];
    if (albumId && !(await this.albumRepository.getById(albumId, { withAssets: false }))) {
      albumId = undefined;
    }
    if (!albumId) {
      const album = await this.albumRepository.create(
        { albumName: RECOVERED_MEDIA_ALBUM, description: '' },
        [assetId],
        [{ userId: ownerId, role: AlbumUserRole.Owner }],
        ownerId,
      );
      state.recoveredAlbums[ownerId] = album.id;
      await this.saveState(state);
      return;
    }
    await this.albumRepository.addAssetIds(albumId, [assetId]);
  }

  /* ------------------------------------------------------------------------ */
  /* State                                                                     */
  /* ------------------------------------------------------------------------ */

  private async getState(): Promise<IdenticalFilesState | null> {
    return (await this.systemMetadataRepository.get(SystemMetadataKey.IdenticalFiles)) ?? null;
  }

  private saveState(state: IdenticalFilesState) {
    return this.systemMetadataRepository.set(SystemMetadataKey.IdenticalFiles, state);
  }

  /** A path as the report shows it: relative to the media location, never another account's absolute path. */
  private shown(path: string) {
    return relative(StorageCore.getMediaLocation(), path);
  }

  private addProblem(
    state: IdenticalFilesState,
    kind: IdenticalFilesProblemKind,
    details: { assetId?: string; path?: string; detail?: string },
  ) {
    state.counts.problems++;
    if (state.problems.length < IDENTICAL_FILES_PROBLEMS_KEPT) {
      state.problems.push({
        kind,
        assetId: details.assetId ?? null,
        path: details.path ?? null,
        detail: details.detail ?? null,
      });
    }
  }
}
