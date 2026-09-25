import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import { MediaOperationDto } from 'src/dtos/media-operation.dto.js';
import {
  PhysicalDeduplicationApplyDto,
  PhysicalDeduplicationApplyRequestDto,
  PhysicalDeduplicationPreviewResponseDto,
  PhysicalDeduplicationRestoreRequestDto,
  PhysicalDeduplicationReviewRequestDto,
  PhysicalDeduplicationReviewResponseDto,
  PhysicalDeduplicationVerificationDto,
} from 'src/dtos/physical-deduplication.dto.js';
import {
  DatabaseLock,
  ImmichWorker,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationRepository,
  type MediaOperationWriteState,
} from 'src/repositories/media-operation.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { mapOperation } from 'src/services/media-operation.service.js';
import {
  PhysicalDeduplicationItemResult,
  PhysicalDeduplicationService,
  PhysicalDeduplicationVerified,
} from 'src/services/physical-deduplication.service.js';
import { MEDIA_OPERATION_AUTO_RETRY_DELAY_MS } from 'src/utils/media-operation.js';
import {
  PhysicalDeduplicationApplyResult,
  PhysicalDeduplicationApplySnapshot,
  PhysicalDeduplicationPlanItem,
  emptyPhysicalDeduplicationResult,
  mergePhysicalDeduplicationItem,
  parsePhysicalDeduplicationResult,
  parsePhysicalDeduplicationSnapshot,
  physicalDeduplicationProgress,
  planPhysicalDeduplicationRetry,
} from 'src/utils/physical-deduplication-plan.js';

/** How often the worker looks for queued plans. */
export const PHYSICAL_DEDUPLICATION_TICK_MS = 5000;
/**
 * The claim lease. One copy hashes its retained original and itself, which for a long video can
 * take minutes, so the lease is renewed on a timer while a copy is in hand as well as after it.
 */
export const PHYSICAL_DEDUPLICATION_LEASE_MS = 10 * 60_000;
/** Applied plans the page lists. */
export const PHYSICAL_DEDUPLICATION_APPLIES_SHOWN = 10;

const KIND = MediaOperationKind.PhysicalDeduplication;

/** Jobs no worker changes files for any more: the ones a verification can trust to hold still. */
const FINISHED: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Completed,
  MediaOperationStatus.Cancelled,
  MediaOperationStatus.Failed,
]);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const asIso = (value: Date | string | null | undefined): string | null =>
  value ? (value instanceof Date ? value : new Date(value)).toISOString() : null;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asCount = (value: unknown) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

/**
 * Reviewed physical deduplication plans (FL-73, `IMP-005`): review, apply, and the worker that
 * applies them.
 *
 * - **Review** checks the plan on screen against the library again (`PhysicalDeduplicationService
 *   .preparePlan`) and binds the administrator's per-group decisions to it with a review token.
 * - **Apply** repeats every check, requires the review token and the typed `APPLY <plan>` phrase,
 *   and queues a `media_operation` of kind `physical_deduplication` whose snapshot freezes exactly
 *   the reviewed copies with their evidence. Anything that changed is refused with 409; a repeated
 *   submit of the plan being applied answers with that job.
 * - **The worker** claims those jobs on the microservices worker and applies one copy at a time,
 *   writing each copy's outcome to the row, so the job shows in Activity and the notifications
 *   panel, survives a restart or a lost worker, pauses and cancels between copies, and resumes from
 *   its cursor. Copies that fail get one automatic retry pass; the job itself gets the one automatic
 *   retry every media operation has. A copy an earlier attempt reached is never applied twice.
 *   Locked media is processed like any other: backend work reaches it, and nothing here names it.
 */
@Injectable()
export class PhysicalDeduplicationPlanService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private readonly workerId = `physical-deduplication-${randomUUID()}`;

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private users: UserRepository,
    private deduplication: PhysicalDeduplicationService,
  ) {
    this.logger.setContext(PhysicalDeduplicationPlanService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Page                                                                */
  /* ------------------------------------------------------------------ */

  /** The preview, with the plans being applied and applied recently, for every administrator. */
  async getPreview(auth: AuthDto): Promise<PhysicalDeduplicationPreviewResponseDto> {
    const [preview, rows, active] = await Promise.all([
      this.deduplication.getPreview(auth),
      this.operations.listRecentOfKind(KIND, PHYSICAL_DEDUPLICATION_APPLIES_SHOWN),
      this.operations.getActiveOfKind(KIND),
    ]);
    const users = rows.length > 0 ? await this.users.getList({ withDeleted: true }) : [];
    const nameOf = (id: string) => users.find((user) => user.id === id)?.name ?? '';

    return {
      ...preview,
      applying: !!active,
      applies: rows.map((row) => this.mapApply(row, auth, nameOf)),
    };
  }

  /**
   * Mark the plan on screen reviewed: every check applying would make, and the token that binds
   * these per-group decisions to this plan. Nothing is written.
   */
  async review(
    auth: AuthDto,
    dto: PhysicalDeduplicationReviewRequestDto,
  ): Promise<PhysicalDeduplicationReviewResponseDto> {
    const plan = await this.deduplication.preparePlan(auth, dto);
    return {
      planId: plan.planId,
      fingerprint: plan.fingerprint,
      reviewToken: plan.reviewToken,
      confirmation: plan.confirmation,
      excludedRetainedAssetIds: plan.excludedRetainedAssetIds,
      copies: plan.items.length,
      retainedOriginals: plan.retained.length,
      estimatedBytes: plan.estimatedBytes,
      hiddenCopies: plan.hiddenCopies,
      reviewedAt: new Date().toISOString(),
    };
  }

  /**
   * Apply exactly the reviewed plan, or refuse.
   *
   * 409 when another plan is being applied, when the plan on screen was replaced or already applied,
   * when any evidence of a copy it shares changed, when the saved retained account changed, or when
   * the decisions differ from the ones reviewed. 400 when the feature is off, no retained account is
   * saved, or the typed confirmation is not the plan's.
   */
  async apply(auth: AuthDto, dto: PhysicalDeduplicationApplyRequestDto): Promise<MediaOperationDto> {
    // Checked first so a repeated submit is answered without checking the whole plan again; the
    // insert below checks once more under a lock, which is what actually decides a race.
    const active = await this.operations.getActiveOfKind(KIND);
    if (active) {
      return this.answerActive(auth, dto, active);
    }

    const plan = await this.deduplication.preparePlan(auth, dto);
    await this.deduplication.requireApplyAllowed(plan);

    if (dto.reviewToken !== plan.reviewToken) {
      throw new ConflictException('This review is no longer valid, or the decisions changed. Review the plan again.');
    }
    if (dto.confirmation.trim() !== plan.confirmation) {
      throw new BadRequestException(`Type ${plan.confirmation} to apply this plan.`);
    }

    const snapshot: PhysicalDeduplicationApplySnapshot = {
      version: 1,
      planId: plan.planId,
      fingerprint: plan.fingerprint,
      reviewToken: plan.reviewToken,
      ranAt: plan.ranAt,
      masterUserId: plan.masterUserId,
      scopeUserId: plan.scopeUserId,
      excludedRetainedAssetIds: plan.excludedRetainedAssetIds,
      items: plan.items,
      retained: plan.retained,
      estimatedBytes: plan.estimatedBytes,
    };

    const outcome = await this.operations.createExclusive(
      {
        ownerId: auth.user.id,
        kind: KIND,
        // Applied by this server's own workers; files never leave it.
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        // The plan's name, which reads the same in every language; Activity titles the job itself.
        label: plan.planId,
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: null,
        revisionId: null,
        snapshot: snapshot as unknown as Record<string, unknown>,
        settings: { planId: plan.planId, copies: plan.items.length },
        estimate: null,
        result: emptyPhysicalDeduplicationResult() as unknown as Record<string, unknown>,
        totalUnits: String(plan.items.length),
      },
      DatabaseLock.PhysicalDeduplicationApply,
    );
    if ('active' in outcome) {
      return this.answerActive(auth, dto, outcome.active);
    }

    const { created } = outcome;
    this.logger.log(`Physical deduplication plan ${plan.planId} queued as ${created.id} (${plan.items.length} copies)`);
    return mapOperation(created);
  }

  /**
   * Verify an applied plan (FL-73): hash every retained original its copies share again and check
   * that every copy it changed still resolves to one. Any administrator may verify any applied plan;
   * the rows answer with their visibility rules. A job still running is refused (409), since its
   * copies are changing underneath the check.
   */
  async verify(auth: AuthDto, id: string): Promise<PhysicalDeduplicationVerificationDto> {
    const { snapshot, appliedIds } = await this.finishedApply(id);
    const report = await this.deduplication.verifyAppliedCopies(auth, snapshot, appliedIds);
    return { operationId: id, planId: snapshot.planId, verifiedAt: new Date().toISOString(), ...report };
  }

  /**
   * Put one copy of an applied plan back on its own file, where that file is still on disk, and
   * answer with the plan verified again. A copy whose own file was removed cannot be restored.
   */
  async restore(
    auth: AuthDto,
    id: string,
    dto: PhysicalDeduplicationRestoreRequestDto,
  ): Promise<PhysicalDeduplicationVerificationDto> {
    const { snapshot, appliedIds } = await this.finishedApply(id);
    await this.deduplication.restoreAppliedCopy(auth, snapshot, appliedIds, dto.assetId);
    return this.verify(auth, id);
  }

  /** A finished apply job with the copies it changed. */
  private async finishedApply(id: string) {
    const operation = await this.operations.getOfKind(id, KIND);
    if (!operation) {
      throw new NotFoundException('Applied plan not found');
    }
    if (!FINISHED.has(operation.status as MediaOperationStatus)) {
      throw new ConflictException('Wait for this plan to finish before verifying it.');
    }
    const snapshot = parsePhysicalDeduplicationSnapshot(operation.snapshot);
    const appliedIds = parsePhysicalDeduplicationResult(operation.result)
      .items.filter((item) => item.state === 'applied' || item.state === 'already-applied')
      .map((item) => item.id);
    return { snapshot, appliedIds };
  }

  /**
   * A plan is already being applied. The same administrator submitting the same plan again gets the
   * job already running; anything else is a conflict.
   */
  private async answerActive(
    auth: AuthDto,
    dto: PhysicalDeduplicationApplyRequestDto,
    active: { id: string; fingerprint: string | null },
  ): Promise<MediaOperationDto> {
    const own =
      active.fingerprint === dto.fingerprint ? await this.operations.getForOwner(active.id, auth.user.id) : undefined;
    if (own) {
      return mapOperation(own);
    }
    throw new ConflictException('Another plan is being applied. Wait for it to finish.');
  }

  /** One applied plan as every administrator's page shows it: counts and names, never the copies. */
  private mapApply(row: MediaOperation, auth: AuthDto, nameOf: (id: string) => string): PhysicalDeduplicationApplyDto {
    const snapshot = asRecord(row.snapshot);
    const summary = asRecord(asRecord(row.result).summary);
    const status = row.status as MediaOperationStatus;
    return {
      operationId: row.id,
      planId: typeof snapshot.planId === 'string' ? snapshot.planId : '',
      fingerprint: typeof snapshot.fingerprint === 'string' ? snapshot.fingerprint : '',
      status,
      requestedById: row.ownerId,
      requestedByName: nameOf(row.ownerId),
      mine: row.ownerId === auth.user.id,
      retrying: status === MediaOperationStatus.Queued && ((row.autoRetries ?? 0) > 0 || !!row.retryAt),
      pauseRequested: !!row.pauseRequestedAt,
      total: asCount(row.totalUnits),
      processed: asCount(row.processedUnits),
      progress: Number(row.progress ?? 0),
      applied: asCount(summary.applied),
      alreadyApplied: asCount(summary.alreadyApplied),
      skipped: asCount(summary.skipped),
      failed: asCount(summary.failed),
      estimatedBytes: asCount(snapshot.estimatedBytes),
      reclaimedBytes: asCount(summary.reclaimedBytes),
      error: row.error ?? null,
      createdAt: asIso(row.createdAt)!,
      finishedAt: asIso(row.finishedAt),
    };
  }

  /* ------------------------------------------------------------------ */
  /* The worker                                                          */
  /* ------------------------------------------------------------------ */

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => this.tick(), PHYSICAL_DEDUPLICATION_TICK_MS);
    this.tick();
  }

  /** Stop taking work and let the copy in hand land; the lease hands the job to the next worker. */
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
      .catch((error) => this.logger.warn(`Physical deduplication worker failed: ${errorMessage(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  /** Lapsed claims are recovered by `MediaOperationSweepService`, for every kind, not here. */
  async drain(): Promise<void> {
    while (!this.stopping) {
      const claim = await this.operations.claimNext({
        kinds: [KIND],
        workerId: this.workerId,
        leaseMs: PHYSICAL_DEDUPLICATION_LEASE_MS,
      });
      if (!claim) {
        return;
      }

      await this.run(claim.operation, claim.claimToken);
    }
  }

  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    let snapshot: PhysicalDeduplicationApplySnapshot;
    try {
      snapshot = parsePhysicalDeduplicationSnapshot(operation.snapshot);
    } catch (error) {
      await this.operations.fail(operation.id, claimToken, {
        error: errorMessage(error),
        errorCode: 'physical_deduplication_snapshot_invalid',
      });
      return;
    }

    const keepAlive = setInterval(() => {
      this.operations.heartbeat(operation.id, claimToken, PHYSICAL_DEDUPLICATION_LEASE_MS).catch(() => false);
    }, PHYSICAL_DEDUPLICATION_LEASE_MS / 4);

    try {
      await this.process(operation, claimToken, snapshot);
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(`Physical deduplication job ${operation.id} failed: ${message}`);
      await this.operations.fail(operation.id, claimToken, {
        error: message,
        errorCode: 'physical_deduplication_failed',
      });
    } finally {
      clearInterval(keepAlive);
    }
  }

  /**
   * The frozen copies from the cursor, one at a time, then the one retry pass over the copies that
   * failed. A claim can find the job anywhere on that path and carries on from what the row says;
   * the copy a previous worker had in hand is applied again, which its checks make harmless.
   */
  private async process(
    operation: MediaOperation,
    claimToken: string,
    snapshot: PhysicalDeduplicationApplySnapshot,
  ): Promise<void> {
    const { id } = operation;
    const total = snapshot.items.length;

    // Checked on every claim, not only at submit: the handoff phase or the administrator may change.
    if (!(await this.deduplication.canApplyPlans())) {
      throw new Error('Physical deduplication is unavailable while the storage handoff is not active');
    }
    const owner = await this.users.get(operation.ownerId, { withDeleted: false });
    if (!owner?.isAdmin) {
      throw new Error('The administrator who applied this plan no longer has administrator access');
    }
    // The feature must still be on, and the saved retained account still the one the plan retains
    // originals in, on every claim: a resumed or retried job never outlives a settings change.
    await this.deduplication.requireApplyAllowed({ masterUserId: snapshot.masterUserId });

    let result: PhysicalDeduplicationApplyResult = {
      ...parsePhysicalDeduplicationResult(operation.result),
      inFlight: null,
    };
    let processed = Math.min(Math.max(0, Number(operation.processedUnits ?? 0)), total);

    const running = await this.operations.reportProgress(id, claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: processed,
      totalUnits: total,
      progress: physicalDeduplicationProgress(processed, total),
    });
    if (!running) {
      // Cancelled between the claim and this write, or the claim is gone.
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      return;
    }

    const verified: PhysicalDeduplicationVerified = new Map();
    // The stored plan is marked applied once this run changes a file, so the page reports it as
    // applied (or partly applied) rather than as a preview whose evidence merely changed.
    let marked = false;
    const markApplied = async () => {
      if (marked) {
        return;
      }
      if (result.summary.applied + result.summary.alreadyApplied === 0) {
        return;
      }
      marked = true;
      await this.recordApplied(snapshot, result);
    };

    while (processed < total) {
      if (this.stopping) {
        return;
      }
      const item = snapshot.items[processed];
      const marked = { ...result, inFlight: item.assetId };
      if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, marked, processed, total)))) {
        return;
      }

      const outcome = await this.applyOne(snapshot, item, verified);
      result = { ...mergePhysicalDeduplicationItem(result, outcome), inFlight: null };
      processed++;
      await markApplied();

      if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, result, processed, total)))) {
        return;
      }
    }

    // Every copy that failed gets one more attempt before it is reported (owner decision, September
    // 22, 2026), after a pause rather than straight into whatever just went wrong.
    const planned = planPhysicalDeduplicationRetry(result);
    if (planned) {
      if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, planned, processed, total)))) {
        return;
      }
      // Handing the job back for its retry pass is not a failed attempt, so the attempt is returned.
      const requeued = await this.operations.requeue(id, claimToken, {
        delayMs: MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
        returnAttempt: true,
      });
      if (requeued) {
        this.logger.log(`Physical deduplication job ${id}: retrying ${planned.retry?.ids.length ?? 0} copies once`);
        return;
      }
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      return;
    }

    while (result.retry && result.retry.processed < result.retry.ids.length) {
      if (this.stopping) {
        return;
      }
      const pass = result.retry;
      const item = snapshot.items.find((entry) => entry.assetId === pass.ids[pass.processed]);
      if (item) {
        const marked = { ...result, inFlight: item.assetId };
        if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, marked, processed, total)))) {
          return;
        }
        result = mergePhysicalDeduplicationItem(result, await this.applyOne(snapshot, item, verified));
        await markApplied();
      }
      result = { ...result, inFlight: null, retry: { ...pass, processed: pass.processed + 1 } };

      if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, result, processed, total)))) {
        return;
      }
    }

    if (await this.operations.beginValidation(id, claimToken)) {
      if (result.summary.applied + result.summary.alreadyApplied > 0) {
        await this.recordApplied(snapshot, result);
      }
      if (!(await this.operations.complete(id, claimToken, { resultAssetId: null }))) {
        // Cancelled after the last copy (FL-43): what was applied is recorded above; settle the cancel.
        await this.operations.acknowledgeCancel(id, claimToken, { released: false });
        return;
      }
      const { applied, alreadyApplied, skipped, failed, reclaimedBytes } = result.summary;
      this.logger.log(
        `Physical deduplication plan ${snapshot.planId} finished: ${applied} applied, ${alreadyApplied} already, ` +
          `${skipped} skipped, ${failed} failed, ${reclaimedBytes} bytes reclaimed`,
      );
      return;
    }

    await this.operations.acknowledgeCancel(id, claimToken, { released: false });
  }

  private recordApplied(snapshot: PhysicalDeduplicationApplySnapshot, result: PhysicalDeduplicationApplyResult) {
    return this.deduplication.recordPlanApplied(snapshot.fingerprint, {
      linkedAssets: result.summary.applied + result.summary.alreadyApplied,
      deletedBytes: result.summary.reclaimedBytes,
    });
  }

  /** One copy, answered whatever happens: an unexpected error fails the copy, not the job. */
  private async applyOne(
    snapshot: PhysicalDeduplicationApplySnapshot,
    item: PhysicalDeduplicationPlanItem,
    verified: PhysicalDeduplicationVerified,
  ) {
    let outcome: PhysicalDeduplicationItemResult;
    try {
      outcome = await this.deduplication.applyPlanItem(snapshot, item, verified);
    } catch (error) {
      this.logger.warn(`Physical deduplication: copy ${item.assetId} failed: ${errorMessage(error)}`);
      outcome = { state: 'failed', reasonKey: 'error', message: errorMessage(error), reclaimedBytes: 0 };
    }
    return { ...outcome, id: item.assetId, at: new Date().toISOString() };
  }

  private write(
    id: string,
    claimToken: string,
    result: PhysicalDeduplicationApplyResult,
    processed: number,
    total: number,
  ) {
    return this.operations.setBulkResult(id, claimToken, {
      result: result as unknown as Record<string, unknown>,
      processedUnits: processed,
      totalUnits: total,
      progress: physicalDeduplicationProgress(processed, total),
      leaseMs: PHYSICAL_DEDUPLICATION_LEASE_MS,
    });
  }

  /**
   * Whether to carry on after a write: not when the claim is gone, not when the administrator asked
   * to cancel (acknowledged here), and not when they asked to pause (the claim is handed back at
   * this copy boundary; resuming carries on from the cursor).
   */
  private async proceed(
    id: string,
    claimToken: string,
    written: MediaOperationWriteState | undefined,
  ): Promise<boolean> {
    if (!written) {
      this.logger.warn(`Physical deduplication job ${id}: claim lost, stopping`);
      return false;
    }
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      this.logger.log(`Physical deduplication job ${id} cancelled`);
      return false;
    }
    if (written.pauseRequestedAt && (await this.operations.settlePause(id, claimToken))) {
      this.logger.log(`Physical deduplication job ${id} paused`);
      return false;
    }
    return true;
  }
}
