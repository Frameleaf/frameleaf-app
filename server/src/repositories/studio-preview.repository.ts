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
   * `onConflict ... doNothing` on `cacheKey` is what makes two people scrubbing to the same
   * frame of the same revision share one render. The follow-up read is deliberate: the winner
   * of the race and the loser must both end up holding the same row.
   */
  async upsert(frame: StudioPreviewFrameCreate): Promise<StudioPreviewFrame> {
    const inserted = await this.db
      .insertInto('studio_preview_frame')
      .values(frame)
      .onConflict((builder) => builder.column('cacheKey').doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      return inserted as unknown as StudioPreviewFrame;
    }

    return (await this.db
      .selectFrom('studio_preview_frame')
      .selectAll()
      .where('cacheKey', '=', frame.cacheKey)
      .executeTakeFirstOrThrow()) as unknown as StudioPreviewFrame;
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
   * The revision digest most recently requested for a project by this owner.
   *
   * This is the *fallback* revision authority. Studio project storage is owned by a story still
   * in flight; until it lands, the newest revision anybody has asked to preview is the newest
   * revision we know of, and every older digest is superseded against it. The service takes an
   * authority through {@link StudioProjectRevisionAuthority} and falls back to this, so the swap
   * is one provider and no call site changes.
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
    await this.db
      .updateTable('studio_preview_frame')
      .set({ lastAccessedAt: at })
      .where('id', '=', id)
      .execute();
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
   * Mark every frame of a project that is not on the current revision as superseded.
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
      .where('status', 'in', [
        StudioPreviewStatus.Pending,
        StudioPreviewStatus.Rendering,
        StudioPreviewStatus.Ready,
      ])
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
