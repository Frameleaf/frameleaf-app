import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OnEvent } from 'src/decorators.js';
import { ImmichWorker, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
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
  ) {
    this.logger.setContext(MediaHealthOperationService.name);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
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
        total: snapshot.changedSince
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
        return;
      }

      const page = await this.mediaHealth.scanPage(snapshot, result.cursor, MEDIA_HEALTH_SCAN_BATCH);
      const done = page.checked < MEDIA_HEALTH_SCAN_BATCH;
      if (done) {
        // The last step: supported media in library storage that no asset tracks comes back.
        await this.mediaHealth.restoreUntracked(snapshot.userId);
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
      return;
    }

    await this.operations.acknowledgeCancel(id, claimToken, { released: false });
    await this.mediaHealth.setRunState(snapshot, 'cancelled', counts);
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
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      await this.mediaHealth.setRunState(snapshot, 'cancelled', counts);
      this.logger.log(`Library Care job ${id} cancelled by its owner`);
      return false;
    }

    if (written.pauseRequestedAt && (await this.operations.settlePause(id, claimToken))) {
      await this.mediaHealth.setRunState(snapshot, 'paused', counts);
      this.logger.log(`Library Care job ${id} paused by its owner`);
      return false;
    }

    return true;
  }
}
