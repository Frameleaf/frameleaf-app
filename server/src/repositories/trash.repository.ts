import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { TrashReviewRow, TrashScopeRow } from 'src/utils/trash-review.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { TrashItemSort, UtilityActivityAction, UtilityActivityTool } from 'src/dtos/trash.dto.js';
import { canWriteFork } from 'src/repositories/fork-write-guard.js';
import { AssetStatus, AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { anyUuid, asUuid, withHiddenContentFilter } from 'src/utils/database.js';
import { isLocked, isNotLocked } from 'src/utils/locked.js';
import {
  TrashReviewAction,
  escapeLikeTerm,
  toByteCount,
  trashActionSourceStatus,
  trashActionTargetStatus,
} from 'src/utils/trash-review.js';

/**
 * Who is looking (FL-47). Everything this repository reads or changes is one owner's own media, and
 * only what that owner's session may see: Locked media only for the owner's elevated session
 * (`lockedOwnerId`), and nothing the owner's privacy filters hide from an ordinary session.
 */
export type TrashScopeOptions = {
  /** The owner, when their session is unlocked; their Locked media is then included. */
  lockedOwnerId?: string;
  /** Suppressed people, pets and tags, and hidden sensitive detections, for an ordinary session. */
  privacy?: HiddenContentQueryOptions;
};

export type TrashItemsOptions = TrashScopeOptions & {
  terms: string[];
  type?: AssetType;
  order: TrashItemSort;
  page: number;
  size: number;
};

export type TrashItemRow = {
  id: string;
  originalFileName: string;
  type: AssetType;
  status: AssetStatus;
  fileSizeInByte: number | string | null;
  deletedAt: Date | null;
  isLocked: boolean;
  isOffline: boolean;
};

/** One item of a utility activity entry, as stored: what it was when it was moved. */
export type UtilityActivityItem = { assetId: string; fileName: string; bytes: number };

export type UtilityActivityRow = {
  id: string;
  action: UtilityActivityAction;
  createdAt: Date;
  items: UtilityActivityItem[];
};

/** How long, and how much, utility activity is kept per owner and tool (FL-47, FL-146). */
export const UTILITY_ACTIVITY_RETENTION_DAYS = 365;
export const UTILITY_ACTIVITY_LIMIT = 500;

export class TrashRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  getDeletedIds(): AsyncIterableIterator<{ id: string }> {
    return this.db.selectFrom('asset').select(['id']).where('status', '=', AssetStatus.Deleted).stream();
  }

  /**
   * The owner's items in one lifecycle state, as far as this session may see them. The hidden video
   * part of a live photo follows its photo and is never listed or changed on its own.
   *
   * `listed` is what the trash shows, as the trash timeline always has: everything with a deletion
   * date that is not yet permanently deleted. That includes external-library originals the library
   * scan found missing: they stay `active` with a deletion date, and the scan brings them back. They
   * are listed but no action here changes them, because every action starts from `trashed` (or, for
   * a move to the trash, from `active` without a deletion date). An item the owner trashed whose file
   * went missing afterwards is `trashed` and is restored or deleted like any other.
   */
  private scope(
    db: Kysely<DB>,
    userId: string,
    status: AssetStatus | 'listed',
    { lockedOwnerId, privacy }: TrashScopeOptions,
  ) {
    return (
      db
        .selectFrom('asset')
        .where('asset.ownerId', '=', asUuid(userId))
        .$if(status === 'listed', (qb) =>
          qb.where('asset.deletedAt', 'is not', null).where('asset.status', '!=', AssetStatus.Deleted),
        )
        .$if(status !== 'listed', (qb) => qb.where('asset.status', '=', status as AssetStatus))
        // a missing external original is active with a deletion date; it is the library scan's, not the library's
        .$if(status === AssetStatus.Active, (qb) => qb.where('asset.deletedAt', 'is', null))
        .where('asset.visibility', '!=', AssetVisibility.Hidden)
        .$if(lockedOwnerId !== userId, (qb) => qb.where(isNotLocked('asset')))
        .$call((qb) => withHiddenContentFilter(qb, privacy))
    );
  }

  /** The trash counts the page shows: what is in it, and what is still being removed from storage. */
  async getSummary(userId: string, options: TrashScopeOptions = {}) {
    const listed = await this.scope(this.db, userId, 'listed', options)
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select((eb) => [
        eb.fn.countAll<number>().as('count'),
        // missing external originals the library scan put here; they are listed but no action changes them
        sql<string>`count(*) filter (where asset."isOffline" and asset.status = ${sql.lit(AssetStatus.Active)})`.as(
          'offline',
        ),
        sql<string>`coalesce(sum(asset_exif."fileSizeInByte"), 0)`.as('bytes'),
      ])
      .executeTakeFirstOrThrow();

    const deleted = await this.scope(this.db, userId, AssetStatus.Deleted, options)
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();

    return {
      count: Number(listed.count),
      offline: Number(listed.offline),
      bytes: toByteCount(listed.bytes),
      pendingDeletion: Number(deleted.count),
    };
  }

  /** One page of the owner's trash, filtered and ordered as the page asks, with the matching total. */
  async getItems(userId: string, options: TrashItemsOptions) {
    const filtered = this.scope(this.db, userId, 'listed', options)
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .$if(!!options.type, (qb) => qb.where('asset.type', '=', options.type as AssetType))
      .$call((qb) => {
        let query = qb;
        for (const term of options.terms) {
          query = query.where(
            sql`f_unaccent(asset."originalFileName")`,
            'ilike',
            sql`'%' || f_unaccent(${escapeLikeTerm(term)}) || '%'`,
          );
        }
        return query;
      });

    const { count } = await filtered.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow();

    let query = filtered.select([
      'asset.id',
      'asset.originalFileName',
      'asset.type',
      'asset.status',
      'asset.deletedAt',
      'asset.isOffline',
      'asset_exif.fileSizeInByte',
      isLocked('asset').as('isLocked'),
    ]);
    switch (options.order) {
      case TrashItemSort.Size: {
        query = query.orderBy('asset_exif.fileSizeInByte', (ob) => ob.desc().nullsLast()).orderBy('asset.id', 'asc');
        break;
      }
      case TrashItemSort.Name: {
        query = query.orderBy('asset.originalFileName', 'asc').orderBy('asset.id', 'asc');
        break;
      }
      default: {
        query = query.orderBy('asset.deletedAt', (ob) => ob.desc().nullsLast()).orderBy('asset.id', 'desc');
        break;
      }
    }

    const rows: TrashItemRow[] = await query
      .limit(options.size + 1)
      .offset((options.page - 1) * options.size)
      .execute();

    const hasNextPage = rows.length > options.size;
    rows.splice(options.size);
    return { items: rows, hasNextPage, total: Number(count) };
  }

  /**
   * The set an action would change, with what the review shows about each item. `ids` names the
   * items for the actions that take them; without it the whole visible trash is the set.
   */
  async getReviewRows(
    userId: string,
    action: TrashReviewAction,
    ids: string[] | undefined,
    options: TrashScopeOptions = {},
  ): Promise<TrashReviewRow[]> {
    const rows = await this.scope(this.db, userId, trashActionSourceStatus(action), options)
      .$if(ids !== undefined, (qb) => qb.where('asset.id', '=', anyUuid(ids ?? [])))
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.status',
        'asset.deletedAt',
        'asset.originalFileName',
        'asset_exif.fileSizeInByte',
        isLocked('asset').as('isLocked'),
        // Another asset naming the same original keeps it on disk; `FileDelete` refuses a path a
        // live row still names (see PhysicalFileRepository.deleteUnreferencedPath). A row already
        // being removed, or one of the chosen items itself, does not keep it. Items of a whole-trash
        // review are still counted, so the review can under-report freed space but never promise it.
        sql<boolean>`exists (
          select 1
          from asset as other
          where other.id != asset.id
            and other.status != ${sql.lit(AssetStatus.Deleted)}
            ${ids === undefined ? sql`` : sql`and not (other.id = ${anyUuid(ids)})`}
            and (
              other."originalPath" = asset."originalPath"
              or (
                asset."physicalOriginalFileId" is not null
                and other."physicalOriginalFileId" = asset."physicalOriginalFileId"
              )
            )
        )`.as('sharesOriginal'),
      ])
      .orderBy('asset.id', 'asc')
      .execute();

    return rows.map((row) => ({ ...row, isLocked: !!row.isLocked, sharesOriginal: !!row.sharesOriginal }));
  }

  /**
   * Apply a reviewed action. The set is found again inside the transaction and its rows are locked
   * before `verify` compares it with the review, so nothing can join or leave it between the check
   * and the change. Returns the changed ids, or null when `verify` refused the set.
   */
  async applyReviewed(
    userId: string,
    action: TrashReviewAction,
    ids: string[] | undefined,
    options: TrashScopeOptions,
    verify: (rows: TrashScopeRow[]) => boolean,
  ): Promise<string[] | null> {
    const source = trashActionSourceStatus(action);
    const target = trashActionTargetStatus(action);

    return this.db.transaction().execute(async (trx) => {
      const found = await this.scope(trx, userId, source, options)
        .$if(ids !== undefined, (qb) => qb.where('asset.id', '=', anyUuid(ids ?? [])))
        .select(['asset.id', 'asset.ownerId', 'asset.status', 'asset.deletedAt', isLocked('asset').as('isLocked')])
        .orderBy('asset.id', 'asc')
        .forUpdate()
        .execute();

      const rows = found.map((row) => ({ ...row, isLocked: !!row.isLocked }));
      if (!verify(rows)) {
        return null;
      }
      if (rows.length === 0) {
        return [];
      }

      const changes =
        target === AssetStatus.Active
          ? { status: target, deletedAt: null }
          : target === AssetStatus.Trashed
            ? { status: target, deletedAt: new Date() }
            : { status: target };

      const updated = await trx
        .updateTable('asset')
        .where('asset.id', '=', anyUuid(rows.map((row) => row.id)))
        .where('asset.status', '=', source)
        .set(changes)
        .returning('asset.id')
        .execute();

      return updated.map((row) => row.id);
    });
  }

  /** Restores chosen items that are still in the trash, and says which ones actually were. */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async restoreAll(ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }

    const restored = await this.db
      .updateTable('asset')
      .where('status', '=', AssetStatus.Trashed)
      .where('id', 'in', ids)
      .set({ status: AssetStatus.Active, deletedAt: null })
      .returning('id')
      .execute();

    return restored.map(({ id }) => id);
  }

  /**
   * The name and size of each changed original, for a utility activity entry. Read after the change,
   * from the owner's own rows only.
   */
  async getActivityItems(userId: string, ids: string[]): Promise<UtilityActivityItem[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .where('asset.ownerId', '=', asUuid(userId))
      .where('asset.id', '=', anyUuid(ids))
      .select(['asset.id', 'asset.originalFileName', 'asset_exif.fileSizeInByte'])
      .orderBy('asset_exif.fileSizeInByte', (ob) => ob.desc().nullsLast())
      .orderBy('asset.id')
      .execute();
    return rows.map((row) => ({
      assetId: row.id,
      fileName: row.originalFileName,
      bytes: toByteCount(row.fileSizeInByte),
    }));
  }

  /**
   * Record one utility change (FL-47): a move to the trash or its undo, with its items. Keeps the
   * newest `UTILITY_ACTIVITY_LIMIT` entries of the owner's tool from the last
   * `UTILITY_ACTIVITY_RETENTION_DAYS` days. Returns false, recording nothing, while the fork schema
   * is not writable (a database handoff); the change itself has already been made.
   */
  async addUtilityActivity(entry: {
    userId: string;
    tool: UtilityActivityTool;
    action: UtilityActivityAction;
    items: UtilityActivityItem[];
  }): Promise<boolean> {
    const bytes = entry.items.reduce((sum, item) => sum + item.bytes, 0);
    return this.db.transaction().execute(async (trx) => {
      if (!(await canWriteFork(trx))) {
        return false;
      }
      await sql`
        INSERT INTO immich_fork.utility_activity ("userId", tool, action, "itemCount", bytes, items)
        VALUES (${entry.userId}::uuid, ${entry.tool}, ${entry.action}, ${entry.items.length}, ${bytes},
          ${JSON.stringify(entry.items)}::text::jsonb)
      `.execute(trx);
      await sql`
        DELETE FROM immich_fork.utility_activity
        WHERE "userId" = ${entry.userId}::uuid
          AND tool = ${entry.tool}
          AND (
            "createdAt" < clock_timestamp() - make_interval(days => ${UTILITY_ACTIVITY_RETENTION_DAYS})
            OR id NOT IN (
              SELECT id FROM immich_fork.utility_activity
              WHERE "userId" = ${entry.userId}::uuid AND tool = ${entry.tool}
              ORDER BY "createdAt" DESC, id DESC
              LIMIT ${UTILITY_ACTIVITY_LIMIT}
            )
          )
      `.execute(trx);
      return true;
    });
  }

  /** The owner's utility activity for one tool, newest first, within the retention window. */
  async getUtilityActivity(userId: string, tool: UtilityActivityTool): Promise<UtilityActivityRow[]> {
    const { rows } = await sql<UtilityActivityRow>`
      SELECT id, action, "createdAt", items
      FROM immich_fork.utility_activity
      WHERE "userId" = ${userId}::uuid
        AND tool = ${tool}
        AND "createdAt" >= clock_timestamp() - make_interval(days => ${UTILITY_ACTIVITY_RETENTION_DAYS})
      ORDER BY "createdAt" DESC, id DESC
      LIMIT ${UTILITY_ACTIVITY_LIMIT}
    `.execute(this.db);
    return rows;
  }

  /**
   * Which of these items the session may still see (FL-47): the owner's own, not the hidden part of
   * a live photo, Locked media only for the owner's unlocked session, and nothing the privacy filters
   * hide. Utility activity names only these; a permanently deleted item has no row and is not named.
   */
  async getVisibleIds(
    userId: string,
    ids: string[],
    { lockedOwnerId, privacy }: TrashScopeOptions,
  ): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('asset')
      .where('asset.ownerId', '=', asUuid(userId))
      .where('asset.id', '=', anyUuid(ids))
      .where('asset.status', '!=', AssetStatus.Deleted)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .$if(lockedOwnerId !== userId, (qb) => qb.where(isNotLocked('asset')))
      .$call((qb) => withHiddenContentFilter(qb, privacy))
      .select('asset.id')
      .execute();
    return new Set(rows.map(({ id }) => id));
  }
}
