import { Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import { basename } from 'node:path';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  BootstrapEventPriority,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageMigrationRepository } from 'src/repositories/storage-migration.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import {
  PhysicalDeduplicationService,
  PhysicalDeduplicationVerified,
} from 'src/services/physical-deduplication.service.js';
import { PhysicalFileTrashService } from 'src/services/physical-file-trash.service.js';
import {
  STORAGE_MIGRATION_BATCH_SIZE,
  StorageMigrationBatch,
  StorageMigrationState,
  StorageMigrationStatus,
  createStorageMigrationState,
  parseStorageMigrationState,
  recordStorageMigrationBatch,
  storageMigrationStatus,
} from 'src/utils/storage-migration.js';

/** How long to wait before looking again while the fork-schema backfill still runs. */
export const STORAGE_MIGRATION_BACKFILL_WAIT_MS = 60_000;
/** How long to wait before retrying a batch that failed. */
export const STORAGE_MIGRATION_RETRY_MS = 5 * 60_000;

/** The resolution an in-group relink records on its finding, so the apply phase does not count it twice. */
const IN_GROUP_RELINK = 'universal-storage-group-copy';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

type BatchOutcome = Omit<StorageMigrationBatch, 'startedAt' | 'now'>;

/**
 * The one-time universal storage upgrade migration (FL-326, spec §3.6).
 *
 * After the fork schema has started, every library-storage file is combined so the server holds one
 * file per checksum and size: the oldest asset of each group becomes its primary, every other copy
 * points at the primary's file, and the extra copies go to the file trash (never deleted). Missing
 * originals are relinked first, but only to an exact, verified match. Anything ambiguous stays a
 * media-health Missing finding for review in Library Care.
 *
 * The work runs as one `UniversalStorageMigration` job per batch on the storage-template queue. Each
 * batch reads the checkpoint, does at most `STORAGE_MIGRATION_BATCH_SIZE` items, writes the
 * checkpoint and queues the next batch, all under one advisory lock, so a restart or a second worker
 * carries on from the last finished batch and nothing is done twice.
 */
@Injectable()
export class StorageMigrationService {
  constructor(
    private logger: LoggingRepository,
    private databaseRepository: DatabaseRepository,
    private forkSchemaRepository: ForkSchemaRepository,
    private jobRepository: JobRepository,
    private mediaHealthRepository: MediaHealthRepository,
    private physicalFileRepository: PhysicalFileRepository,
    private storageMigrationRepository: StorageMigrationRepository,
    private storageRepository: StorageRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private mediaHealthService: MediaHealthService,
    private deduplication: PhysicalDeduplicationService,
    private fileTrash: PhysicalFileTrashService,
    private eventRepository: EventRepository,
  ) {
    this.logger.setContext(StorageMigrationService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Status                                                              */
  /* ------------------------------------------------------------------ */

  async getStatus(): Promise<StorageMigrationStatus> {
    return storageMigrationStatus(await this.readState());
  }

  /**
   * An administrator chose "Run in background instead": Getting Ready stops waiting, the migration
   * carries on, and its progress shows in Library Care.
   */
  async runInBackground(): Promise<StorageMigrationStatus> {
    const state = await this.databaseRepository.withLock(DatabaseLock.UniversalStorageMigration, async () => {
      const current = await this.readState();
      if (!current || current.background) {
        return current;
      }
      const next = { ...current, background: true };
      await this.writeState(next);
      return next;
    });
    return storageMigrationStatus(state);
  }

  /* ------------------------------------------------------------------ */
  /* Start and batches                                                   */
  /* ------------------------------------------------------------------ */

  /** Starts (or resumes) the migration at every start of the API worker until it is done. Never fails startup. */
  @OnEvent({
    name: 'AppBootstrap',
    priority: BootstrapEventPriority.UniversalStorageMigration,
    workers: [ImmichWorker.Api],
  })
  async onBootstrap(): Promise<void> {
    try {
      const state = await this.databaseRepository.withLock(DatabaseLock.UniversalStorageMigration, () =>
        this.ensureState(),
      );
      if (state.stage !== 'done') {
        await this.jobRepository.queue({ name: JobName.UniversalStorageMigration, data: {} });
      }
    } catch (error) {
      this.logger.warn(
        `Could not start the universal storage migration (${errorMessage(error)}); it will be tried at the next start`,
      );
    }
  }

  @OnJob({ name: JobName.UniversalStorageMigration, queue: QueueName.StorageTemplateMigration })
  async handleBatch(): Promise<JobStatus> {
    if (!(await this.forkSchemaRepository.isStorageSteady())) {
      // The fork-schema backfill normalizes storage too, and an official handoff or return splits shared
      // originals back out: wait for either before touching files.
      await this.queueNext(STORAGE_MIGRATION_BACKFILL_WAIT_MS);
      return JobStatus.Skipped;
    }

    let state: StorageMigrationState;
    try {
      state = await this.databaseRepository.withLock(DatabaseLock.UniversalStorageMigration, () => this.runBatch());
    } catch (error) {
      this.logger.error(`Universal storage migration batch failed: ${errorMessage(error)}`);
      await this.databaseRepository
        .withLock(DatabaseLock.UniversalStorageMigration, async () => {
          const current = await this.readState();
          if (current) {
            await this.writeState({ ...current, error: errorMessage(error), updatedAt: new Date().toISOString() });
          }
        })
        .catch(() => {});
      await this.queueNext(STORAGE_MIGRATION_RETRY_MS);
      return JobStatus.Failed;
    }

    if (state.stage === 'done') {
      this.logger.log(
        `Universal storage migration finished: ${state.groupsLinked} groups combined, ${state.trashed} extra copies in the file trash, ${state.toReview} to review`,
      );
      await this.eventRepository.emit('StorageMigrationDone');
    } else {
      await this.queueNext();
    }
    return JobStatus.Success;
  }

  /** Runs one batch of the current stage and checkpoints it. Called under the migration lock. */
  async runBatch(now: () => Date = () => new Date()): Promise<StorageMigrationState> {
    const state = await this.ensureState();
    if (state.stage === 'done') {
      return state;
    }
    const startedAt = now();
    const outcome = await this.runStage(state);
    const next = recordStorageMigrationBatch(state, { ...outcome, startedAt, now: now() });
    next.error = null;
    await this.writeState(next);
    return next;
  }

  private runStage(state: StorageMigrationState): Promise<BatchOutcome> {
    switch (state.stage) {
      case 'checking': {
        return this.checkBatch(state);
      }
      case 'relinking': {
        return this.relinkBatch(state);
      }
      case 'linking': {
        return this.linkBatch(state);
      }
      case 'trashing': {
        return this.trashBatch(state);
      }
      default: {
        return Promise.resolve({ patch: {}, units: 0 });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 1. Checking files                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Looks for each original on disk. A missing one is recorded as a Missing finding of the migration's
   * own media-health run; one whose size on disk is not the recorded size cannot be verified and is
   * listed as skipped (it is never linked: the linking stage hashes every file again anyway).
   */
  private async checkBatch(state: StorageMigrationState): Promise<BatchOutcome> {
    // The migration's media-health run is made with its first Missing finding: a run with no findings
    // would be an orphan the return to an official server refuses (`ORPHAN_FAMILIES`).
    let runId = state.runId;

    const assets = await this.storageMigrationRepository.getAssetPage(state.cursor, STORAGE_MIGRATION_BATCH_SIZE);
    if (assets.length === 0) {
      return {
        patch: { runId, stage: 'relinking', cursor: null, relinkPhase: 'in-group' },
        units: 0,
      };
    }

    let missing = 0;
    const skipped: string[] = [];
    for (const asset of assets) {
      if (!(await this.storageRepository.checkFileExists(asset.originalPath, constants.R_OK))) {
        runId ??= (await this.mediaHealthRepository.createRun(MediaHealthCategory.Missing)).id;
        await this.mediaHealthRepository.upsertFinding({
          runId,
          assetId: asset.id,
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Missing,
          severity: MediaHealthSeverity.Critical,
          originalPath: asset.originalPath,
          originalFileName: asset.originalFileName,
          evidence: { reason: 'source_file_missing_or_unreadable', source: 'universal_storage_migration' },
          resolution: { autoRelinkable: false },
          checkedAt: new Date(),
        });
        missing++;
        continue;
      }
      if (asset.isExternal || asset.libraryId || !asset.sizeInBytes) {
        continue;
      }
      try {
        const { size } = await this.storageRepository.stat(asset.originalPath);
        if (size !== Number(asset.sizeInBytes)) {
          skipped.push(asset.id);
        }
      } catch {
        skipped.push(asset.id);
      }
    }

    return {
      patch: {
        runId,
        cursor: assets.at(-1)!.id,
        checked: state.checked + assets.length,
        relinkTotal: state.relinkTotal + missing,
      },
      skipped,
      units: assets.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 2. Relinking missing files                                          */
  /* ------------------------------------------------------------------ */

  private relinkBatch(state: StorageMigrationState): Promise<BatchOutcome> {
    if (!state.runId) {
      // Nothing was checked by this migration's run (an older state): nothing to relink.
      return Promise.resolve({ patch: { stage: 'linking', cursor: null }, units: 0 });
    }
    switch (state.relinkPhase) {
      case 'in-group': {
        return this.relinkInGroup(state, state.runId);
      }
      case 'search': {
        return this.searchManagedStorage(state, state.runId);
      }
      default: {
        return this.applySearch(state, state.runId);
      }
    }
  }

  /**
   * Relink step 1: another library-storage asset with the same checksum and size has a verified file
   * on disk. The missing asset simply shares it, as every copy will under universal storage. The
   * relink is recorded on the asset's finding, so Library Care's history shows it.
   */
  private async relinkInGroup(state: StorageMigrationState, runId: string): Promise<BatchOutcome> {
    const findings = await this.mediaHealthRepository.getRunFindingPage({
      runId,
      statuses: [MediaHealthStatus.Missing],
      afterId: state.cursor,
      limit: STORAGE_MIGRATION_BATCH_SIZE,
      managedOnly: true,
    });
    if (findings.length === 0) {
      return { patch: { relinkPhase: 'search', cursor: null, managedSearch: null }, units: 0 };
    }

    const verified: PhysicalDeduplicationVerified = new Map();
    let relinked = 0;
    for (const finding of findings) {
      if (await this.relinkFromGroup(runId, finding.assetId, verified)) {
        relinked++;
      }
    }

    return {
      patch: {
        cursor: findings.at(-1)!.id,
        relinked: state.relinked + relinked,
        relinkDone: state.relinkDone + relinked,
      },
      units: findings.length,
    };
  }

  private async relinkFromGroup(
    runId: string,
    assetId: string,
    verified: PhysicalDeduplicationVerified,
  ): Promise<boolean> {
    const [asset] = await this.physicalFileRepository.getPlanEvidence([assetId]);
    if (!asset || asset.isExternal || asset.libraryId || !asset.sizeInBytes) {
      return false;
    }
    const sources = await this.storageMigrationRepository.getGroupSources(
      asset.id,
      asset.checksum,
      Number(asset.sizeInBytes),
    );
    for (const source of sources) {
      const result = await this.deduplication.linkToPrimary(asset.id, source.id, verified);
      if (result.state === 'skipped' && (result.reason === 'primary-missing' || result.reason === 'primary-mismatch')) {
        // That copy is not there or not the bytes either: try the next one.
        continue;
      }
      if (result.state !== 'linked') {
        return false;
      }

      const [linked] = await this.physicalFileRepository.getPlanEvidence([asset.id]);
      if (linked) {
        await this.mediaHealthRepository.upsertFinding({
          runId,
          assetId: asset.id,
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Relinked,
          severity: MediaHealthSeverity.Info,
          originalPath: linked.originalPath,
          originalFileName: asset.originalFileName ?? basename(asset.originalPath),
          evidence: {
            reason: 'source_file_missing_or_unreadable',
            source: 'universal_storage_migration',
            previousPath: asset.originalPath,
          },
          resolution: {
            automatic: true,
            method: IN_GROUP_RELINK,
            sourceAssetId: source.id,
            relinkedAt: new Date().toISOString(),
          },
          checkedAt: new Date(),
          resolvedAt: new Date(),
        });
      }
      return true;
    }
    return false;
  }

  /**
   * Relink step 2: one bounded step of the exact-checksum search of library storage, over every
   * finding still missing. A step that does not finish the walk is checkpointed as a continuation.
   */
  private async searchManagedStorage(state: StorageMigrationState, runId: string): Promise<BatchOutcome> {
    const findingIds: string[] = [];
    let afterId: string | null = null;
    while (true) {
      const page = await this.mediaHealthRepository.getRunFindingPage({
        runId,
        statuses: [MediaHealthStatus.Missing],
        afterId,
        limit: 5000,
        managedOnly: true,
      });
      findingIds.push(...page.map(({ id }) => id));
      if (page.length < 5000) {
        break;
      }
      afterId = page.at(-1)!.id;
    }
    if (findingIds.length === 0) {
      return { patch: { relinkPhase: 'apply', cursor: null, managedSearch: null }, units: 0 };
    }

    const step = await this.mediaHealthService.locateForStorageMigration({
      runId,
      findingIds,
      managedSearch: state.managedSearch,
    });
    return step.continuation
      ? { patch: { managedSearch: step.continuation }, units: 0 }
      : { patch: { relinkPhase: 'apply', cursor: null, managedSearch: null }, units: 0 };
  }

  /**
   * Relink step 3: every finding the migration recorded and has not settled is settled now. Exactly
   * one verified exact match is relinked; anything else (none, several, a conflict, an external
   * original) stays a Missing finding for review in Library Care.
   */
  private async applySearch(state: StorageMigrationState, runId: string): Promise<BatchOutcome> {
    const findings = await this.mediaHealthRepository.getRunFindingPage({
      runId,
      statuses: [
        MediaHealthStatus.Missing,
        MediaHealthStatus.Candidate,
        MediaHealthStatus.Found,
        MediaHealthStatus.Relinked,
      ],
      afterId: state.cursor,
      limit: STORAGE_MIGRATION_BATCH_SIZE,
    });
    if (findings.length === 0) {
      await this.mediaHealthRepository.finishRun(runId, {
        status: 'completed',
        totalAssets: state.checked,
        checkedAssets: state.checked,
        foundAssets: state.relinkTotal,
      });
      const groupsTotal = await this.storageMigrationRepository.countDuplicateGroups();
      return {
        patch: { stage: 'linking', cursor: null, groupsTotal },
        units: 0,
      };
    }

    let relinked = 0;
    let toReview = 0;
    let settled = 0;
    for (const finding of findings) {
      const resolution = (finding.resolution ?? {}) as Record<string, unknown>;
      if (finding.status === MediaHealthStatus.Relinked && resolution.method === IN_GROUP_RELINK) {
        // Counted when the in-group relink was made.
        continue;
      }
      settled++;
      if ((await this.mediaHealthService.relinkForStorageMigration(finding.id)) === 'relinked') {
        relinked++;
      } else {
        toReview++;
      }
    }

    return {
      patch: {
        cursor: findings.at(-1)!.id,
        relinked: state.relinked + relinked,
        toReview: state.toReview + toReview,
        relinkDone: state.relinkDone + settled,
      },
      units: settled,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Linking duplicate groups                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Every group of library-storage assets with the same checksum and size shares one file: its oldest
   * asset whose file verifies is the primary. A copy whose bytes do not match is skipped and listed.
   * Linking an already linked copy changes nothing, so a repeated batch links nothing twice.
   */
  private async linkBatch(state: StorageMigrationState): Promise<BatchOutcome> {
    const groups = await this.storageMigrationRepository.getDuplicateGroupPage(
      state.cursor,
      STORAGE_MIGRATION_BATCH_SIZE,
    );
    if (groups.length === 0) {
      const trashTotal = await this.storageMigrationRepository.countUnreferencedOriginals();
      return { patch: { stage: 'trashing', cursor: null, trashTotal }, units: 0 };
    }

    const verified: PhysicalDeduplicationVerified = new Map();
    const skipped: string[] = [];
    for (const group of groups) {
      skipped.push(...(await this.linkGroup(group.assetIds, verified)));
    }

    return {
      patch: { cursor: groups.at(-1)!.key, groupsLinked: state.groupsLinked + groups.length },
      skipped,
      units: groups.length,
    };
  }

  /** Links one group to its first verifiable member; returns the members that were skipped. */
  private async linkGroup(assetIds: string[], verified: PhysicalDeduplicationVerified): Promise<string[]> {
    const skipped = new Set<string>();
    const unusable = new Set<string>();
    for (const primary of assetIds) {
      if (unusable.has(primary)) {
        continue;
      }
      let primaryUsable = true;
      for (const copy of assetIds) {
        if (copy === primary || unusable.has(copy)) {
          continue;
        }
        const result = await this.deduplication.linkToPrimary(copy, primary, verified);
        if (result.state !== 'skipped') {
          continue;
        }
        if (result.reason === 'primary-missing' || result.reason === 'primary-mismatch') {
          primaryUsable = false;
          unusable.add(primary);
          if (result.reason === 'primary-mismatch') {
            skipped.add(primary);
          }
          break;
        }
        if (result.reason === 'copy-mismatch') {
          unusable.add(copy);
          skipped.add(copy);
        }
      }
      if (primaryUsable) {
        break;
      }
    }
    return [...skipped];
  }

  /* ------------------------------------------------------------------ */
  /* 4. Moving extra copies to the file trash                            */
  /* ------------------------------------------------------------------ */

  /**
   * Originals nothing references any more go to the file trash, never deleted. The file trash counts
   * every reference again under the path lock, so a file something still uses is left alone.
   */
  private async trashBatch(state: StorageMigrationState): Promise<BatchOutcome> {
    const files = await this.storageMigrationRepository.getUnreferencedOriginalPage(
      state.cursor,
      STORAGE_MIGRATION_BATCH_SIZE,
    );
    if (files.length === 0) {
      return { patch: { stage: 'done', cursor: null }, units: 0 };
    }

    let bytes = 0;
    for (const file of files) {
      const result = await this.fileTrash.trashOriginal({
        physicalFileId: file.id,
        path: file.path,
        checksum: file.checksum,
        sizeInBytes: file.sizeInBytes,
        lastOwnerId: file.lastOwnerId,
        lastAssetId: file.lastAssetId,
        originalFileName: file.originalFileName ?? basename(file.path),
      });
      if (result.status === 'trashed') {
        bytes += file.sizeInBytes;
      }
    }

    return {
      patch: {
        cursor: files.at(-1)!.id,
        trashed: state.trashed + files.length,
        bytesFreed: state.bytesFreed + bytes,
      },
      units: files.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  private async readState(): Promise<StorageMigrationState | undefined> {
    return parseStorageMigrationState(
      await this.systemMetadataRepository.get(SystemMetadataKey.UniversalStorageMigration),
    );
  }

  private writeState(state: StorageMigrationState): Promise<void> {
    return this.systemMetadataRepository.set(SystemMetadataKey.UniversalStorageMigration, state);
  }

  /** The stored state, or a new one: a library with no assets has nothing to combine and is done at once. */
  private async ensureState(): Promise<StorageMigrationState> {
    const existing = await this.readState();
    if (existing) {
      return existing;
    }
    const state = createStorageMigrationState({
      total: await this.storageMigrationRepository.countAssets(),
      now: new Date(),
    });
    await this.writeState(state);
    return state;
  }

  private queueNext(delay?: number): Promise<void> {
    return this.jobRepository.queue({ name: JobName.UniversalStorageMigration, data: delay ? { delay } : {} });
  }
}
