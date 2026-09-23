import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import { AssetBulkUpdateDto, AssetImageEnrichmentAction } from 'src/dtos/asset.dto.js';
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
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { ImageEnrichmentService } from 'src/services/image-enrichment.service.js';
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
  bulkErrorMessage,
  bulkProgress,
  classifyBulkError,
  fromBulkIdResponse,
  isReplaySafe,
  mergeBulkOutcomes,
  parseBulkResult,
  parseBulkSnapshot,
} from 'src/utils/bulk-operation.js';

/** How often the worker looks for queued bulk jobs. */
export const BULK_TICK_MS = 5000;
/** The claim lease. Extended after every batch; a worker that stops writing loses the job. */
export const BULK_LEASE_MS = 2 * 60_000;
/** How often expired claims are returned to the queue. */
export const BULK_RECOVERY_MS = 60_000;
/** Parallel calls for the actions the server only accepts one item at a time. */
export const BULK_ITEM_CONCURRENCY = 5;

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
 *   session (see `MediaOperationService.createBulk`).
 * - **Sensitive marking is metadata.** It goes through the enrichment review action, which writes
 *   the manual mark and its tags; no visibility change, no album write, no move to Locked.
 * - **Cancel is honoured between batches** and the items already changed are reported, not hidden.
 * - **A worker that dies** leaves an in-flight marker; the next claim replays that batch when the
 *   action is safe to repeat, and reports it instead when it is not.
 *
 * Deliberately not a queue job: the row is already the durable queue, and claiming it with a lease
 * is what makes a second worker, a restart or a stale process safe.
 */
@Injectable()
export class BulkOperationService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private lastRecoveryAt = 0;
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

  /** Recover lapsed claims, then work through the queue until it is empty or we are stopping. */
  async drain(): Promise<void> {
    await this.recover();

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

  private async recover() {
    const now = Date.now();
    if (now - this.lastRecoveryAt < BULK_RECOVERY_MS) {
      return;
    }
    this.lastRecoveryAt = now;

    const recovered = await this.operations.recoverExpiredClaims({
      kinds: [MediaOperationKind.Bulk],
      errorCode: 'bulk_worker_lost',
      error: 'The server stopped repeatedly while this job was running',
    });
    const { requeued, retried, failed, abandonedCancels } = recovered;
    if (requeued + retried + failed + abandonedCancels > 0) {
      this.logger.log(
        `Recovered bulk operations: ${requeued} requeued, ${retried} retrying, ${failed} failed, ${abandonedCancels} cancelled`,
      );
    }
  }

  /** Apply one claimed operation from its cursor to the end, a batch at a time. */
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
    let result = parseBulkResult(operation.result, total);
    let processed = Math.min(Math.max(0, Number(operation.processedUnits ?? 0)), total);

    // The previous worker died with a batch in hand. Replay it where that is harmless; otherwise
    // say plainly that those items may or may not have been changed, and do not touch them again.
    if (result.inFlight) {
      const { start, size } = result.inFlight;
      result = { ...result, inFlight: null };
      if (start === processed && !isReplaySafe(snapshot)) {
        const interrupted = snapshot.assetIds.slice(start, start + size).map((assetId) => ({
          id: assetId,
          status: MediaOperationItemStatus.Skipped,
          reasonKey: 'frameleaf_bulk_reason_interrupted',
          message: 'The server stopped while this item was being changed; check it before changing it again.',
        }));
        result = mergeBulkOutcomes(result, interrupted);
        processed += interrupted.length;
      }
    }

    const started = await this.write(id, claimToken, result, processed, total);
    if (!(await this.proceed(id, started))) {
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
      await this.operations.acknowledgeCancel(id, { released: false });
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

    // A stack is one call over every member, and unstacking works on stack ids: neither is batched.
    const width =
      snapshot.action === MediaOperationBulkAction.Stack || snapshot.action === MediaOperationBulkAction.Unstack
        ? total
        : BULK_BATCH_SIZE;

    while (processed < total) {
      if (this.stopping) {
        // Keep the claim; the lease expiring hands the job to the next worker at this cursor.
        return;
      }

      const batch = snapshot.assetIds.slice(processed, processed + width);

      const marked = await this.write(
        id,
        claimToken,
        { ...result, inFlight: { start: processed, size: batch.length } },
        processed,
        total,
      );
      if (!(await this.proceed(id, marked))) {
        return;
      }

      let outcomes: Outcome[];
      try {
        await this.requireCredentials(operation.ownerId, snapshot);
        outcomes = inBatchOrder(batch, await this.applyBatch(auth, snapshot, batch));
      } catch (error) {
        if (error instanceof BulkJobError) {
          // Nothing in this batch was applied. Leave it unreached, so a retry covers it.
          await this.write(id, claimToken, result, processed, total);
          await this.operations.fail(id, claimToken, { error: error.message, errorCode: error.code });
          return;
        }
        throw error;
      }

      result = mergeBulkOutcomes({ ...result, inFlight: null }, outcomes);
      processed += batch.length;

      const written = await this.write(id, claimToken, result, processed, total);
      if (!(await this.proceed(id, written))) {
        return;
      }
    }

    if (await this.operations.beginValidation(id, claimToken)) {
      await this.operations.complete(id, claimToken, { resultAssetId: null });
      this.logger.log(
        `Bulk operation ${id} finished: ${result.succeeded} changed, ${result.skipped} skipped, ${result.failed} failed`,
      );
      return;
    }

    await this.operations.acknowledgeCancel(id, { released: false });
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
   */
  private async proceed(
    id: string,
    written: { status: MediaOperationStatus; cancelRequestedAt: Date | null } | undefined,
  ): Promise<boolean> {
    if (!written) {
      this.logger.warn(`Bulk operation ${id}: claim lost, stopping`);
      return false;
    }

    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.operations.acknowledgeCancel(id, { released: false });
      this.logger.log(`Bulk operation ${id} cancelled by its owner`);
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
   */
  async applyBatch(auth: AuthDto, snapshot: BulkOperationSnapshot, batch: string[]): Promise<Outcome[]> {
    await this.requireTarget(auth, snapshot);

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

    if (allowed.length === 0) {
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

      case MediaOperationBulkAction.MarkSensitive:
      case MediaOperationBulkAction.UnmarkSensitive: {
        // Metadata only: the manual review mark and its tags. Album membership, visibility and the
        // Locked folder are not touched.
        const enrichment =
          action === MediaOperationBulkAction.MarkSensitive
            ? AssetImageEnrichmentAction.MarkNsfw
            : AssetImageEnrichmentAction.MarkSafe;
        outcomes.push(
          ...(await this.oneAtATime(allowed, async (id) => {
            await this.enrichment.updateAssetEnrichment(auth, id, { action: enrichment });
          })),
        );
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

      default: {
        // Every action is handled above; an unknown one is refused rather than guessed at.
        outcomes.push(...allowed.map((id) => refused(id, new Error(`Unsupported bulk action: ${String(action)}`))));
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

  /** The endpoints that take one asset per call, with bounded concurrency. */
  private async oneAtATime(ids: string[], send: (id: string) => Promise<void>): Promise<Outcome[]> {
    const outcomes: Outcome[] = [];
    let cursor = 0;
    const lane = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          await send(id);
          outcomes.push(ok(id));
        } catch (error) {
          outcomes.push(refused(id, error));
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(BULK_ITEM_CONCURRENCY, ids.length) }, () => lane()));
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
