import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import { AssetBulkUpdateDto } from 'src/dtos/asset.dto.js';
import {
  ImmichWorker,
  MediaOperationBulkAction,
  MediaOperationItemStatus,
  MediaOperationKind,
  MediaOperationStatus,
  Permission,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { ArchiveOperationRepository, archiveAnswerOutcome } from 'src/repositories/archive-operation.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationRepository,
  type MediaOperationWriteState,
} from 'src/repositories/media-operation.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { DuplicateDecisionService } from 'src/services/duplicate-decision.service.js';
import { ImageEnrichmentService } from 'src/services/image-enrichment.service.js';
import { LivePhotoService } from 'src/services/live-photo.service.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { StackService } from 'src/services/stack.service.js';
import { TagService } from 'src/services/tag.service.js';
import { TrashService } from 'src/services/trash.service.js';
import { checkAccess, isGranted } from 'src/utils/access.js';
import {
  BULK_ACTION_PERMISSIONS,
  BULK_ASSET_JOBS,
  BULK_BATCH_SIZE,
  BULK_ITEM_PERMISSION,
  BulkOperationItem,
  BulkOperationResult,
  BulkOperationSnapshot,
  bulkAssetUpdate,
  bulkBatchLength,
  bulkErrorMessage,
  bulkGroupIndex,
  bulkProgress,
  classifyBulkError,
  fromBulkIdResponse,
  isDuplicateDecisionAction,
  isMediaHealthBulkAction,
  isRelativeDateShift,
  mergeBulkOutcomes,
  parseBulkResult,
  parseBulkSnapshot,
  planBulkRetryPass,
  pruneShiftOrigins,
  recordShiftOrigins,
} from 'src/utils/bulk-operation.js';
import { parseDuplicateGroups } from 'src/utils/duplicate-review.js';
import { MEDIA_OPERATION_AUTO_RETRY_DELAY_MS } from 'src/utils/media-operation.js';

/** How often the worker looks for queued bulk jobs. */
export const BULK_TICK_MS = 5000;
/** The claim lease. Extended after every batch; a worker that stops writing loses the job. */
export const BULK_LEASE_MS = 2 * 60_000;
/** Parallel calls for the actions the server only accepts one item at a time. */
export const BULK_ITEM_CONCURRENCY = 5;
/** Items per batch for Library Care relinks, recoveries and trash (FL-69). */
export const MEDIA_HEALTH_BULK_BATCH_SIZE = 5;

/** A failure of the whole job rather than of an item: the job stops and a retry resumes it. */
class BulkJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Outcome = BulkOperationItem;

/** What one claimed run carries from batch to batch. */
type BulkRun = {
  id: string;
  claimToken: string;
  ownerId: string;
  auth: AuthDto;
  snapshot: BulkOperationSnapshot;
  total: number;
  /** For a duplicate decision job, which group each asset belongs to: batches end on a group boundary. */
  groupIndex: ReadonlyMap<string, string> | null;
};

/** The result with neither pass marked in flight. */
const withoutInFlight = (result: BulkOperationResult): BulkOperationResult => ({
  ...result,
  inFlight: null,
  retry: result.retry ? { ...result.retry, inFlight: null } : null,
});

const isArchiveAction = (action: MediaOperationBulkAction) =>
  action === MediaOperationBulkAction.Archive || action === MediaOperationBulkAction.Unarchive;

const ok = (id: string): Outcome => ({ id, status: MediaOperationItemStatus.Ok });

const refused = (id: string, error: unknown): Outcome => {
  const { status, reasonKey } = classifyBulkError(error);
  return { id, status, reasonKey, message: bulkErrorMessage(error) };
};

/**
 * One outcome per id, in batch order. The resume cursor counts items, so a batch that answered for
 * fewer ids than it was given would silently shift every later item; anything unanswered is
 * reported as a failure instead, which a retry will pick up.
 */
const inBatchOrder = (batch: readonly string[], outcomes: readonly Outcome[]): Outcome[] => {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  return batch.map(
    (id) =>
      byId.get(id) ?? {
        id,
        status: MediaOperationItemStatus.Failed,
        reasonKey: 'frameleaf_bulk_reason_unknown',
        message: 'The server did not answer for this item',
      },
  );
};

/**
 * The worker behind durable bulk operations (FL-32).
 *
 * A bulk operation is a `media_operation` row of kind `bulk`. This service claims those rows on
 * the microservices worker, applies the action in batches through the same services a request from
 * the browser would use, and writes what happened back to the row after every batch. Nothing about
 * a running operation lives in a browser tab: closing it, restarting the server or losing the
 * network all leave the same row, and Activity is a view of it.
 *
 * The rules it keeps:
 *
 * - **The set is frozen.** It works through `snapshot.assetIds` in order and never re-resolves a
 *   filter. The count of answered items is the resume cursor.
 * - **Access is checked per item, at the moment of change**, as the owner and never as anybody
 *   else. The worker is a system actor for the owner's own library (owner decision, September 22,
 *   2026): it acts with an elevated session and without the hidden-content filter, so Locked and
 *   sensitive items the owner submitted are changed, not skipped. Ownership, album and tag access
 *   are still checked for every item and every batch. The Locked folder's PIN is enforced where it
 *   belongs, at submit: a job that includes Locked items can only be queued from an unlocked
 *   session (see `MediaOperationService.createBulk`). A job queued without the PIN skips any item
 *   that was locked after it was queued; nothing but Unmark Sensitive ever removes a lock.
 * - **Sensitive marking is the lock** (FL-34). Mark Sensitive writes a lock record and Unmark
 *   Sensitive removes it: no visibility change, no album write, no enrichment tags.
 * - **Cancel is honoured between batches** and the items already changed are reported, not hidden.
 * - **A worker that dies** leaves an in-flight marker, and the next claim applies that batch again.
 *   Every action is safe to repeat. The relative date shift is made so: before a batch is marked in
 *   flight, each item's capture date is recorded in the result, and the shift sets `recorded + n
 *   minutes` instead of adding to the current date (owner decision, September 22, 2026).
 * - **Every failure is retried once, automatically** (owner decision, September 22, 2026). A job
 *   that fails as a whole goes back to the queue through `MediaOperationRepository.fail`; items that
 *   failed inside a finished pass are given one more attempt in a retry pass, after a pause, before
 *   they are reported. Manual retry from Activity stays available afterwards.
 *
 * Deliberately not a queue job: the row is already the durable queue, and claiming it with a lease
 * is what makes a second worker, a restart or a stale process safe.
 */
@Injectable()
export class BulkOperationService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private readonly workerId = `bulk-${randomUUID()}`;
  /** Stands in for a session on the worker's auth; nothing on these paths reads it back. */
  private readonly sessionId = randomUUID();

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private access: AccessRepository,
    private users: UserRepository,
    private apiKeys: ApiKeyRepository,
    private assets: AssetService,
    private albums: AlbumService,
    private tags: TagService,
    private trash: TrashService,
    private stacks: StackService,
    private enrichment: ImageEnrichmentService,
    private livePhoto: LivePhotoService,
    private duplicateDecisions: DuplicateDecisionService,
    private mediaHealth: MediaHealthService,
    private classification: ClassificationService,
    private archiveOperations: ArchiveOperationRepository,
  ) {
    this.logger.setContext(BulkOperationService.name);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => this.tick(), BULK_TICK_MS);
    this.tick();
  }

  /**
   * Stop taking work and wait for the batch in hand to land. The job keeps its claim; when the
   * lease runs out it returns to the queue and the next worker resumes it from the cursor.
   */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    await this.active;
  }

  /** Never overlaps itself: a tick that finds work in hand does nothing. */
  tick() {
    if (this.active || this.stopping) {
      return;
    }

    this.active = this.drain()
      .catch((error) => this.logger.warn(`Bulk operation worker failed: ${bulkErrorMessage(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  /**
   * Work through the queue until it is empty or we are stopping.
   *
   * Lapsed claims are not recovered here. One sweep owns recovery for every kind of media
   * operation, so it never runs twice with two different answers: `MediaOperationSweepService`
   * returns lapsed bulk jobs to the queue (or gives them their automatic retry) with the rest.
   */
  async drain(): Promise<void> {
    while (!this.stopping) {
      const claim = await this.operations.claimNext({
        kinds: [MediaOperationKind.Bulk],
        workerId: this.workerId,
        leaseMs: BULK_LEASE_MS,
      });
      if (!claim) {
        return;
      }

      try {
        await this.run(claim.operation, claim.claimToken);
      } catch (error) {
        // An unexpected error is the job's failure, not the worker's: record it and move on.
        this.logger.error(`Bulk operation ${claim.operation.id} failed: ${bulkErrorMessage(error)}`);
        await this.operations.fail(claim.operation.id, claim.claimToken, {
          error: bulkErrorMessage(error),
          errorCode: 'bulk_failed',
        });
      }
    }
  }

  /**
   * Apply one claimed operation: the frozen set from its cursor to the end, a batch at a time, then
   * the one automatic retry of the items that failed.
   *
   * A claim can find the job anywhere on that path — fresh, partway through the first pass, back in
   * the queue for its retry pass, or partway through that — and carries on from what the row says.
   */
  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    const { id } = operation;

    let snapshot: BulkOperationSnapshot;
    try {
      snapshot = parseBulkSnapshot(operation.snapshot);
    } catch (error) {
      await this.operations.fail(id, claimToken, {
        error: bulkErrorMessage(error),
        errorCode: 'bulk_snapshot_invalid',
      });
      return;
    }

    const total = snapshot.assetIds.length;
    // A batch the previous worker had in hand is applied again from the same cursor. Every action
    // is safe to repeat — the relative date shift too, because it shifts from the starting dates
    // recorded before the batch was first sent — so nothing is reported as interrupted any more.
    let result = withoutInFlight(parseBulkResult(operation.result, total));
    let processed = Math.min(Math.max(0, Number(operation.processedUnits ?? 0)), total);

    const started = await this.write(id, claimToken, result, processed, total);
    if (!(await this.proceed(id, claimToken, started))) {
      return;
    }

    const running = await this.operations.reportProgress(id, claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: processed,
      totalUnits: total,
      progress: bulkProgress(processed, total),
    });
    if (!running) {
      // Cancelled in the moment between the two writes, or the claim is gone.
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      return;
    }

    const auth = await this.authFor(operation.ownerId);
    if (!auth) {
      await this.operations.fail(id, claimToken, {
        error: 'The account that submitted this job no longer exists',
        errorCode: 'bulk_owner_unavailable',
      });
      return;
    }

    const groupIndex = bulkGroupIndex(snapshot);
    const job: BulkRun = { id, claimToken, ownerId: operation.ownerId, auth, snapshot, total, groupIndex };
    // A stack is one call over every member, and unstacking works on stack ids: neither is batched.
    const whole =
      snapshot.action === MediaOperationBulkAction.Stack || snapshot.action === MediaOperationBulkAction.Unstack;
    // Library Care reads, hashes and may copy whole originals per item (FL-69): small batches keep the
    // lease, renewed after every batch, well ahead of the work.
    const batchSize = isMediaHealthBulkAction(snapshot.action) ? MEDIA_HEALTH_BULK_BATCH_SIZE : BULK_BATCH_SIZE;

    // The first pass: the frozen set, in order. The count of answered items is the cursor.
    while (processed < total) {
      if (this.stopping) {
        // Keep the claim; the lease expiring hands the job to the next worker at this cursor.
        return;
      }

      // a duplicate decision job never splits a group across two batches (FL-61)
      const size = whole ? total : bulkBatchLength(snapshot.assetIds, processed, batchSize, groupIndex);
      const batch = snapshot.assetIds.slice(processed, processed + size);
      result = await this.withShiftOrigins(job, result, batch);
      const marked = { ...result, inFlight: { start: processed, size: batch.length } };
      const outcomes = await this.step(job, marked, processed, batch);
      if (!outcomes) {
        return;
      }

      result = pruneShiftOrigins(snapshot, mergeBulkOutcomes({ ...result, inFlight: null }, outcomes));
      processed += batch.length;

      const written = await this.write(id, claimToken, result, processed, total);
      if (!(await this.proceed(id, claimToken, written))) {
        return;
      }
    }

    // Every item that failed gets one more attempt before it is reported (owner decision,
    // September 22, 2026). The pass is planned once, and the job goes back to the queue so the
    // retry happens after a pause rather than straight into whatever just went wrong.
    const planned = planBulkRetryPass(snapshot, result);
    if (planned) {
      result = planned;
      const written = await this.write(id, claimToken, result, processed, total);
      if (!(await this.proceed(id, claimToken, written))) {
        return;
      }

      if (
        await this.operations.requeue(id, claimToken, {
          delayMs: MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
          returnAttempt: true,
        })
      ) {
        this.logger.log(`Bulk operation ${id}: retrying ${planned.retry?.total ?? 0} failed items once`);
        return;
      }

      // Cancelled between the two writes, or the claim is gone.
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      return;
    }

    // The retry pass, with its own cursor. What happens here is what is reported.
    while (result.retry && result.retry.processed < result.retry.ids.length) {
      if (this.stopping) {
        return;
      }

      const pass = result.retry;
      const size = whole ? pass.ids.length : bulkBatchLength(pass.ids, pass.processed, batchSize, groupIndex);
      const batch = pass.ids.slice(pass.processed, pass.processed + size);
      result = await this.withShiftOrigins(job, result, batch);
      const outcomes = await this.step(
        job,
        { ...result, retry: { ...pass, inFlight: { start: pass.processed, size: batch.length } } },
        processed,
        batch,
      );
      if (!outcomes) {
        return;
      }

      const advanced = { ...pass, processed: pass.processed + batch.length, inFlight: null };
      result = pruneShiftOrigins(snapshot, mergeBulkOutcomes({ ...result, retry: advanced }, outcomes));

      const written = await this.write(id, claimToken, result, processed, total);
      if (!(await this.proceed(id, claimToken, written))) {
        return;
      }
    }

    // A cancel that lands between the two writes wins, and is acknowledged below rather than left
    // for the lease to lapse (FL-43).
    if (
      (await this.operations.beginValidation(id, claimToken)) &&
      (await this.operations.complete(id, claimToken, { resultAssetId: null }))
    ) {
      this.logger.log(
        `Bulk operation ${id} finished: ${result.succeeded} changed, ${result.skipped} skipped, ${result.failed} failed`,
      );
      return;
    }

    await this.operations.acknowledgeCancel(id, claimToken, { released: false });
  }

  /**
   * One batch, durably. `marked` is the result with this batch's in-flight marker (and, for a
   * relative shift, its recorded starting dates); it is written before anything is sent, so a worker
   * that dies mid-batch leaves a row that says exactly what to apply again.
   *
   * Returns the batch's outcomes in batch order, or null when the job must stop here: the claim was
   * lost, the owner cancelled, or the job itself failed (a revoked key or an album that is gone), in
   * which case nothing in the batch was applied and it is left unreached for the retry.
   */
  private async step(
    job: BulkRun,
    marked: BulkOperationResult,
    processed: number,
    batch: string[],
  ): Promise<Outcome[] | null> {
    const written = await this.write(job.id, job.claimToken, marked, processed, job.total);
    if (!(await this.proceed(job.id, job.claimToken, written))) {
      return null;
    }

    // Library Care reads, hashes and may copy whole originals (FL-69): one item can outlast the
    // lease, so the claim is kept alive while the batch is in hand. A lost claim still stops the job
    // at the next write.
    const keepAlive = isMediaHealthBulkAction(job.snapshot.action)
      ? setInterval(() => {
          this.operations.heartbeat(job.id, job.claimToken, BULK_LEASE_MS).catch(() => false);
        }, BULK_LEASE_MS / 4)
      : undefined;
    try {
      await this.requireCredentials(job.ownerId, job.snapshot);
      return inBatchOrder(batch, await this.applyBatch(job.auth, job.snapshot, batch, marked.shiftFrom, job.id));
    } catch (error) {
      if (error instanceof BulkJobError) {
        await this.write(job.id, job.claimToken, withoutInFlight(marked), processed, job.total);
        await this.operations.fail(job.id, job.claimToken, { error: error.message, errorCode: error.code });
        return null;
      }
      throw error;
    } finally {
      clearInterval(keepAlive);
    }
  }

  /**
   * For a relative date shift, record the capture date of every item in the batch that has none
   * recorded yet — before the batch is marked in flight and sent. An item that already has one keeps
   * it: the shift may have reached it since, and reading its date again would shift it twice.
   */
  private async withShiftOrigins(
    job: BulkRun,
    result: BulkOperationResult,
    batch: string[],
  ): Promise<BulkOperationResult> {
    if (!isRelativeDateShift(job.snapshot)) {
      return result;
    }

    const missing = batch.filter((assetId) => !(assetId in result.shiftFrom));
    if (missing.length === 0) {
      return result;
    }

    return recordShiftOrigins(result, missing, await this.operations.getDateTimeOriginals(job.ownerId, missing));
  }

  private write(id: string, claimToken: string, result: BulkOperationResult, processed: number, total: number) {
    return this.operations.setBulkResult(id, claimToken, {
      result: result as unknown as Record<string, unknown>,
      processedUnits: processed,
      totalUnits: total,
      progress: bulkProgress(processed, total),
      leaseMs: BULK_LEASE_MS,
    });
  }

  /**
   * Whether the worker may carry on after a write.
   *
   * No row means the claim was taken away — another worker has the job now, and this one must not
   * write again. A `cancelling` row means the owner asked to stop: the batch that was in hand has
   * already been recorded, so the cancel is acknowledged and the job ends here.
   *
   * A pause request (FL-104) stops the job at this same boundary, but hands it back instead of
   * ending it: everything up to here is recorded, and resuming carries on from the cursor. If the
   * owner resumed before the worker got here, the settle matches nothing and the job carries on.
   */
  private async proceed(
    id: string,
    claimToken: string,
    written: MediaOperationWriteState | undefined,
  ): Promise<boolean> {
    if (!written) {
      this.logger.warn(`Bulk operation ${id}: claim lost, stopping`);
      return false;
    }

    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      this.logger.log(`Bulk operation ${id} cancelled by its owner`);
      return false;
    }

    if (written.pauseRequestedAt && (await this.operations.settlePause(id, claimToken))) {
      this.logger.log(`Bulk operation ${id} paused by its owner`);
      return false;
    }

    return true;
  }

  /**
   * The owner, acting through the system worker.
   *
   * Elevated and unfiltered on purpose: a background job must be able to reach the owner's Locked
   * and sensitive items, because the person who submitted it could (owner decision, September 22,
   * 2026). What stays in force is everything that is not about elevation — each item must still be
   * the owner's to change, and the album or tag it is written to must still be the owner's to write.
   * Exposure is unchanged: this auth never leaves the worker, and nothing it reads is shown to
   * anybody.
   */
  async authFor(ownerId: string): Promise<AuthDto | null> {
    const user = await this.users.get(ownerId, { withDeleted: false });
    if (!user) {
      return null;
    }

    return {
      user: {
        id: user.id,
        isAdmin: user.isAdmin,
        name: user.name,
        email: user.email,
        quotaUsageInBytes: user.quotaUsageInBytes,
        quotaSizeInBytes: user.quotaSizeInBytes,
      },
      session: { id: this.sessionId, hasElevatedPermission: true },
    };
  }

  /** A job submitted with an API key stops if that key is revoked or narrowed. */
  private async requireCredentials(ownerId: string, snapshot: BulkOperationSnapshot) {
    if (!snapshot.apiKeyId) {
      return;
    }

    const key = await this.apiKeys.getById(ownerId, snapshot.apiKeyId);
    const requested = [...BULK_ACTION_PERMISSIONS[snapshot.action]];
    if (!key || !isGranted({ requested, current: key.permissions })) {
      throw new BulkJobError(
        'bulk_credentials_revoked',
        'The API key this job was submitted with has been revoked or no longer allows this action',
      );
    }
  }

  /**
   * The album or tags the job writes to must still be writable. Checked before every batch, so a
   * revoked album share stops the job instead of producing thousands of identical refusals.
   */
  private async requireTarget(auth: AuthDto, snapshot: BulkOperationSnapshot) {
    const { action, payload } = snapshot;
    const target = (() => {
      switch (action) {
        case MediaOperationBulkAction.AddToAlbum: {
          return { permission: Permission.AlbumAssetCreate, ids: [payload.albumId ?? ''] };
        }
        case MediaOperationBulkAction.RemoveFromAlbum: {
          return { permission: Permission.AlbumAssetDelete, ids: [payload.albumId ?? ''] };
        }
        case MediaOperationBulkAction.Tag:
        case MediaOperationBulkAction.Untag: {
          return { permission: Permission.TagAsset, ids: payload.tagIds ?? [] };
        }
        default: {
          return null;
        }
      }
    })();

    if (!target) {
      return;
    }

    const ids = target.ids.filter(Boolean);
    const allowed =
      ids.length > 0 ? await checkAccess(this.access, { auth, permission: target.permission, ids }) : new Set<string>();
    if (ids.length === 0 || allowed.size !== new Set(ids).size) {
      throw new BulkJobError(
        'bulk_target_unavailable',
        'The album or tag this job writes to is gone or no longer yours to change',
      );
    }
  }

  /**
   * Apply the action to one batch and answer for every id in it.
   *
   * Access is checked per item first wherever the service underneath would otherwise reject the
   * whole batch or quietly skip an item; the refusals are reported against the items that caused
   * them and only the rest is sent.
   *
   * `shiftFrom` is the recorded starting date of each item, for a relative date shift only.
   * `operationId` is the job's own id, which a duplicate decision is recorded against (FL-61).
   */
  async applyBatch(
    auth: AuthDto,
    snapshot: BulkOperationSnapshot,
    batch: string[],
    shiftFrom: BulkOperationResult['shiftFrom'] = {},
    operationId?: string,
  ): Promise<Outcome[]> {
    await this.requireTarget(auth, snapshot);

    if (isDuplicateDecisionAction(snapshot.action)) {
      return this.applyDuplicateBatch(auth, snapshot, batch, operationId);
    }

    const { action, payload } = snapshot;
    const outcomes: Outcome[] = [];
    let allowed = batch;

    const permission = BULK_ITEM_PERMISSION[action];
    if (permission) {
      const granted = await checkAccess(this.access, { auth, permission, ids: batch });
      allowed = [];
      for (const id of batch) {
        if (granted.has(id)) {
          allowed.push(id);
        } else {
          outcomes.push({
            id,
            status: MediaOperationItemStatus.Skipped,
            reasonKey: 'frameleaf_bulk_reason_no_permission',
          });
        }
      }
    }

    // FL-34: the PIN is checked at submit. An item locked after that (by a detection, or by joining a
    // locked stack or live photo) is only changed by a job submitted from an unlocked session.
    if (!snapshot.elevated && allowed.length > 0) {
      const locked = await this.operations.getLockedIds(allowed);
      if (locked.size > 0) {
        for (const id of allowed) {
          if (locked.has(id)) {
            outcomes.push({ id, status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_locked' });
          }
        }
        allowed = allowed.filter((id) => !locked.has(id));
        // FL-32: a transactional archive records them as skipped too, so its counts stay exact
        if (payload.archiveOperationId && operationId && isArchiveAction(action)) {
          await this.archiveOperations.skipUnreached(auth.user.id, payload.archiveOperationId, operationId, [
            ...locked,
          ]);
        }
      }
    }

    if (allowed.length === 0) {
      return outcomes;
    }

    if (isRelativeDateShift(snapshot)) {
      outcomes.push(...(await this.shiftDates(auth, allowed, payload.minutes ?? 0, shiftFrom)));
      return outcomes;
    }

    // FL-32: a transactional archive publishes, or undoes, through its operation's own item records
    if (payload.archiveOperationId && operationId && isArchiveAction(action)) {
      outcomes.push(
        ...(await this.applyArchiveOperation(auth, payload.archiveOperationId, operationId, action, allowed)),
      );
      return outcomes;
    }

    const update = bulkAssetUpdate(action, payload);
    if (update) {
      const send = (ids: string[]) => this.assets.updateAll(auth, { ids, ...update } as AssetBulkUpdateDto);
      outcomes.push(...(await this.inLists(allowed, send)));
      return outcomes;
    }

    const job = BULK_ASSET_JOBS[action];
    if (job) {
      outcomes.push(...(await this.inLists(allowed, (ids) => this.assets.run(auth, { assetIds: ids, name: job }))));
      return outcomes;
    }

    switch (action) {
      case MediaOperationBulkAction.Delete:
      case MediaOperationBulkAction.DeletePermanently: {
        const force = action === MediaOperationBulkAction.DeletePermanently;
        outcomes.push(...(await this.inLists(allowed, (ids) => this.assets.deleteAll(auth, { ids, force }))));
        break;
      }

      case MediaOperationBulkAction.Restore: {
        outcomes.push(...(await this.inLists(allowed, (ids) => this.trash.restoreAssets(auth, { ids }))));
        break;
      }

      case MediaOperationBulkAction.Tag: {
        const tagIds = payload.tagIds ?? [];
        outcomes.push(
          ...(await this.inLists(allowed, (ids) => this.tags.bulkTagAssets(auth, { assetIds: ids, tagIds }))),
        );
        break;
      }

      case MediaOperationBulkAction.Untag: {
        outcomes.push(...(await this.untag(auth, allowed, payload.tagIds ?? [])));
        break;
      }

      case MediaOperationBulkAction.AddToAlbum: {
        const albumId = payload.albumId as string;
        const responses = await this.albums.addAssets(auth, albumId, { ids: allowed });
        outcomes.push(...responses.map((response) => fromBulkIdResponse(response)));
        break;
      }

      case MediaOperationBulkAction.RemoveFromAlbum: {
        const albumId = payload.albumId as string;
        const responses = await this.albums.removeAssets(auth, albumId, { ids: allowed });
        outcomes.push(...responses.map((response) => fromBulkIdResponse(response)));
        break;
      }

      case MediaOperationBulkAction.MarkSensitive: {
        // Mark Sensitive is the lock (FL-34): a lock record for each item, its stack and live photo.
        // Album membership and the stored visibility are not touched.
        outcomes.push(...(await this.inLists(allowed, (ids) => this.assets.lock(auth, { ids }))));
        break;
      }

      case MediaOperationBulkAction.UnmarkSensitive: {
        // Unlock, which also records the owner's review so a later detection never locks it again.
        outcomes.push(...(await this.inLists(allowed, (ids) => this.enrichment.unlockAssets(auth, { ids }))));
        break;
      }

      case MediaOperationBulkAction.Stack: {
        const primaryId = payload.primaryId && allowed.includes(payload.primaryId) ? payload.primaryId : allowed[0];
        const ordered = [primaryId, ...allowed.filter((id) => id !== primaryId)];
        if (ordered.length < 2) {
          outcomes.push(
            ...ordered.map((id) => ({
              id,
              status: MediaOperationItemStatus.Skipped,
              reasonKey: 'frameleaf_bulk_reason_needs_two',
            })),
          );
          break;
        }
        try {
          await this.stacks.create(auth, { assetIds: ordered });
          outcomes.push(...ordered.map((id) => ok(id)));
        } catch (error) {
          outcomes.push(...ordered.map((id) => refused(id, error)));
        }
        break;
      }

      case MediaOperationBulkAction.Unstack: {
        try {
          await this.stacks.deleteAll(auth, { ids: payload.stackIds ?? [] });
          outcomes.push(...allowed.map((id) => ok(id)));
        } catch (error) {
          outcomes.push(...allowed.map((id) => refused(id, error)));
        }
        break;
      }

      case MediaOperationBulkAction.RelinkLivePhoto: {
        // `allowed` is the frozen set of still ids; the payload carries each still's video partner.
        // Submit validated this pairing, so a still with no partner here means a corrupt snapshot.
        const videoIdByPhotoId = new Map((payload.pairs ?? []).map((pair) => [pair.photoId, pair.videoId]));
        outcomes.push(...(await this.relinkLivePhotos(auth, allowed, videoIdByPhotoId)));
        break;
      }

      case MediaOperationBulkAction.RelinkMissingMedia:
      case MediaOperationBulkAction.RecoverDamagedMedia:
      case MediaOperationBulkAction.TrashDamagedMedia: {
        // Library Care (FL-69): one reviewed finding per item, re-read and re-verified now. The
        // service holds each item to its owner and Locked rules itself (`BULK_ITEM_PERMISSION` is null).
        const entries = new Map((payload.mediaHealth ?? []).map((entry) => [entry.assetId, entry]));
        for (const assetId of allowed) {
          const entry = entries.get(assetId);
          outcomes.push(
            entry
              ? await this.mediaHealth.applyBulkEntry(auth, action, entry)
              : { id: assetId, status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_not_found' },
          );
        }
        break;
      }

      case MediaOperationBulkAction.ApplyClassificationRule: {
        // FL-60: the rule re-reads and re-matches every item now; only its owner's unlocked items change.
        outcomes.push(...(await this.classification.applyBulkBatch(auth, payload.classificationRuleId, allowed)));
        break;
      }

      default: {
        // Every action is handled above; an unknown one is refused rather than guessed at.
        outcomes.push(...allowed.map((id) => refused(id, new Error(`Unsupported bulk action: ${action}`))));
      }
    }

    return outcomes;
  }

  /**
   * Duplicate review decisions and their undo (FL-61), one complete group at a time.
   *
   * A group is decided whole or not at all, so everything about it is answered for the whole group:
   * a group holding an item locked since a job submitted without the PIN is skipped entirely rather
   * than decided without that item, and a group's outcome is every member's outcome.
   */
  /**
   * One batch of a transactional archive (FL-32): publish or undo in one transaction per batch
   * (`ArchiveOperationRepository`), then push the changed assets to the owner's open sessions.
   */
  private async applyArchiveOperation(
    auth: AuthDto,
    archiveOperationId: string,
    jobId: string,
    action: MediaOperationBulkAction,
    batch: string[],
  ): Promise<Outcome[]> {
    const answers =
      action === MediaOperationBulkAction.Unarchive
        ? await this.archiveOperations.restore(auth.user.id, archiveOperationId, jobId, batch)
        : await this.archiveOperations.publish(auth.user.id, archiveOperationId, jobId, batch);
    const changed = batch.filter((id) => {
      const answer = answers.get(id);
      return answer === 'archived' || answer === 'undone';
    });
    if (changed.length > 0) {
      await this.assets.notifyVisibilityChanged(changed, auth.user.id);
    }
    return batch.map((id) => {
      const { status, reasonKey } = archiveAnswerOutcome(answers.get(id) ?? 'missing');
      return status === 'ok'
        ? ok(id)
        : { id, status: MediaOperationItemStatus.Skipped, ...(reasonKey && { reasonKey }) };
    });
  }

  private async applyDuplicateBatch(
    auth: AuthDto,
    snapshot: BulkOperationSnapshot,
    batch: string[],
    operationId?: string,
  ): Promise<Outcome[]> {
    if (!operationId) {
      return batch.map((id) => refused(id, new Error('A duplicate decision needs the job it belongs to')));
    }

    const inBatch = new Set(batch);
    const locked = snapshot.elevated ? new Set<string>() : await this.duplicateDecisions.getLockedIds(batch);
    const undo = snapshot.action === MediaOperationBulkAction.UndoDuplicates;
    const outcomes: Outcome[] = [];

    for (const group of parseDuplicateGroups(snapshot.payload.duplicateGroups)) {
      const ids = group.memberIds.filter((id) => inBatch.has(id));
      if (ids.length === 0) {
        continue;
      }

      if (ids.some((id) => locked.has(id))) {
        outcomes.push(
          ...ids.map((id) => ({
            id,
            status: MediaOperationItemStatus.Skipped,
            reasonKey: 'frameleaf_bulk_reason_locked',
          })),
        );
        continue;
      }

      try {
        const answers = undo
          ? await this.duplicateDecisions.undoGroup(auth, operationId, group)
          : await this.duplicateDecisions.applyGroup(auth, operationId, group);
        const byId = new Map(answers.map((answer) => [answer.id, answer]));
        outcomes.push(...ids.map((id) => byId.get(id) ?? refused(id, new Error('The group did not answer'))));
      } catch (error) {
        outcomes.push(...ids.map((id) => refused(id, error)));
      }
    }

    return outcomes;
  }

  /**
   * Send ids to a list endpoint. A batch rejected as a whole is retried one item at a time, so the
   * report names the items that were actually refused. Every endpoint used this way is idempotent,
   * which is what makes that second pass safe.
   */
  private async inLists(ids: string[], send: (ids: string[]) => Promise<unknown>): Promise<Outcome[]> {
    try {
      await send(ids);
      return ids.map((id) => ok(id));
    } catch (error) {
      if (ids.length === 1) {
        return [refused(ids[0], error)];
      }
    }

    const outcomes: Outcome[] = [];
    for (const id of ids) {
      try {
        await send([id]);
        outcomes.push(ok(id));
      } catch (error) {
        outcomes.push(refused(id, error));
      }
    }
    return outcomes;
  }

  /**
   * A relative date shift, from each item's recorded starting date.
   *
   * Idempotent by construction: every item is set to `from + minutes`, so sending the same item
   * twice — a replayed batch, the per-item second pass of `inLists`, the automatic retry — leaves it
   * where one send would. An item with no recorded start is refused rather than shifted from
   * whatever its date is now, which might already be shifted. One with no capture date has nothing
   * to shift, as with the relative update.
   */
  private async shiftDates(
    auth: AuthDto,
    ids: string[],
    minutes: number,
    shiftFrom: BulkOperationResult['shiftFrom'],
  ): Promise<Outcome[]> {
    const outcomes: Outcome[] = [];
    const starts = new Map<string, Date>();

    for (const id of ids) {
      if (!(id in shiftFrom)) {
        outcomes.push({
          id,
          status: MediaOperationItemStatus.Failed,
          reasonKey: 'frameleaf_bulk_reason_failed',
          message: 'The starting date was not recorded, so the item was not shifted',
        });
        continue;
      }

      const from = shiftFrom[id];
      if (from === null) {
        outcomes.push(ok(id));
        continue;
      }

      starts.set(id, new Date(from));
    }

    if (starts.size > 0) {
      outcomes.push(
        ...(await this.inLists(starts.keys().toArray(), (chunk) =>
          this.assets.shiftDateTimeOriginalFrom(
            auth,
            chunk.map((id) => ({ id, from: starts.get(id) as Date })),
            minutes,
          ),
        )),
      );
    }

    return outcomes;
  }

  /**
   * Relink one still + video pair at a time (FL-70). `LivePhotoService.relinkOne` re-validates
   * ownership, type and current link state itself, the same as the direct `POST /live-photo/relink`
   * endpoint, so a pair that changed between candidate review and this batch (already linked,
   * deleted, or claimed by another pair earlier in the same job) is refused here rather than
   * silently reapplied. A refusal is business rule, not a transient error, so it is reported
   * skipped: the automatic retry pass would only reach the same answer.
   */
  private async relinkLivePhotos(
    auth: AuthDto,
    photoIds: readonly string[],
    videoIdByPhotoId: ReadonlyMap<string, string>,
  ): Promise<Outcome[]> {
    const outcomes: Outcome[] = [];
    for (const photoId of photoIds) {
      const videoId = videoIdByPhotoId.get(photoId);
      if (!videoId) {
        outcomes.push({
          id: photoId,
          status: MediaOperationItemStatus.Skipped,
          reasonKey: 'frameleaf_bulk_reason_not_found',
        });
        continue;
      }
      try {
        const result = await this.livePhoto.relinkOne(auth, photoId, videoId);
        outcomes.push(
          result.success
            ? ok(photoId)
            : {
                id: photoId,
                status: MediaOperationItemStatus.Skipped,
                reasonKey: 'frameleaf_bulk_reason_live_photo_relink_rejected',
                message: result.error,
              },
        );
      } catch (error) {
        outcomes.push(refused(photoId, error));
      }
    }
    return outcomes;
  }

  /**
   * Remove every tag in the payload from each item. An item counts as changed when any of its tags
   * came off; one that carried none of them had nothing to do and is reported as such.
   */
  private async untag(auth: AuthDto, ids: string[], tagIds: string[]): Promise<Outcome[]> {
    const answers = new Map<string, Outcome[]>(ids.map((id) => [id, []]));
    for (const tagId of tagIds) {
      const responses = await this.tags.removeAssets(auth, tagId, { ids });
      for (const response of responses) {
        answers.get(response.id)?.push(fromBulkIdResponse(response));
      }
    }

    return ids.map((id) => {
      const outcomes = answers.get(id) ?? [];
      return (
        outcomes.find((outcome) => outcome.status === MediaOperationItemStatus.Ok) ??
        outcomes.find((outcome) => outcome.status === MediaOperationItemStatus.Failed) ??
        outcomes[0] ?? {
          id,
          status: MediaOperationItemStatus.Skipped,
          reasonKey: 'frameleaf_bulk_reason_not_found',
        }
      );
    });
  }
}
