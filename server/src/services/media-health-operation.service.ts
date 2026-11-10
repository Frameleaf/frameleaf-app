import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OnEvent } from 'src/decorators.js';
import { FrameleafWorker, MediaOperationKind, MediaOperationStatus, QueueName } from 'src/enum.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationRepository,
  type MediaOperationWriteState,
} from 'src/repositories/media-operation.repository.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { bulkErrorMessage } from 'src/utils/bulk-operation.js';
import {
  MediaHealthLocateResult,
  MediaHealthLocateSnapshot,
  MediaHealthOperationSnapshot,
  MediaHealthScanResult,
  MediaHealthScanSnapshot,
  parseLocateResult,
  parseMediaHealthSnapshot,
  parseScanResult,
  scanProgress,
} from 'src/utils/media-health-operation.js';

type Counts = { checked: number; missing?: number; corrupt?: number; found?: number };
type Progress = { counts: Counts };

/** How often the worker looks for queued Library Care jobs. */
export const MEDIA_HEALTH_TICK_MS = 5000;
/**
 * The claim lease, renewed after every batch. A batch deep-validates its assets, and a large video
 * can take a while, so the batch is small and the lease generous.
 */
export const MEDIA_HEALTH_LEASE_MS = 5 * 60_000;
/** Assets checked between two cursor writes. */
export const MEDIA_HEALTH_SCAN_BATCH = 25;
/**
 * Tries a batch gets when PostgreSQL gives up waiting for a lock (the pool's 5 s lock_timeout) or picks it to
 * break a deadlock. An import writes the same asset rows for hours; one contended batch must not fail a scan of
 * hundreds of thousands, which setup then waits on for good. The waits (5, 10, … 45 s, under four minutes in
 * all) stay inside the lease, which the keep-alive renews anyway.
 */
export const MEDIA_HEALTH_LOCK_TRIES = 10;
export const MEDIA_HEALTH_LOCK_BACKOFF_MS = 5000;

const isLockContention = (error: unknown) =>
  error instanceof Error && 'code' in error && (error.code === '55P03' || error.code === '40P01');

/**
 * The worker behind Library Care scans and searches (FL-69).
 *
 * A scan or a search is a `media_operation` of kind `media_health`: the row is the job, as with
 * FL-32's bulk jobs, so it shows in Activity and the notifications panel, survives the browser, a
 * restart or a lost worker, and is claimed with a lease so two workers never run it at once.
 *
 * - **Resumable.** A scan works through the owner's assets in id order and records the last id it
 *   finished after every batch; a search records the directory walk's cursor. A claim carries on
 *   from whatever the row says. Every step is an upsert, so doing a batch twice is harmless.
 * - **Pausable.** A pause or cancel is honoured at the next batch boundary through the same guarded
 *   writes bulk jobs use. The health runs Library Care shows follow the job: running, paused,
 *   retrying, cancelled, failed or completed.
 * - **Retried once.** A job that fails is handed to `MediaOperationRepository.fail`, which gives it
 *   its one automatic retry before the failure is reported (owner decision, September 22, 2026).
 * - **Backend access.** The worker reads every asset of the owner, Locked ones included: background
 *   work must be able to reach Locked media (owner decision, September 22, 2026). Nothing it reads is
 *   shown to anybody; the findings it writes are read back through the owner's privacy.
 */
@Injectable()
export class MediaHealthOperationService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private readonly workerId = `media-health-${randomUUID()}`;

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private mediaHealth: MediaHealthService,
    private jobRepository: JobRepository,
  ) {
    this.logger.setContext(MediaHealthOperationService.name);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => this.tick(), MEDIA_HEALTH_TICK_MS);
    this.tick();
  }

  /** Stop taking work and let the batch in hand land; the lease hands the job to the next worker. */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    await this.active;
  }

  tick() {
    if (this.active || this.stopping) {
      return;
    }

    this.active = this.drain()
      .catch((error) => this.logger.warn(`Library Care worker failed: ${bulkErrorMessage(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  /** Lapsed claims are recovered by `MediaOperationSweepService`, for every kind, not here. */
  async drain(): Promise<void> {
    while (!this.stopping) {
      // A queued job is left as it is: only a scan that is running is handed back and marked paused.
      if (await this.queuePaused()) {
        return;
      }
      const claim = await this.operations.claimNext({
        kinds: [MediaOperationKind.MediaHealth],
        workerId: this.workerId,
        leaseMs: MEDIA_HEALTH_LEASE_MS,
      });
      if (!claim) {
        return;
      }

      await this.run(claim.operation, claim.claimToken);
    }
  }

  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    let snapshot: MediaHealthOperationSnapshot;
    try {
      snapshot = parseMediaHealthSnapshot(operation.snapshot);
    } catch (error) {
      await this.operations.fail(operation.id, claimToken, {
        error: bulkErrorMessage(error),
        errorCode: 'media_health_snapshot_invalid',
      });
      return;
    }

    // A search step hashes up to gigabytes and a scan batch decodes whole videos: the claim is kept
    // alive while the job is in hand, and a lost claim still stops it at the next write.
    const keepAlive = setInterval(() => {
      this.operations.heartbeat(operation.id, claimToken, MEDIA_HEALTH_LEASE_MS).catch(() => false);
    }, MEDIA_HEALTH_LEASE_MS / 4);
    // What the job has recorded so far, so a failure reports the counts it actually reached.
    const progress: Progress = {
      counts: snapshot.mode === 'scan' ? parseScanResult(operation.result) : parseLocateResult(operation.result),
    };
    try {
      await (snapshot.mode === 'scan'
        ? this.scan(operation, claimToken, snapshot, progress)
        : this.locate(operation, claimToken, snapshot, progress));
    } catch (error) {
      // A step cut short by shutdown (a lock wait given up, a closing connection) is not the job failing. A claim
      // that cannot be handed back is left to the lease.
      if (this.stopping) {
        await this.handBack(operation.id, claimToken, snapshot, progress.counts);
        return;
      }
      const message = bulkErrorMessage(error);
      this.logger.error(`Library Care job ${operation.id} failed: ${message}`);
      const failed = await this.operations.fail(operation.id, claimToken, {
        error: message,
        errorCode: 'media_health_failed',
      });
      if (failed) {
        const state = failed === 'retrying' ? 'retrying' : 'failed';
        await this.mediaHealth.setRunState(snapshot, state, progress.counts, message);
      }
    } finally {
      clearInterval(keepAlive);
    }
  }

  /** A scan of every asset the owner has, a batch at a time from the recorded cursor. */
  private async scan(
    operation: MediaOperation,
    claimToken: string,
    snapshot: MediaHealthScanSnapshot,
    progress: Progress,
  ) {
    const { id } = operation;
    let result: MediaHealthScanResult = parseScanResult(operation.result);
    if (result.total === null) {
      result = {
        ...result,
        total: snapshot.assetIds
          ? snapshot.assetIds.length
          : snapshot.changedSince
            ? await this.mediaHealth.countScanAssets(snapshot.userId, snapshot.changedSince)
            : await this.mediaHealth.countScanAssets(snapshot.userId),
      };
    }

    if (!(await this.start(id, claimToken, result.checked, result.total))) {
      return;
    }
    await this.mediaHealth.setRunState(snapshot, 'running', result);

    while (!result.restored) {
      if (this.stopping) {
        await this.handBack(id, claimToken, snapshot, result);
        return;
      }
      if (await this.queuePaused()) {
        await this.holdForPausedQueue(id, claimToken, snapshot, result);
        return;
      }

      const cursor = result.cursor;
      const page = await this.contended(() => this.mediaHealth.scanPage(snapshot, cursor, MEDIA_HEALTH_SCAN_BATCH));
      const done = page.checked < MEDIA_HEALTH_SCAN_BATCH;
      // The last step: supported media in library storage that no asset tracks comes back. Not for a
      // scan of chosen photos (FL-737): it would turn the stray files File checks lists into photos.
      if (done && !snapshot.assetIds) {
        await this.contended(() => this.mediaHealth.restoreUntracked(snapshot.userId));
      }

      result = {
        ...result,
        cursor: page.lastId,
        checked: result.checked + page.checked,
        missing: result.missing + page.missing,
        corrupt: result.corrupt + page.corrupt,
        total: Math.max(result.total ?? 0, result.checked + page.checked),
        restored: done,
      };
      progress.counts = result;

      const written = await this.operations.setBulkResult(id, claimToken, {
        result: result as unknown as Record<string, unknown>,
        processedUnits: result.checked,
        totalUnits: result.total ?? result.checked,
        progress: scanProgress(result),
        leaseMs: MEDIA_HEALTH_LEASE_MS,
      });
      if (!(await this.proceed(id, claimToken, written, snapshot, result))) {
        return;
      }
    }

    await this.finish(id, claimToken, snapshot, result);
  }

  /**
   * Stopping hands the job back at once, attempt returned, as a library scan does: left to its lease, the restart
   * would count as a lost worker and use the job's one automatic retry, so a second restart during a long scan
   * would fail it. A job its owner asked to cancel is not handed back but cancelled now, so another scan can start
   * without waiting for the lease. A claim that cannot be settled while the database closes is left to the lease.
   */
  private async handBack(id: string, claimToken: string, snapshot: MediaHealthOperationSnapshot, counts: Counts) {
    try {
      if (await this.operations.requeue(id, claimToken, { delayMs: 0, returnAttempt: true })) {
        return;
      }
      if (await this.operations.acknowledgeCancel(id, claimToken, { released: false })) {
        await this.mediaHealth.setRunState(snapshot, 'cancelled', counts);
      }
    } catch (error) {
      this.logger.warn(
        `Library Care job ${id} could not be handed back on stopping; its lease will: ${bulkErrorMessage(error)}`,
      );
    }
  }

  /**
   * Job manager's pause of the Media Health queue holds Library Care scans and searches too: they run here,
   * not on that queue, so without this a pause there changed nothing.
   */
  private async queuePaused(): Promise<boolean> {
    return (await this.jobRepository.isPaused(QueueName.MediaHealth)) === true;
  }

  /** Hands the job back between batches, cursor kept, until the queue is resumed; its runs say paused meanwhile. */
  private async holdForPausedQueue(
    id: string,
    claimToken: string,
    snapshot: MediaHealthOperationSnapshot,
    counts: Counts,
  ) {
    // Marked paused while the claim is still ours: once requeued, a worker that sees the queue resumed may claim
    // it and mark it running, and a later 'paused' write would hide that.
    await this.mediaHealth.setRunState(snapshot, 'paused', counts);
    if (!(await this.operations.requeue(id, claimToken, { delayMs: 0, returnAttempt: true }))) {
      // Cancelled or no longer ours: settled as a stop would settle it.
      await this.handBack(id, claimToken, snapshot, counts);
      return;
    }
    this.logger.log(`Library Care job ${id} held: the Media Health queue is paused`);
  }

  /** Repeats a step that lost a lock wait; a scan step is an upsert, so running it again is harmless. */
  private async contended<T>(step: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step();
      } catch (error) {
        if (!isLockContention(error) || attempt >= MEDIA_HEALTH_LOCK_TRIES || this.stopping) {
          throw error;
        }
        this.logger.warn(`Library Care batch waited too long for a database lock; trying again (${attempt})`);
        await new Promise((resolve) => setTimeout(resolve, MEDIA_HEALTH_LOCK_BACKOFF_MS * attempt));
      }
    }
  }

  /** A search for originals, one bounded step of the directory walk at a time. */
  private async locate(
    operation: MediaOperation,
    claimToken: string,
    snapshot: MediaHealthLocateSnapshot,
    progress: Progress,
  ) {
    const { id } = operation;
    let result: MediaHealthLocateResult = parseLocateResult(operation.result);
    const total = snapshot.findingIds.length;

    if (!(await this.start(id, claimToken, 0, total))) {
      return;
    }
    await this.mediaHealth.setRunState(snapshot, 'running', result);

    let complete = false;
    while (!complete) {
      if (this.stopping) {
        await this.handBack(id, claimToken, snapshot, result);
        return;
      }
      if (await this.queuePaused()) {
        await this.holdForPausedQueue(id, claimToken, snapshot, result);
        return;
      }

      const step = await this.mediaHealth.locateStep(snapshot, result.managedSearch);
      result = {
        managedSearch: step.continuation ?? null,
        checked: step.checkedAssets,
        found: step.foundAssets,
        steps: result.steps + 1,
      };
      progress.counts = result;

      complete = !step.continuation;
      const written = await this.operations.setBulkResult(id, claimToken, {
        result: result as unknown as Record<string, unknown>,
        processedUnits: complete ? total : 0,
        totalUnits: total,
        // A directory walk has no honest percentage until it is over.
        progress: complete ? 99 : 0,
        leaseMs: MEDIA_HEALTH_LEASE_MS,
      });
      if (!(await this.proceed(id, claimToken, written, snapshot, result))) {
        return;
      }
    }

    await this.finish(id, claimToken, snapshot, result);
  }

  private async start(id: string, claimToken: string, processed: number, total: number | null) {
    const running = await this.operations.reportProgress(id, claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: processed,
      totalUnits: total,
      progress: 0,
    });
    if (!running) {
      // Cancelled between the claim and this write, or the claim is gone.
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
    }
    return running;
  }

  private async finish(
    id: string,
    claimToken: string,
    snapshot: MediaHealthOperationSnapshot,
    counts: { checked: number; missing?: number; corrupt?: number; found?: number },
  ) {
    if (await this.operations.beginValidation(id, claimToken)) {
      await this.mediaHealth.setRunState(snapshot, 'completed', counts);
      if (!(await this.operations.complete(id, claimToken, { resultAssetId: null }))) {
        // Cancelled after the last batch was checked (FL-43): the run did finish, so its record says
        // so, and the cancel is acknowledged now rather than when the lease lapses.
        await this.operations.acknowledgeCancel(id, claimToken, { released: false });
        return;
      }
      this.logger.log(`Library Care ${snapshot.mode} ${id} finished (${counts.checked} checked)`);
      if (snapshot.mode === 'locate' && snapshot.lookIn) {
        // FL-1337: a person's Look in a folder says what it found, and puts back the one exact copy
        await this.mediaHealth
          .finishLookIn(snapshot)
          .catch((error: unknown) =>
            this.logger.warn(`Library Care search ${id} could not record what it found: ${bulkErrorMessage(error)}`),
          );
      }
      return;
    }

    if (await this.operations.acknowledgeCancel(id, claimToken, { released: false })) {
      await this.mediaHealth.setRunState(snapshot, 'cancelled', counts);
    }
  }

  /**
   * Whether to carry on after a write: no row means the claim was taken away; a cancel ends the job
   * here; a pause hands it back, to resume from this cursor (FL-104). The runs follow.
   */
  private async proceed(
    id: string,
    claimToken: string,
    written: MediaOperationWriteState | undefined,
    snapshot: MediaHealthOperationSnapshot,
    counts: { checked: number; missing?: number; corrupt?: number; found?: number },
  ): Promise<boolean> {
    if (!written) {
      this.logger.warn(`Library Care job ${id}: claim lost, stopping`);
      return false;
    }

    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      if (await this.operations.acknowledgeCancel(id, claimToken, { released: false })) {
        await this.mediaHealth.setRunState(snapshot, 'cancelled', counts);
        this.logger.log(`Library Care job ${id} cancelled by its owner`);
      }
      return false;
    }

    if (written.pauseRequestedAt) {
      if (await this.operations.settlePause(id, claimToken)) {
        await this.mediaHealth.setRunState(snapshot, 'paused', counts);
        this.logger.log(`Library Care job ${id} paused by its owner`);
        return false;
      }
      // A withdrawn pause can continue; cancellation or claim loss cannot.
      if (!(await this.operations.heartbeat(id, claimToken, MEDIA_HEALTH_LEASE_MS, { requireActiveClaim: true }))) {
        if (await this.operations.acknowledgeCancel(id, claimToken, { released: false })) {
          await this.mediaHealth.setRunState(snapshot, 'cancelled', counts);
        }
        return false;
      }
    }

    return true;
  }
}
