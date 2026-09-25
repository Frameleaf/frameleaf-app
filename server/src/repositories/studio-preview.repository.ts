import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { StudioPreviewStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { StudioPreviewFrameTable } from 'src/schema/tables/studio-preview.table.js';

export type StudioPreviewFrame = Selectable<StudioPreviewFrameTable>;

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
  constructor(@InjectKysely() private db: Kysely<DB>) {}

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
  async upsert(frame: StudioPreviewFrameCreate): Promise<{ frame: StudioPreviewFrame; created: boolean }> {
    const inserted = await this.db
      .insertInto('studio_preview_frame')
      .values(frame)
      .onConflict((builder) => builder.column('cacheKey').doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      return { frame: inserted as unknown as StudioPreviewFrame, created: true };
    }

    const revived = await this.db
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
    const refreshed = await this.db
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

  async markRendering(id: string, operationId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('studio_preview_frame')
      .set({ status: StudioPreviewStatus.Rendering, operationId })
      .where('id', '=', id)
      .where('status', '=', StudioPreviewStatus.Pending)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
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
  ): Promise<boolean> {
    const result = await this.db
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
  }

  async markFailed(id: string, errorCode: string): Promise<boolean> {
    const result = await this.db
      .updateTable('studio_preview_frame')
      .set({ status: StudioPreviewStatus.Failed, errorCode })
      .where('id', '=', id)
      .where('status', 'in', [StudioPreviewStatus.Pending, StudioPreviewStatus.Rendering])
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
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
