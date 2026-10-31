import { ConflictException, Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { AlbumUserRole, MediaOperationKind, MediaOperationStatus, StudioPreviewStatus } from 'src/enum.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { holdSourceAdmission } from 'src/repositories/studio-source-admission.js';
import { DB } from 'src/schema/index.js';
import { StudioPreviewFrameTable } from 'src/schema/tables/studio-preview.table.js';
import {
  PREVIEW_CANCEL_CLEANED,
  PREVIEW_CANCEL_NO_OPERATION,
  PREVIEW_CANCEL_PENDING,
  PREVIEW_CANCEL_UNAVAILABLE,
  PREVIEW_CANCEL_UNCLAIMED,
  PREVIEW_CONSUMER_PREFIX,
  isConsumerPreview,
} from 'src/utils/studio-preview.js';

export type StudioPreviewFrame = Selectable<StudioPreviewFrameTable>;
export type StudioPreviewRetirement = {
  frame: StudioPreviewFrame;
  changedOperation?: MediaOperation;
  cancellationState: 'not-needed' | 'requested' | 'acknowledged' | 'unavailable';
  rendererReleased: true | null;
  cleanupAllowed: boolean;
};
export type StudioPreviewFrameCreate = Omit<
  Insertable<StudioPreviewFrameTable>,
  'id' | 'createdAt' | 'updatedAt' | 'updateId' | 'requestedAt' | 'lastAccessedAt' | 'status'
>;
/**
 * The revision-bound preview store (FL-96, `STU-402`).
 *
 * Two rules shape every query here:
 *
 * 1. **Owner scoping is in the WHERE clause, never a filter afterwards.** A frame belonging to
 *    somebody else and a frame that does not exist give the same answer, which is the only
 *    honest thing to say about another account's media.
 * 2. **Publication is conditional.** A worker writes a frame only into a row that is still in a
 *    state that can accept one and still on the revision it was rendered for. The guard is in
 *    Postgres, so a worker that was slow, or whose revision was superseded while it rendered,
 *    updates zero rows and is told so, rather than overwriting a current frame with an old one.
 */
@Injectable()
export class StudioPreviewRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
    private privacy: DerivativePrivacyRepository,
  ) {}
  /**
   * Record a request, or return the existing row for the same key.
   *
   * `created` is true only for the caller whose write produced a row that still needs a render:
   * a fresh insert, or a revival of a row that had been superseded, evicted or had failed. The
   * service creates the durable operation only when it is true, so two concurrent requests for
   * the same frame share one render instead of racing to start two.
   *
   * Revival matters because the key is deterministic. Without it, a frame that was evicted for
   * the cap, or a revision the person returned to by undoing, would keep answering "gone" or
   * "superseded" for as long as the tombstone lived, and could never be rendered again.
   *
   * Every read is scoped to the owner as well as the key. The key already contains the owner;
   * the second condition is so that a mistake in the key could never hand one account's row to
   * another.
   */
  async upsert(
    frame: StudioPreviewFrameCreate,
    admission?: Record<string, unknown>,
  ): Promise<{ frame: StudioPreviewFrame; created: boolean }> {
    return this.db.transaction().execute(async (tx) => {
      if (admission) await holdSourceAdmission(tx, admission, frame.ownerId);
      const result = await this.upsertWithin(tx, frame);
      if (admission) await holdSourceAdmission(tx, admission, frame.ownerId);
      return result;
    });
  }
  private async upsertWithin(
    db: Kysely<DB>,
    frame: StudioPreviewFrameCreate,
  ): Promise<{
    frame: StudioPreviewFrame;
    created: boolean;
  }> {
    if (isConsumerPreview(frame.cacheKey)) {
      {
        const tx = db;
        const inserted = await tx
          .insertInto('studio_preview_frame')
          .values(frame)
          .onConflict((builder) => builder.column('cacheKey').doNothing())
          .returningAll()
          .executeTakeFirst();
        if (inserted) {
          return { frame: inserted as unknown as StudioPreviewFrame, created: true };
        }
        // A retry cannot renew the original grant, switch operation or revive a terminal admission.
        const existing = await tx
          .selectFrom('studio_preview_frame')
          .selectAll()
          .where('cacheKey', '=', frame.cacheKey)
          .where('ownerId', '=', frame.ownerId)
          .executeTakeFirst();
        if (!existing) {
          throw new ConflictException('Preview admission changed; retry the request');
        }
        return { frame: existing as unknown as StudioPreviewFrame, created: false };
      }
    }
    const inserted = await db
      .insertInto('studio_preview_frame')
      .values(frame)
      .onConflict((builder) => builder.column('cacheKey').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) {
      return { frame: inserted as unknown as StudioPreviewFrame, created: true };
    }
    const revived = await db
      .updateTable('studio_preview_frame')
      .set({
        status: StudioPreviewStatus.Pending,
        projectRevision: frame.projectRevision ?? null,
        grantToken: frame.grantToken ?? null,
        grantSessionId: frame.grantSessionId ?? null,
        seekGeneration: frame.seekGeneration,
        operationId: null,
        framePath: null,
        contentType: null,
        sizeInBytes: null,
        frameChecksum: null,
        framePts: null,
        framePtsTimebase: null,
        toneMapped: false,
        errorCode: null,
        readyAt: null,
        requestedAt: new Date(),
        lastAccessedAt: new Date(),
        expiresAt: frame.expiresAt ?? null,
      })
      .where('cacheKey', '=', frame.cacheKey)
      .where('ownerId', '=', frame.ownerId)
      .where('status', 'in', [StudioPreviewStatus.Superseded, StudioPreviewStatus.Evicted, StudioPreviewStatus.Failed])
      .returningAll()
      .executeTakeFirst();
    if (revived) {
      return { frame: revived as unknown as StudioPreviewFrame, created: true };
    }
    /**
     * The row is live (pending, rendering or ready). Refresh what belongs to *this* request: the
     * seek it answers and, for a manifest-bound request, the viewer-session grant. A grant is
     * shorter-lived than frame retention, so a frame re-requested after its first grant expired
     * must carry the new one, or it would be refused as unauthorized while still current.
     */
    const refreshed = await db
      .updateTable('studio_preview_frame')
      .set({
        seekGeneration: frame.seekGeneration,
        requestedAt: new Date(),
        ...(frame.grantToken && { grantToken: frame.grantToken, grantSessionId: frame.grantSessionId ?? null }),
      })
      .where('cacheKey', '=', frame.cacheKey)
      .where('ownerId', '=', frame.ownerId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { frame: refreshed as unknown as StudioPreviewFrame, created: false };
  }
  async getForOwner(id: string, ownerId: string): Promise<StudioPreviewFrame | undefined> {
    return (await this.db
      .selectFrom('studio_preview_frame')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst()) as unknown as StudioPreviewFrame | undefined;
  }
  /** The scoped enqueue holds this lock through allocation and attachment in createWithin. */
  async lockPendingAdmission(tx: Transaction<DB>, frame: StudioPreviewFrame): Promise<void> {
    const current = await tx
      .selectFrom('studio_preview_frame')
      .select('id')
      .where('id', '=', frame.id)
      .where('ownerId', '=', frame.ownerId)
      .where('cacheKey', '=', frame.cacheKey)
      .where('operationId', 'is', null)
      .where('status', '=', StudioPreviewStatus.Pending)
      .forUpdate()
      .executeTakeFirst();
    if (!current) {
      throw new ConflictException('Preview admission was retired before allocation');
    }
  }
  async attachAdmissionOperation(tx: Transaction<DB>, frame: StudioPreviewFrame, operationId: string): Promise<void> {
    const operation = await tx
      .selectFrom('media_operation')
      .select(['ownerId', 'snapshot'])
      .where('id', '=', operationId)
      .executeTakeFirstOrThrow();
    if (operation.ownerId !== frame.ownerId) throw new ConflictException('Preview admission changed');
    await holdSourceAdmission(tx, operation.snapshot, operation.ownerId);
    const attached = await tx
      .updateTable('studio_preview_frame')
      .set({ operationId, status: StudioPreviewStatus.Rendering })
      .where('id', '=', frame.id)
      .where('cacheKey', '=', frame.cacheKey)
      .where('ownerId', '=', frame.ownerId)
      .where('updateId', '=', frame.updateId)
      .where('status', '=', StudioPreviewStatus.Pending)
      .where('operationId', 'is', null)
      .executeTakeFirst();
    if (Number(attached.numUpdatedRows) !== 1) {
      throw new ConflictException('Preview admission was retired before attachment');
    }
    await holdSourceAdmission(tx, operation.snapshot, operation.ownerId);
  }
  /** Fence and actual cancellation share a commit; a failed cancellation keeps a durable fence. */
  async retireConsumer(
    observed: StudioPreviewFrame,
    cancel: (tx: Transaction<DB>, operationId: string, ownerId: string) => Promise<MediaOperation | undefined>,
    expectedOperationId?: string | null,
    snapshot = true,
  ): Promise<StudioPreviewRetirement | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('studio_preview_frame')
        .selectAll()
        .where('id', '=', observed.id)
        .where('ownerId', '=', observed.ownerId)
        .where('cacheKey', '=', observed.cacheKey)
        .$if(snapshot, (qb) => qb.where('updateId', '=', observed.updateId))
        .forUpdate()
        .executeTakeFirst();
      if (!current) {
        return;
      }
      if (expectedOperationId !== undefined && current.operationId !== expectedOperationId) {
        throw new ConflictException('The captured preview operation changed');
      }
      const before = current as unknown as StudioPreviewFrame;
      let operation: MediaOperation | undefined;
      if (current.operationId) {
        operation = (await tx
          .selectFrom('media_operation')
          .selectAll()
          .where('id', '=', current.operationId)
          .where('ownerId', '=', current.ownerId)
          .where('kind', '=', MediaOperationKind.StudioPreview)
          .where('projectId', '=', current.projectId)
          .where('revisionId', '=', current.revisionDigest)
          .where(sql<string>`"snapshot"->>'previewFrameId'`, '=', current.id)
          .forUpdate()
          .executeTakeFirst()) as unknown as MediaOperation | undefined;
        if (!operation) {
          throw new ConflictException('The captured preview operation is unavailable');
        }
      }
      let marker = before.errorCode === PREVIEW_CANCEL_CLEANED ? PREVIEW_CANCEL_CLEANED : PREVIEW_CANCEL_PENDING;
      if (
        !current.operationId &&
        (before.errorCode === PREVIEW_CANCEL_NO_OPERATION ||
          (before.status === StudioPreviewStatus.Pending && before.errorCode === null))
      ) {
        marker = PREVIEW_CANCEL_NO_OPERATION;
      } else if (before.errorCode === PREVIEW_CANCEL_UNCLAIMED) {
        marker = PREVIEW_CANCEL_UNCLAIMED;
      }
      await tx
        .updateTable('studio_preview_frame')
        .set({
          status: StudioPreviewStatus.Evicted,
          framePath: null,
          frameChecksum: null,
          sizeInBytes: null,
          errorCode: marker,
        })
        .where('id', '=', current.id)
        .execute();
      let changedOperation: MediaOperation | undefined;
      let unavailable = false;
      if (
        operation &&
        ![MediaOperationStatus.Completed, MediaOperationStatus.Cancelled, MediaOperationStatus.Failed].includes(
          operation.status as MediaOperationStatus,
        )
      ) {
        await sql`SAVEPOINT preview_consumer_cancel`.execute(tx);
        try {
          changedOperation = await cancel(tx, operation.id, operation.ownerId);
          if (changedOperation) {
            if (
              [MediaOperationStatus.Queued, MediaOperationStatus.Paused].includes(
                operation.status as MediaOperationStatus,
              ) &&
              operation.claimToken === null &&
              operation.startedAt === null &&
              operation.attempt === 0
            ) {
              marker = PREVIEW_CANCEL_UNCLAIMED;
            }
            operation = changedOperation;
          } else {
            unavailable = true;
          }
        } catch {
          await sql`ROLLBACK TO SAVEPOINT preview_consumer_cancel`.execute(tx);
          unavailable = true;
        }
        await sql`RELEASE SAVEPOINT preview_consumer_cancel`.execute(tx);
      }
      if (unavailable) {
        marker = PREVIEW_CANCEL_UNAVAILABLE;
      }
      const frame = (await tx
        .updateTable('studio_preview_frame')
        .set({ errorCode: marker })
        .where('id', '=', current.id)
        .returningAll()
        .executeTakeFirstOrThrow()) as unknown as StudioPreviewFrame;
      // Completed/failed/recovered cancelled status is NOT filesystem or renderer release authority.
      const released =
        operation?.status === MediaOperationStatus.Cancelled &&
        !!operation.cancelAcknowledgedAt &&
        !!operation.remoteReleasedAt;
      const unclaimed = [PREVIEW_CANCEL_NO_OPERATION, PREVIEW_CANCEL_UNCLAIMED, PREVIEW_CANCEL_CLEANED].includes(
        marker,
      );
      const acknowledged = operation?.status === MediaOperationStatus.Cancelled && !!operation.cancelAcknowledgedAt;
      return {
        frame,
        changedOperation,
        cancellationState: unavailable
          ? 'unavailable'
          : released
            ? 'acknowledged'
            : unclaimed
              ? 'not-needed'
              : acknowledged
                ? 'acknowledged'
                : operation?.cancelRequestedAt
                  ? 'requested'
                  : 'unavailable',
        rendererReleased: released ? true : null,
        cleanupAllowed: released || unclaimed,
      };
    });
  }
  async markConsumerCleaned(frame: StudioPreviewFrame): Promise<void> {
    await this.db
      .updateTable('studio_preview_frame')
      .set({ errorCode: PREVIEW_CANCEL_CLEANED })
      .where('id', '=', frame.id)
      .where('ownerId', '=', frame.ownerId)
      .where('cacheKey', '=', frame.cacheKey)
      .where('status', '=', StudioPreviewStatus.Evicted)
      .where(sql<boolean>`"operationId" IS NOT DISTINCT FROM ${frame.operationId}::uuid`)
      .execute();
  }
  async getByCacheKey(cacheKey: string, ownerId: string): Promise<StudioPreviewFrame | undefined> {
    return (await this.db
      .selectFrom('studio_preview_frame')
      .selectAll()
      .where('cacheKey', '=', cacheKey)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst()) as unknown as StudioPreviewFrame | undefined;
  }
  /**
   * The binding (manifest) digest most recently requested for a project by this owner.
   *
   * Within one stored revision, every newer authorized resolution supersedes the older binding
   * when it is requested; which stored revision is current is decided by project storage (FL-89),
   * not here.
   */
  async getLatestRevisionDigest(projectId: string, ownerId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('studio_preview_frame')
      .select('revisionDigest')
      .where('projectId', '=', projectId)
      .where('ownerId', '=', ownerId)
      .orderBy('requestedAt', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.revisionDigest;
  }
  /** Every row for one project and owner, for the eviction and supersession planner. */
  async listForProject(projectId: string, ownerId: string, limit: number): Promise<StudioPreviewFrame[]> {
    return (await this.db
      .selectFrom('studio_preview_frame')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('ownerId', '=', ownerId)
      .orderBy('requestedAt', 'desc')
      .limit(limit)
      .execute()) as unknown as StudioPreviewFrame[];
  }
  /** Touch the recency clock. Least-recently-used eviction is only as good as this write. */
  async markAccessed(id: string, at: Date): Promise<void> {
    await this.db.updateTable('studio_preview_frame').set({ lastAccessedAt: at }).where('id', '=', id).execute();
  }
  /** Scoped delivery and recency share one admission write after all preceding read awaits. */
  async markConsumerAccessed(frame: StudioPreviewFrame, at: Date): Promise<boolean> {
    if (!frame.operationId || !frame.framePath || !isConsumerPreview(frame.cacheKey)) {
      return false;
    }
    const admitted = await this.db
      .updateTable('studio_preview_frame')
      .set({ lastAccessedAt: at })
      .where('id', '=', frame.id)
      .where('ownerId', '=', frame.ownerId)
      .where('cacheKey', '=', frame.cacheKey)
      .where('operationId', '=', frame.operationId)
      .where('framePath', '=', frame.framePath)
      .where('status', '=', StudioPreviewStatus.Ready)
      .returning('id')
      .executeTakeFirst();
    return !!admitted;
  }
  async markRendering(id: string, operationId: string, observed?: StudioPreviewFrame): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const operation = await tx
        .selectFrom('media_operation')
        .select(['ownerId', 'snapshot'])
        .where('id', '=', operationId)
        .executeTakeFirstOrThrow();
      await holdSourceAdmission(tx, operation.snapshot, operation.ownerId);
      const result = await tx
        .updateTable('studio_preview_frame')
        .set({ status: StudioPreviewStatus.Rendering, operationId })
        .where('id', '=', id)
        .where('ownerId', '=', operation.ownerId)
        .where('status', '=', StudioPreviewStatus.Pending)
        .$if(!!observed, (qb) =>
          qb
            .where('cacheKey', '=', observed!.cacheKey)
            .where('updateId', '=', observed!.updateId)
            .where('operationId', 'is', null),
        )
        .executeTakeFirst();
      await holdSourceAdmission(tx, operation.snapshot, operation.ownerId);
      return Number(result.numUpdatedRows) > 0;
    });
  }
  /**
   * Publish a validated frame.
   *
   * Guarded on both the row still awaiting one *and* the revision digest it was rendered for.
   * The second guard is not redundant: supersession rewrites the status, and a worker that
   * finished a moment too late must not be able to publish into a row the person has already
   * been told is stale.
   */
  async publish(
    id: string,
    revisionDigest: string,
    frame: {
      framePath: string;
      contentType: string;
      sizeInBytes: number | string;
      frameChecksum: Buffer | null;
      framePts: number | string | null;
      framePtsTimebase: string | null;
      toneMapped: boolean;
      readyAt: Date;
      expiresAt: Date;
    },
    authorization: Pick<StudioPreviewFrame, 'ownerId' | 'operationId' | 'grantToken' | 'grantSessionId'> & {
      assetIds: readonly string[];
    },
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('studio_preview_frame')
        .select(['id', 'projectId', 'projectRevision'])
        .where('id', '=', id)
        .where('ownerId', '=', authorization.ownerId)
        .where('operationId', authorization.operationId === null ? 'is' : '=', authorization.operationId)
        .where(sql<boolean>`"grantToken" IS NOT DISTINCT FROM ${authorization.grantToken}`)
        .where(sql<boolean>`"grantSessionId" IS NOT DISTINCT FROM ${authorization.grantSessionId}`)
        .where('revisionDigest', '=', revisionDigest)
        .where('status', 'in', [StudioPreviewStatus.Pending, StudioPreviewStatus.Rendering])
        .forUpdate()
        .executeTakeFirst();
      if (!current) {
        return false;
      }
      // Match getReadableRevision, holding the account, project and review membership through commit.
      const owner = await tx
        .selectFrom('user')
        .select('id')
        .where('id', '=', authorization.ownerId)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      const project = await tx
        .selectFrom('studio_project')
        .select(['ownerId', 'spaceId', 'archivedAt'])
        .where('id', '=', current.projectId)
        .where('currentRevision', '=', current.projectRevision ?? -1)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      let readable = !!owner && project?.ownerId === authorization.ownerId;
      if (owner && project && !readable && !project.archivedAt && project.spaceId) {
        readable = !!(await tx
          .selectFrom('album_user')
          .innerJoin('album', 'album.id', 'album_user.albumId')
          .select('album.id')
          .where('album.id', '=', project.spaceId)
          .where('album.deletedAt', 'is', null)
          .where('album_user.userId', '=', authorization.ownerId)
          .where('album_user.role', 'in', [AlbumUserRole.Owner, AlbumUserRole.Editor, AlbumUserRole.Viewer])
          .forShare()
          .executeTakeFirst());
      }
      // The signed preview grant names these sources. As for exports, source and granting rows
      // stay share-locked until publication commits, so revocation cannot land between checks.
      const ids = [...new Set(authorization.assetIds)];
      const sources = await this.privacy.lockSources(tx, ids);
      const foreign = sources
        .values()
        .filter((source) => source.ownerId !== authorization.ownerId)
        .toArray();
      const shared = await this.privacy.lockSharedAccess(tx, authorization.ownerId, foreign);
      if (
        !readable ||
        ids.some((id) => {
          const source = sources.get(id);
          return (
            !source || source.deleted || source.offline || (source.ownerId !== authorization.ownerId && !shared.has(id))
          );
        })
      ) {
        await tx
          .updateTable('studio_preview_frame')
          .set({ status: StudioPreviewStatus.Evicted, framePath: null, frameChecksum: null, sizeInBytes: null })
          .where('id', '=', id)
          .execute();
        return false;
      }
      const result = await tx
        .updateTable('studio_preview_frame')
        .set({
          status: StudioPreviewStatus.Ready,
          framePath: frame.framePath,
          contentType: frame.contentType,
          sizeInBytes: frame.sizeInBytes as never,
          frameChecksum: frame.frameChecksum,
          framePts: frame.framePts as never,
          framePtsTimebase: frame.framePtsTimebase,
          toneMapped: frame.toneMapped,
          readyAt: frame.readyAt,
          expiresAt: frame.expiresAt,
          errorCode: null,
        })
        .where('id', '=', id)
        .where('revisionDigest', '=', revisionDigest)
        .where('status', 'in', [StudioPreviewStatus.Pending, StudioPreviewStatus.Rendering])
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }
  /** A late refusal may discard only its observed binding, never a renewed request or result. */
  async evictObserved(
    frame: StudioPreviewFrame,
    removeFiles: () => Promise<void>,
    mode: 'completion' | 'snapshot' = 'completion',
  ): Promise<StudioPreviewFrame | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const evicted = await tx
        .updateTable('studio_preview_frame')
        .set({ status: StudioPreviewStatus.Evicted, framePath: null, frameChecksum: null, sizeInBytes: null })
        .where('id', '=', frame.id)
        .where('ownerId', '=', frame.ownerId)
        .where('revisionDigest', '=', frame.revisionDigest)
        .where(sql<boolean>`"operationId" IS NOT DISTINCT FROM ${frame.operationId}::uuid`)
        .where(sql<boolean>`"grantToken" IS NOT DISTINCT FROM ${frame.grantToken}`)
        .where(sql<boolean>`"grantSessionId" IS NOT DISTINCT FROM ${frame.grantSessionId}`)
        .$if(mode === 'completion', (query) => query.where('status', '!=', StudioPreviewStatus.Ready))
        // Reads and retention scans must not evict a row refreshed after their snapshot.
        .$if(mode === 'snapshot', (query) => query.where('updateId', '=', frame.updateId))
        .returningAll()
        .executeTakeFirst();
      if (!evicted) {
        return;
      }
      // Keep refresh/revival blocked until this binding's files are removed.
      await removeFiles();
      return evicted as unknown as StudioPreviewFrame;
    });
  }
  async markFailed(
    id: string,
    binding: {
      ownerId: string;
      operationId: string;
    },
    errorCode: string,
    removeFiles: () => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const result = await tx
        .updateTable('studio_preview_frame')
        .set({ status: StudioPreviewStatus.Failed, errorCode })
        .where('id', '=', id)
        .where('ownerId', '=', binding.ownerId)
        .where('operationId', '=', binding.operationId)
        .where('status', 'in', [StudioPreviewStatus.Pending, StudioPreviewStatus.Rendering])
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return false;
      }
      // A replacement cannot revive the row until the failed operation's files are removed.
      await removeFiles();
      return true;
    });
  }
  /**
   * Mark every frame of one account's project that is not on the current binding as superseded.
   *
   * The rows are kept rather than deleted: a client that still holds the id must be told the
   * revision moved on, and "not found" would read as a bug. Returns the ids that were still in
   * flight so their render operations can be cancelled.
   */
  async supersede(projectId: string, ownerId: string, currentRevisionDigest: string): Promise<StudioPreviewFrame[]> {
    return (await this.db
      .updateTable('studio_preview_frame')
      .set({ status: StudioPreviewStatus.Superseded })
      .where('projectId', '=', projectId)
      .where('ownerId', '=', ownerId)
      .where('revisionDigest', '!=', currentRevisionDigest)
      .where('status', 'in', [StudioPreviewStatus.Pending, StudioPreviewStatus.Rendering, StudioPreviewStatus.Ready])
      .returningAll()
      .execute()) as unknown as StudioPreviewFrame[];
  }
  /**
   * A stored revision was committed (FL-89): supersede every live frame of the project rendered
   * for an earlier revision, for every account that previewed it — the owner and each reviewer.
   *
   * Keyed on the stored revision number rather than a digest, because each account's frames are
   * bound to its own resolution digest and no single digest names them all. Revision numbers only
   * grow (a restore appends), so "earlier" is exact. A row with no recorded revision predates
   * project storage and can never be current.
   */
  async supersedeBeforeRevision(projectId: string, revision: number): Promise<StudioPreviewFrame[]> {
    return (await this.db
      .updateTable('studio_preview_frame')
      .set({ status: StudioPreviewStatus.Superseded })
      .where('projectId', '=', projectId)
      .where((eb) => eb.or([eb('projectRevision', 'is', null), eb('projectRevision', '<', revision)]))
      .where('status', 'in', [StudioPreviewStatus.Pending, StudioPreviewStatus.Rendering, StudioPreviewStatus.Ready])
      .returningAll()
      .execute()) as unknown as StudioPreviewFrame[];
  }
  /** Retention. The row survives as a tombstone so the answer stays "gone", not "missing". */
  async evict(ids: readonly string[]): Promise<StudioPreviewFrame[]> {
    if (ids.length === 0) {
      return [];
    }
    return (await this.db
      .updateTable('studio_preview_frame')
      .set({
        status: StudioPreviewStatus.Evicted,
        framePath: null,
        frameChecksum: null,
        sizeInBytes: null,
      })
      .where('id', 'in', [...ids])
      .where('status', '!=', StudioPreviewStatus.Evicted)
      .returningAll()
      .execute()) as unknown as StudioPreviewFrame[];
  }
  /**
   * FL-90: frames of these projects that can still be delivered or are still being made, for
   * revocation. With `ownerId`, only that account's frames.
   */
  async listLiveForAdmissions(operationIds: readonly string[]): Promise<StudioPreviewFrame[]> {
    if (operationIds.length === 0) return [];
    return (await this.db
      .selectFrom('studio_preview_frame')
      .selectAll()
      .where('operationId', 'in', [...operationIds])
      .where('status', 'in', [StudioPreviewStatus.Pending, StudioPreviewStatus.Rendering, StudioPreviewStatus.Ready])
      .execute()) as unknown as StudioPreviewFrame[];
  }

  async listLiveForProjects(projectIds: readonly string[], ownerId?: string): Promise<StudioPreviewFrame[]> {
    if (projectIds.length === 0) {
      return [];
    }
    return (await this.db
      .selectFrom('studio_preview_frame')
      .selectAll()
      .where('projectId', 'in', [...projectIds])
      .$if(ownerId !== undefined, (qb) => qb.where('ownerId', '=', ownerId!))
      .where('status', 'in', [StudioPreviewStatus.Pending, StudioPreviewStatus.Rendering, StudioPreviewStatus.Ready])
      .execute()) as unknown as StudioPreviewFrame[];
  }
  /**
   * Rows whose file can go: ready frames past their expiry, and superseded or failed frames last
   * touched before `retiredBefore`. For the retention sweep.
   */
  async listRetired(now: Date, retiredBefore: Date, limit: number): Promise<StudioPreviewFrame[]> {
    return (await this.db
      .selectFrom('studio_preview_frame')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([
            eb('status', '=', StudioPreviewStatus.Ready),
            eb('expiresAt', 'is not', null),
            eb('expiresAt', '<=', now),
          ]),
          eb.and([
            eb('status', 'in', [StudioPreviewStatus.Superseded, StudioPreviewStatus.Failed]),
            eb('updatedAt', '<', retiredBefore),
          ]),
          eb.and([
            eb('cacheKey', 'like', `${PREVIEW_CONSUMER_PREFIX}%`),
            eb('status', '=', StudioPreviewStatus.Evicted),
            eb.or([eb('errorCode', 'is', null), eb('errorCode', '!=', PREVIEW_CANCEL_CLEANED)]),
          ]),
        ]),
      )
      .orderBy('updatedAt', 'asc')
      .limit(limit)
      .execute()) as unknown as StudioPreviewFrame[];
  }
  /** Expired rows across all projects, for the retention sweep. */
  async listExpired(now: Date, limit: number): Promise<StudioPreviewFrame[]> {
    return (await this.db
      .selectFrom('studio_preview_frame')
      .selectAll()
      .where('status', '=', StudioPreviewStatus.Ready)
      .where('expiresAt', 'is not', null)
      .where('expiresAt', '<=', now)
      .orderBy('expiresAt', 'asc')
      .limit(limit)
      .execute()) as unknown as StudioPreviewFrame[];
  }
  /** Tombstones with no remaining consumer. Only an evicted row is ever removed outright. */
  async deleteEvictedBefore(before: Date, limit: number): Promise<number> {
    const ids = await this.db
      .selectFrom('studio_preview_frame')
      .select('id')
      .where('status', '=', StudioPreviewStatus.Evicted)
      .where((eb) =>
        eb.or([
          eb('cacheKey', 'not like', `${PREVIEW_CONSUMER_PREFIX}%`),
          eb('errorCode', '=', PREVIEW_CANCEL_CLEANED),
        ]),
      )
      .where('updatedAt', '<', before)
      .limit(limit)
      .execute();
    if (ids.length === 0) {
      return 0;
    }
    const result = await this.db
      .deleteFrom('studio_preview_frame')
      .where(
        'id',
        'in',
        ids.map((row) => row.id),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
