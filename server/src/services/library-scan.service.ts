import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Stats } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { LibraryResponseDto, LibraryScanResponseDto } from 'src/dtos/library.dto.js';
import {
  AdminAuditAction,
  AssetStatus,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  QueueName,
  UserStatus,
} from 'src/enum.js';
import { advanceJobProgress, jobSignal } from 'src/queue/context.js';
import { QUEUE_BATCH } from 'src/queue/types.js';
import { AdminAuditRepository } from 'src/repositories/admin-audit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { AssetSyncResult, LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationRepository,
  type MediaOperationWriteState,
} from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { bulkErrorMessage } from 'src/utils/bulk-operation.js';
import { withExecutionCleanup } from 'src/utils/execution-signal.js';
import {
  checkImportPathFormat,
  checkImportPathOnDisk,
  isSameOrInside,
  normalizeImportPath,
  resolvesIntoMediaStorage,
} from 'src/utils/library-paths.js';
import {
  LibraryScanResult,
  LibraryScanSnapshot,
  LibraryScanStopReason,
  LibraryScanTrigger,
  emptyLibraryScanResult,
  libraryAssetFromFile,
  libraryPathsFingerprint,
  libraryScanProgress,
  libraryScanUnits,
  parseLibraryScanResult,
  parseLibraryScanSnapshot,
} from 'src/utils/library-scan.js';
import { TERMINAL_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';
import { mimeTypes } from 'src/utils/mime-types.js';

const KIND = MediaOperationKind.LibraryScan;
const SUBJECT_KEY = 'libraryId';

/** How often a worker looks for scans waiting without a queue job (resumed, retried, recovered). */
export const LIBRARY_SCAN_TICK_MS = 15_000;
/** The claim lease, renewed after every batch and by a heartbeat while a batch is in hand. */
export const LIBRARY_SCAN_LEASE_MS = 5 * 60_000;
/** Files crawled, or items checked, between two progress writes. */
export const LIBRARY_SCAN_BATCH = 1000;

/**
 * A scan the server refuses to finish, with a stable code for the library page. Refusals are
 * failures requiring attention. Library scans are not automatically replayable until asset and
 * processing-intent admission is atomic.
 */
export class LibraryScanRefusal extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class LibraryBatchStopped extends Error {
  constructor(readonly written: MediaOperationWriteState | undefined) {
    super('Library scan domain claim changed before acceptance');
  }
}

type LibraryRow = NonNullable<Awaited<ReturnType<LibraryRepository['get']>>>;

/**
 * External library scans (FL-78).
 *
 * A scan is a durable `media_operation` of kind `library_scan`, one per library at a time: it shows
 * in Activity and the notifications panel with its progress, can be paused, resumed and cancelled,
 * records interrupted claims for recovery, and requires attention instead of unsafe automatic replay.
 *
 * It runs inside a `LibraryScanRun` job on the library queue, so pausing that queue holds new scans
 * and "waiting for the library queue" still means "waiting for scans". A tick wakes the queue for
 * scans that come back without a job of their own: resumed, retried or recovered from a lost claim.
 *
 * What a scan will not do is decide that a library's photos are gone because their folder is. Every
 * import folder must be a readable directory before anything is imported or checked, and again
 * before each batch of checks; a folder that comes back empty while items are still indexed from it
 * fails the scan. Either way nothing is marked offline, and the failure says which folder.
 */
@Injectable()
export class LibraryScanService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private readonly workerId = `library-scan-${randomUUID()}`;

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private libraryRepository: LibraryRepository,
    private assetRepository: AssetRepository,
    private assetJobRepository: AssetJobRepository,
    private storageRepository: StorageRepository,
    private jobRepository: JobRepository,
    private userRepository: UserRepository,
    private eventRepository: EventRepository,
    private cryptoRepository: CryptoRepository,
    private adminAuditRepository: AdminAuditRepository,
  ) {
    this.logger.setContext(LibraryScanService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Requests                                                            */
  /* ------------------------------------------------------------------ */

  /** An administrator's scan. Asking again while one is waiting or running answers with that one. */
  async queueManual(auth: AuthDto, libraryId: string): Promise<void> {
    const library = await this.findOrFail(libraryId);
    const { created } = await this.queue(library, { ownerId: auth.user.id, trigger: 'manual' });
    if (created) {
      await this.audit(auth, library, AdminAuditAction.LibraryScanQueued);
    }
  }

  /** Stop the library's scan, whoever started it. */
  async cancel(auth: AuthDto, libraryId: string): Promise<void> {
    const library = await this.findOrFail(libraryId);
    const active = await this.operations.getActiveBySubject(KIND, SUBJECT_KEY, library.id);
    if (!active) {
      throw new BadRequestException('No active scan to cancel');
    }

    await this.operations.requestCancel(active.id, active.ownerId);
    await this.audit(auth, library, AdminAuditAction.LibraryScanCancelled);
    this.logger.log(`Scan ${active.id} of library ${library.id} cancelled by an administrator`);
  }

  /** Whether the library has a scan waiting, running or paused. */
  async isActive(libraryId: string): Promise<boolean> {
    return !!(await this.operations.getActiveBySubject(KIND, SUBJECT_KEY, libraryId));
  }

  /** Each library with its latest scan. */
  async withScans(libraries: LibraryResponseDto[]): Promise<LibraryResponseDto[]> {
    const latest = await this.operations.getLatestBySubject(
      KIND,
      SUBJECT_KEY,
      libraries.map(({ id }) => id),
    );
    const byLibrary = new Map(latest.map((operation) => [String(operation.snapshot?.libraryId), operation]));
    return libraries.map((library) => {
      const operation = byLibrary.get(library.id);
      return { ...library, scan: operation ? mapLibraryScan(operation) : null };
    });
  }

  /**
   * Queue a scan unless one is unfinished. Refused for a library without folders or whose owner
   * account is deleted: a scan would import into an account nobody can use.
   */
  async queue(
    library: LibraryRow,
    options: { ownerId: string; trigger: LibraryScanTrigger },
  ): Promise<{ operation: MediaOperation; created: boolean }> {
    await this.requireActiveOwner(library);
    if (library.importPaths.length === 0) {
      throw new BadRequestException('Add at least one import folder before scanning');
    }

    const outcome = await this.jobRepository.prepareLibraryScanSource(library.id, async (tx) => {
      const value = await this.operations.createUnlessActive(
        {
          ownerId: options.ownerId,
          kind: KIND,
          destination: MediaOperationDestination.Local,
          destinationDetail: null,
          label: library.name,
          snapshot: { libraryId: library.id, trigger: options.trigger } satisfies LibraryScanSnapshot,
          settings: {},
          estimate: null,
          result: emptyLibraryScanResult() as unknown as Record<string, unknown>,
        },
        { key: SUBJECT_KEY, value: library.id, lock: DatabaseLock.Library },
        tx,
      );
      return { operationId: 'active' in value ? value.active.id : value.created.id, value };
    });

    if ('active' in outcome) {
      return { operation: outcome.active, created: false };
    }

    this.logger.log(`Scan ${outcome.created.id} of library ${library.id} queued (${options.trigger})`);
    await this.wake();
    return { operation: outcome.created, created: true };
  }

  /* ------------------------------------------------------------------ */
  /* Scheduled and legacy entry points                                   */
  /* ------------------------------------------------------------------ */

  /** The nightly scan of every library, and the library queue's "start" command. */
  @OnJob({ name: JobName.LibraryScanQueueAll, queue: QueueName.Library })
  async handleQueueScanAll(): Promise<JobStatus> {
    this.logger.log(`Initiating scan of all external libraries...`);
    await this.jobRepository.queue({ name: JobName.LibraryDeleteCheck, data: {} });

    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      this.logger.warn('No administrator account to hold automatic library scans; skipping');
      return JobStatus.Skipped;
    }

    for (const library of await this.libraryRepository.getAll(false)) {
      await this.queueAutomatic(library, admin.id);
    }

    return JobStatus.Success;
  }

  /** A crawl queued before scans were durable jobs becomes one. */
  @OnJob({ name: JobName.LibrarySyncFilesQueueAll, queue: QueueName.Library })
  async handleQueueSyncFiles(job: JobOf<JobName.LibrarySyncFilesQueueAll>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.id);
    const admin = await this.userRepository.getAdmin();
    if (!library || !admin) {
      return JobStatus.Skipped;
    }
    await this.queueAutomatic(library, admin.id);
    return JobStatus.Success;
  }

  /** The durable scan checks existing items itself; a queued legacy check has nothing left to do. */
  @OnJob({ name: JobName.LibrarySyncAssetsQueueAll, queue: QueueName.Library })
  handleQueueSyncAssets(): Promise<JobStatus> {
    return Promise.resolve(JobStatus.Skipped);
  }

  /**
   * A legacy batch check is never run: it would mark items offline without first checking that
   * their folders are reachable. The library's next scan checks them properly.
   */
  @OnJob({ name: JobName.LibrarySyncAssets, queue: QueueName.Library })
  handleSyncAssets(job: JobOf<JobName.LibrarySyncAssets>): Promise<JobStatus> {
    this.logger.log(`Skipping a legacy item check for library ${job.libraryId}; its next scan checks them`);
    return Promise.resolve(JobStatus.Skipped);
  }

  private async queueAutomatic(library: LibraryRow, ownerId: string) {
    try {
      await this.queue(library, { ownerId, trigger: 'automatic' });
    } catch (error) {
      this.logger.log(`Not scanning library ${library.id}: ${bulkErrorMessage(error)}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Stopping scans the server no longer wants                           */
  /* ------------------------------------------------------------------ */

  /** Folders changed or the library is being removed: its scan stops at its next batch. */
  @OnEvent({ name: 'LibraryScanStop' })
  async onLibraryScanStop({ libraryId, reason }: ArgOf<'LibraryScanStop'>) {
    await this.stop(libraryId, reason);
  }

  /** An account going to the trash stops the scans of every library it owns. */
  @OnEvent({ name: 'UserTrash' })
  async onUserTrash({ id }: ArgOf<'UserTrash'>) {
    const libraries = await this.libraryRepository.getAll(false);
    const owned = libraries.filter(({ ownerId }) => ownerId === id);
    for (const library of owned) {
      await this.stop(library.id, 'owner_deleted');
    }
  }

  async stop(libraryId: string, reason: LibraryScanStopReason): Promise<void> {
    const active = await this.operations.getActiveBySubject(KIND, SUBJECT_KEY, libraryId);
    if (!active) {
      return;
    }

    const cancelled = await this.operations.requestCancel(active.id, active.ownerId);
    // A scan nobody held is cancelled at once and can record why; a running one records it itself.
    if (cancelled && TERMINAL_MEDIA_OPERATION_STATUSES.includes(cancelled.status as MediaOperationStatus)) {
      await this.operations.setFinishedResult(active.id, {
        ...parseLibraryScanResult(cancelled.result),
        stopReason: reason,
      });
    }
    this.logger.log(`Scan ${active.id} of library ${libraryId} stopped (${reason})`);
  }

  /* ------------------------------------------------------------------ */
  /* Worker                                                              */
  /* ------------------------------------------------------------------ */

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => void this.tick(), LIBRARY_SCAN_TICK_MS);
    void this.tick();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    await this.active;
  }

  /** Wake the library queue when a scan waits without a job to run it. */
  async tick(): Promise<void> {
    if (this.stopping) {
      return;
    }
    try {
      await this.jobRepository.settleTerminalLibrarySources();
      if (await this.operations.hasClaimable([KIND])) {
        await this.wake();
      }
    } catch (error) {
      this.logger.warn(`Library scan wake-up failed: ${bulkErrorMessage(error)}`);
    }
  }

  private wake() {
    return this.jobRepository.queue({ name: JobName.LibraryScanRun, data: {} });
  }

  @OnJob({ name: JobName.LibraryScanRun, queue: QueueName.Library })
  async handleScanRun(): Promise<JobStatus> {
    const run = this.drain();
    this.active = run;
    try {
      await run;
    } finally {
      if (this.active === run) {
        this.active = undefined;
      }
    }
    return JobStatus.Success;
  }

  /** One domain operation per wake; tick wakes remaining claimable scans without chaining attempts. */
  async drain(): Promise<void> {
    if (this.stopping || jobSignal()?.aborted) return;
    const claim = await this.operations.claimNext({
      kinds: [KIND],
      workerId: this.workerId,
      leaseMs: LIBRARY_SCAN_LEASE_MS,
    });
    if (!claim) return;
    await this.run(claim.operation, claim.claimToken);
  }

  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    let snapshot: LibraryScanSnapshot;
    try {
      snapshot = parseLibraryScanSnapshot(operation.snapshot);
    } catch (error) {
      await this.failSource(operation.id, claimToken, {
        error: bulkErrorMessage(error),
        errorCode: 'library_scan_snapshot_invalid',
      });
      return;
    }

    const controller = new AbortController();
    const parentSignal = jobSignal();
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const keepAlive = setInterval(() => {
      void this.operations
        .heartbeat(operation.id, claimToken, LIBRARY_SCAN_LEASE_MS)
        .then((held) => {
          if (!held) controller.abort();
        })
        .catch(() => controller.abort());
    }, LIBRARY_SCAN_LEASE_MS / 4);

    try {
      signal.throwIfAborted();
      await this.scan(operation, claimToken, snapshot, signal);
    } catch (error) {
      if (signal.aborted) return;
      const refusal = error instanceof LibraryScanRefusal ? error : undefined;
      const message = bulkErrorMessage(error);
      this.logger.warn(`Scan ${operation.id} of library ${snapshot.libraryId} failed: ${message}`);
      await this.failSource(operation.id, claimToken, {
        error: message,
        errorCode: refusal?.code ?? 'library_scan_failed',
      });
    } finally {
      clearInterval(keepAlive);
      if (parentSignal?.aborted) {
        // Scan work and its source iterator have stopped. Give only this claim-fenced terminal
        // write a separate bounded SQL lifetime; ordinary writes retain the cancelled signal.
        await withExecutionCleanup(() =>
          this.failSource(operation.id, claimToken, {
            error: 'The library queue attempt was interrupted',
            errorCode: 'library_scan_interrupted',
          }),
        );
      }
    }
  }

  private failSource(operationId: string, claimToken: string, failure: { error: string; errorCode: string }) {
    return this.jobRepository.settleLibraryScanSource(operationId, (executor) =>
      this.operations.fail(operationId, claimToken, failure, { retry: false, executor }),
    );
  }

  private async scan(
    operation: MediaOperation,
    claimToken: string,
    snapshot: LibraryScanSnapshot,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { id } = operation;
    const library = await this.libraryRepository.get(snapshot.libraryId);
    if (!library) {
      throw new LibraryScanRefusal('library_scan_library_missing', 'The library no longer exists');
    }

    const owner = await this.userRepository.get(library.ownerId, { withDeleted: true });
    if (!owner || owner.deletedAt || owner.status !== UserStatus.Active) {
      throw new LibraryScanRefusal('library_scan_owner_inactive', 'The library owner account is deleted');
    }

    if (library.importPaths.length === 0) {
      throw new LibraryScanRefusal('library_scan_no_folders', 'The library has no import folders');
    }

    let result = parseLibraryScanResult(operation.result);
    const fingerprint = libraryPathsFingerprint(library);
    if (result.fingerprint && result.fingerprint !== fingerprint) {
      // The folders changed while this scan waited; it was asked about the old ones.
      await this.stopSelf(operation, claimToken, result, 'paths_changed');
      return;
    }
    result = { ...result, fingerprint };
    // Recovery/tick wakes may claim another operation; they cannot invent an origin association.
    await this.jobRepository.ensureLibraryScanSource({ operationId: operation.id, libraryId: library.id }, false);

    const roots = [...new Set(library.importPaths.map((importPath) => normalizeImportPath(importPath)))];
    await this.requireSources(roots, signal);
    signal.throwIfAborted();

    if (!(await this.start(id, claimToken, result))) {
      // cancelled between the claim and this write, or the claim is gone
      await this.settleCancel(operation, claimToken, result);
      return;
    }

    if (result.phase === 'crawl') {
      const crawled = await this.crawl(operation, claimToken, library, roots, result, signal);
      if (!crawled) {
        return;
      }
      result = crawled;
    }

    if (result.phase === 'check') {
      const checked = await this.check(operation, claimToken, library, roots, result, signal);
      if (!checked) {
        return;
      }
      result = checked;
    }

    const finished = { ...result, phase: 'done' as const };
    if (
      signal.aborted ||
      !(await this.applyBatch(
        operation,
        claimToken,
        library,
        result,
        signal,
        (_assets, repository) => repository.update(library.id, { refreshedAt: new Date() }),
        { checkpoint: () => finished, close: true },
      ))
    ) {
      return;
    }
    result = finished;

    if (await this.operations.beginValidation(id, claimToken)) {
      await this.operations.complete(id, claimToken, { resultAssetId: null });
      this.logger.log(
        `Scan ${id} of library ${library.id} finished: ${result.added} added, ${result.checked} checked, ${result.offlined} offline, ${result.onlined} back online`,
      );
      return;
    }

    await this.settleCancel(operation, claimToken, result);
  }

  /** Walk the folders and import every file the library does not have yet. */
  private async crawl(
    operation: MediaOperation,
    claimToken: string,
    library: LibraryRow,
    roots: string[],
    initial: LibraryScanResult,
    signal: AbortSignal,
  ): Promise<LibraryScanResult | undefined> {
    // A crawl always starts from the top: a resumed one finds what it imported already and skips it.
    let result: LibraryScanResult = {
      ...initial,
      crawled: 0,
      expected: await this.assetRepository.getLibraryAssetCount(library.id),
    };
    const found = new Map(roots.map((root) => [root, 0]));

    const batches = this.storageRepository.walkLibrary({
      pathsToCrawl: roots,
      includeHidden: false,
      exclusionPatterns: library.exclusionPatterns,
      take: LIBRARY_SCAN_BATCH,
      signal,
    });

    for await (const batch of batches) {
      if (signal.aborted) return;
      if (this.stopping) {
        await this.operations.requeue(operation.id, claimToken, { delayMs: 0, returnAttempt: true });
        return;
      }

      for (const file of batch) {
        const root = roots.find((candidate) => isSameOrInside(file, candidate));
        if (root) {
          found.set(root, (found.get(root) ?? 0) + 1);
        }
      }

      for (let offset = 0; offset < batch.length; offset += QUEUE_BATCH) {
        const slice = batch.slice(offset, offset + QUEUE_BATCH);
        const added = await this.importFiles(operation, claimToken, library, slice, result, signal);
        if (added === undefined) return;
        result = { ...result, crawled: result.crawled + slice.length, added: result.added + added };
      }
    }

    await this.requireNonemptySources(library, roots, signal, found);
    if (signal.aborted) return;

    result = {
      ...result,
      phase: 'check',
      cursor: null,
      checked: 0,
      total: await this.assetRepository.getLibraryAssetCount(library.id),
    };
    return (await this.write(operation, claimToken, result, signal)) ? result : undefined;
  }

  /** Check every indexed item against its file, a page at a time from the recorded cursor. */
  private async check(
    operation: MediaOperation,
    claimToken: string,
    library: LibraryRow,
    roots: string[],
    initial: LibraryScanResult,
    signal: AbortSignal,
  ): Promise<LibraryScanResult | undefined> {
    let result = initial;

    while (true) {
      if (signal.aborted) return;
      if (this.stopping) {
        await this.operations.requeue(operation.id, claimToken, { delayMs: 0, returnAttempt: true });
        return;
      }

      const page = await this.libraryRepository.getAssetIdPage(library.id, result.cursor, LIBRARY_SCAN_BATCH);
      signal.throwIfAborted();
      if (page.length === 0) {
        return result;
      }

      // The folders are checked again before every page: a share can drop mid-scan, and an item is
      // only missing when its folder is demonstrably there.
      await this.requireSources(roots, signal);

      for (let offset = 0; offset < page.length; offset += QUEUE_BATCH) {
        const slice = page.slice(offset, offset + QUEUE_BATCH);
        const counts = await this.checkAssets(
          operation,
          claimToken,
          library,
          slice.map(({ id }) => id),
          roots,
          result,
          signal,
        );
        if (!counts) return;
        result = {
          ...result,
          cursor: slice.at(-1)!.id,
          checked: result.checked + slice.length,
          updated: result.updated + counts.updated,
          offlined: result.offlined + counts.offlined,
          onlined: result.onlined + counts.onlined,
        };
      }
    }
  }

  private async checkAssets(
    operation: MediaOperation,
    claimToken: string,
    library: LibraryRow,
    assetIds: string[],
    roots: string[],
    result: LibraryScanResult,
    signal: AbortSignal,
  ) {
    const assets = await this.assetJobRepository.getForSyncAssets(assetIds);
    signal.throwIfAborted();
    const stats = await Promise.all(
      assets.map((asset) => this.storageRepository.stat(asset.originalPath).catch(() => null)),
    );
    signal.throwIfAborted();

    const toOffline: string[] = [];
    const trashedToOffline: string[] = [];
    const toOnline: string[] = [];
    const trashedToOnline: string[] = [];
    const toUpdate: string[] = [];

    for (const [index, asset] of assets.entries()) {
      switch (checkExistingAsset(asset, stats[index])) {
        case AssetSyncResult.OFFLINE: {
          (asset.status === AssetStatus.Trashed ? trashedToOffline : toOffline).push(asset.id);
          break;
        }
        case AssetSyncResult.UPDATE: {
          toUpdate.push(asset.id);
          break;
        }
        case AssetSyncResult.CHECK_OFFLINE: {
          const inFolder = library.importPaths.some((importPath) => asset.originalPath.startsWith(importPath));
          const excluded = library.exclusionPatterns.some((pattern) => picomatch.isMatch(asset.originalPath, pattern));
          if (inFolder && !excluded) {
            (asset.status === AssetStatus.Trashed ? trashedToOnline : toOnline).push(asset.id);
          }
          break;
        }
        case AssetSyncResult.DO_NOTHING: {
          break;
        }
      }
    }

    // stat may have waited on a share that disconnected. Recheck before any offline/online write.
    await this.requireSources(roots, signal);
    await this.requireNonemptySources(library, roots, signal);
    if (signal.aborted) return;
    const counts = await this.applyBatch(
      operation,
      claimToken,
      library,
      result,
      signal,
      async (assets) => {
        const excluded = await assets.getExcludedExternalAssetIds(
          library.id,
          assetIds,
          library.importPaths,
          library.exclusionPatterns,
        );
        const excludedSet = new Set(excluded);
        const offline = [...excluded, ...toOffline.filter((id) => !excludedSet.has(id))];
        const trashedOffline = trashedToOffline.filter((id) => !excludedSet.has(id));
        const online = toOnline.filter((id) => !excludedSet.has(id));
        const trashedOnline = trashedToOnline.filter((id) => !excludedSet.has(id));
        toUpdate.splice(0, toUpdate.length, ...toUpdate.filter((id) => !excludedSet.has(id)));
        const now = new Date();
        if (offline.length > 0) await assets.updateAll(offline, { isOffline: true, deletedAt: now });
        if (trashedOffline.length > 0) await assets.updateAll(trashedOffline, { isOffline: true });
        if (online.length > 0) await assets.updateAll(online, { isOffline: false, deletedAt: null });
        if (trashedOnline.length > 0) await assets.updateAll(trashedOnline, { isOffline: false });
        return {
          offlined: offline.length + trashedOffline.length,
          onlined: online.length + trashedOnline.length,
          updated: toUpdate.length,
        };
      },
      {
        examined: assetIds.length,
        sourceIds: () => toUpdate,
        checkpoint: (counts) => ({
          ...result,
          cursor: assetIds.at(-1)!,
          checked: result.checked + assetIds.length,
          updated: result.updated + counts.updated,
          offlined: result.offlined + counts.offlined,
          onlined: result.onlined + counts.onlined,
        }),
      },
    );
    return counts;
  }

  private async importFiles(
    operation: MediaOperation,
    claimToken: string,
    library: LibraryRow,
    paths: string[],
    result: LibraryScanResult,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    if (paths.length === 0) {
      return 0;
    }

    const rows: ReturnType<typeof libraryAssetFromFile>[] = [];
    for (const filePath of paths) {
      signal.throwIfAborted();
      const assetPath = path.normalize(filePath);
      try {
        if (await resolvesIntoMediaStorage(this.storageRepository, assetPath)) {
          this.logger.warn(`Skipping ${assetPath} for library ${library.id}: it links into the media storage`);
          continue;
        }
        signal.throwIfAborted();
        const stat = await this.storageRepository.stat(assetPath);
        signal.throwIfAborted();
        rows.push(
          libraryAssetFromFile(
            { path: assetPath, mtime: stat.mtime },
            { ownerId: library.ownerId, libraryId: library.id },
            (value) => this.cryptoRepository.hashSha1(value),
            mimeTypes.isVideo(assetPath),
          ),
        );
      } catch (error) {
        signal.throwIfAborted();
        this.logger.error(`Error processing ${assetPath} for library ${library.id}: ${error}`);
      }
    }

    signal.throwIfAborted();
    const assetIds = await this.applyBatch(
      operation,
      claimToken,
      library,
      result,
      signal,
      async (assets) => {
        const fresh = new Set(
          await assets.filterNewExternalAssetPaths(
            library.id,
            rows.map((row) => row.originalPath),
          ),
        );
        return assets.createAll(rows.filter((row) => fresh.has(row.originalPath)));
      },
      {
        examined: paths.length,
        sourceIds: (ids) => ids,
        checkpoint: (ids) => ({ ...result, crawled: result.crawled + paths.length, added: result.added + ids.length }),
      },
    );
    if (!assetIds) return;
    if (assetIds.length === 0) return 0;
    signal.throwIfAborted();
    await Promise.all(
      assetIds.map(async (assetId) => {
        try {
          await this.eventRepository.emit('AssetCreate', { asset: { id: assetId, ownerId: library.ownerId } });
        } catch (error) {
          this.logger.warn(`Scan asset notification failed after durable acceptance: ${bulkErrorMessage(error)}`);
        }
      }),
    );
    signal.throwIfAborted();
    return assetIds.length;
  }

  /** Every folder must be a readable directory now, or the scan fails naming the ones that are not. */
  private async requireSources(roots: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const checks = await Promise.all(
      roots.map(async (root) => {
        signal?.throwIfAborted();
        return checkImportPathFormat(root) ?? (await checkImportPathOnDisk(this.storageRepository, root));
      }),
    );
    signal?.throwIfAborted();
    const unavailable = checks.filter((check) => !check.isValid);
    if (unavailable.length > 0) {
      throw new LibraryScanRefusal(
        'library_source_unavailable',
        unavailable.map((check) => `${check.importPath}: ${check.message}`).join('; '),
      );
    }
  }

  /** An empty readable mount point is unavailable when it still has indexed online items. */
  private async requireNonemptySources(
    library: LibraryRow,
    roots: string[],
    signal: AbortSignal,
    found?: Map<string, number>,
  ) {
    for (const root of roots) {
      signal.throwIfAborted();
      let count = found?.get(root) ?? 0;
      if (count === 0) {
        for await (const batch of this.storageRepository.walkLibrary({
          pathsToCrawl: [root],
          includeHidden: false,
          exclusionPatterns: [],
          take: 1,
          signal,
        })) {
          if (batch.length > 0) {
            count = batch.length;
            break;
          }
        }
      }
      if (count > 0) continue;
      const indexed = await this.libraryRepository.countOnlineAssetsUnder(library.id, root);
      if (indexed > 0)
        throw new LibraryScanRefusal(
          'library_source_empty',
          `${root} has no files but ${indexed} indexed items are in it; if it is disconnected, reconnect it and scan again, or remove it from the library`,
        );
    }
  }

  private async applyBatch<T>(
    operation: MediaOperation,
    claimToken: string,
    library: LibraryRow,
    result: LibraryScanResult,
    signal: AbortSignal,
    mutate: (assets: AssetRepository, library: LibraryRepository) => Promise<T>,
    options: {
      examined?: number;
      sourceIds?: (value: T) => string[];
      checkpoint?: (value: T) => LibraryScanResult;
      close?: boolean;
    } = {},
  ): Promise<T | undefined> {
    signal.throwIfAborted();
    let outcome: { value: T } | { stopReason: LibraryScanStopReason } | undefined;
    try {
      outcome = await this.jobRepository.commitLibraryScanBatch(
        { operationId: operation.id, libraryId: library.id },
        options.examined ?? 0,
        async (tx) => {
          let sourceIds: string[] = [];
          const outcome = await this.libraryRepository.withScanClaim(
            { operationId: operation.id, claimToken, libraryId: library.id, fingerprint: result.fingerprint! },
            async (assets, repository) => {
              // Locks may have waited after the preflight check. Abort before and after mutation so
              // withScanClaim rolls back a cancelled in-flight transaction.
              signal.throwIfAborted();
              const value = await mutate(assets, repository);
              const checkpoint = options.checkpoint?.(value) ?? result;
              const units = libraryScanUnits(checkpoint);
              const written = await this.operations.setBulkResult(
                operation.id,
                claimToken,
                {
                  result: checkpoint as unknown as Record<string, unknown>,
                  processedUnits: units.processed,
                  totalUnits: units.total,
                  progress: libraryScanProgress(checkpoint),
                  leaseMs: LIBRARY_SCAN_LEASE_MS,
                },
                tx,
                true,
              );
              if (
                !written ||
                written.cancelRequestedAt ||
                written.pauseRequestedAt ||
                written.status !== MediaOperationStatus.Rendering
              )
                throw new LibraryBatchStopped(written);
              sourceIds = options.sourceIds?.(value) ?? [];
              signal.throwIfAborted();
              return value;
            },
            tx,
          );
          return { value: outcome, assetIds: sourceIds, accepted: !!outcome && 'value' in outcome };
        },
        options.close ?? false,
      );
    } catch (error) {
      if (!(error instanceof LibraryBatchStopped)) throw error;
      await this.proceed(operation, claimToken, error.written, result);
      return;
    }
    if (!outcome) {
      await this.write(operation, claimToken, result, signal);
      return;
    }
    if ('stopReason' in outcome) {
      await this.stopSelf(operation, claimToken, result, outcome.stopReason);
      return;
    }
    if (!signal.aborted) advanceJobProgress(options.examined ?? 0);
    return outcome.value;
  }

  private async requireActiveOwner(library: LibraryRow) {
    const owner = await this.userRepository.get(library.ownerId, { withDeleted: true });
    if (!owner || owner.deletedAt || owner.status !== UserStatus.Active) {
      throw new BadRequestException('The library owner account is deleted. Restore it before scanning.');
    }
  }

  private async start(id: string, claimToken: string, result: LibraryScanResult): Promise<boolean> {
    const units = libraryScanUnits(result);
    const running = await this.operations.reportProgress(id, claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: units.processed,
      totalUnits: units.total,
      progress: libraryScanProgress(result),
    });
    return running;
  }

  /** Record progress, then carry on unless the scan was cancelled, paused or lost. */
  private async write(
    operation: MediaOperation,
    claimToken: string,
    result: LibraryScanResult,
    signal: AbortSignal,
    committedUnits = 0,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const units = libraryScanUnits(result);
    const written = await this.operations.setBulkResult(operation.id, claimToken, {
      result: result as unknown as Record<string, unknown>,
      processedUnits: units.processed,
      totalUnits: units.total,
      progress: libraryScanProgress(result),
      leaseMs: LIBRARY_SCAN_LEASE_MS,
    });
    // Status/phase/heartbeat writes pass zero. Only durable newly examined pages advance the queue.
    if (written && !signal.aborted) advanceJobProgress(committedUnits);
    return this.proceed(operation, claimToken, written, result);
  }

  private async proceed(
    operation: MediaOperation,
    claimToken: string,
    written: MediaOperationWriteState | undefined,
    result: LibraryScanResult,
  ): Promise<boolean> {
    if (!written) {
      this.logger.warn(`Scan ${operation.id}: claim lost, stopping`);
      return false;
    }

    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.settleCancel(operation, claimToken, result);
      return false;
    }

    if (written.pauseRequestedAt && (await this.operations.settlePause(operation.id, claimToken))) {
      this.logger.log(`Scan ${operation.id} paused`);
      return false;
    }

    return true;
  }

  /** A cancel reached this scan: acknowledge it and say why, when the server asked for it. */
  private async settleCancel(operation: MediaOperation, claimToken: string, result: LibraryScanResult) {
    if (!(await this.operations.acknowledgeCancel(operation.id, claimToken, { released: false }))) {
      // not cancelling after all: the claim was simply lost, and recovery will judge the job
      return;
    }
    await this.jobRepository.settleLibraryScanSource(operation.id, () => Promise.resolve());
    const stopReason = await this.whyStopped(parseLibraryScanSnapshot(operation.snapshot).libraryId, result);
    await this.operations.setFinishedResult(operation.id, { ...result, stopReason } as Record<string, unknown>);
    this.logger.log(`Scan ${operation.id} cancelled${stopReason ? ` (${stopReason})` : ''}`);
  }

  /** The folders changed under a claimed scan: stop it the way an administrator's change would. */
  private async stopSelf(
    operation: MediaOperation,
    claimToken: string,
    result: LibraryScanResult,
    reason: LibraryScanStopReason,
  ) {
    await this.operations.requestCancel(operation.id, operation.ownerId, claimToken);
    if (!(await this.operations.acknowledgeCancel(operation.id, claimToken, { released: false }))) {
      return;
    }
    await this.jobRepository.settleLibraryScanSource(operation.id, () => Promise.resolve());
    await this.operations.setFinishedResult(operation.id, { ...result, stopReason: reason } as Record<string, unknown>);
    this.logger.log(`Scan ${operation.id} stopped (${reason})`);
  }

  private async whyStopped(libraryId: string, result: LibraryScanResult): Promise<LibraryScanStopReason | null> {
    const library = await this.libraryRepository.get(libraryId, true);
    if (!library || library.deletedAt) {
      return 'library_removed';
    }
    const owner = await this.userRepository.get(library.ownerId, { withDeleted: true });
    if (!owner || owner.deletedAt || owner.status !== UserStatus.Active) {
      return 'owner_deleted';
    }
    if (result.fingerprint && libraryPathsFingerprint(library) !== result.fingerprint) {
      return 'paths_changed';
    }
    return null;
  }

  private async audit(auth: AuthDto, library: LibraryRow, action: AdminAuditAction) {
    try {
      await this.adminAuditRepository.create([
        {
          userId: library.ownerId,
          actorId: auth.user.id,
          libraryId: library.id,
          action,
          subject: library.name,
          detail: null,
        },
      ]);
    } catch (error) {
      this.logger.error(`Unable to record administrator activity (${action}): ${error}`);
    }
  }

  private async findOrFail(libraryId: string): Promise<LibraryRow> {
    const library = await this.libraryRepository.get(libraryId);
    if (!library) {
      throw new BadRequestException('Library not found');
    }
    return library;
  }
}

/** What an existing item needs after its file was looked at. */
export const checkExistingAsset = (
  asset: { isOffline: boolean; originalPath: string; status: AssetStatus; fileModifiedAt: Date },
  stat: Pick<Stats, 'mtime'> | null,
): AssetSyncResult => {
  if (!stat) {
    // missing, or unreadable: an item with no readable file is offline
    return asset.isOffline ? AssetSyncResult.DO_NOTHING : AssetSyncResult.OFFLINE;
  }

  if (asset.isOffline && asset.status !== AssetStatus.Deleted) {
    return AssetSyncResult.CHECK_OFFLINE;
  }

  if (stat.mtime.valueOf() !== asset.fileModifiedAt.valueOf()) {
    return AssetSyncResult.UPDATE;
  }

  return AssetSyncResult.DO_NOTHING;
};

/** A scan job as the library page shows it. */
export const mapLibraryScan = (operation: MediaOperation): LibraryScanResponseDto => {
  const result = parseLibraryScanResult(operation.result);
  const status = operation.status as MediaOperationStatus;
  const asDate = (value: unknown) => (value ? new Date(value as string | Date) : null);
  return {
    operationId: operation.id,
    status,
    phase: result.phase,
    progress: status === MediaOperationStatus.Completed ? 100 : Math.max(0, Math.min(100, Number(operation.progress))),
    processedUnits: Number(operation.processedUnits ?? 0),
    totalUnits: Number(operation.totalUnits ?? 0),
    added: result.added,
    checked: result.checked,
    updated: result.updated,
    offlined: result.offlined,
    onlined: result.onlined,
    pauseRequested: !!operation.pauseRequestedAt && status !== MediaOperationStatus.Paused,
    retrying: status === MediaOperationStatus.Queued && Number(operation.autoRetries ?? 0) > 0 && !!operation.error,
    stopReason: result.stopReason,
    errorCode: operation.errorCode ?? null,
    error: operation.error ?? null,
    createdAt: asDate(operation.createdAt)!,
    startedAt: asDate(operation.startedAt),
    finishedAt: asDate(operation.finishedAt),
  };
};
