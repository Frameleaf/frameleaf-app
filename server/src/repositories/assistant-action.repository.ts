import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type Selectable, type Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { AssistantActionTable } from 'src/schema/tables/assistant-action.table.js';
import { AssistantActionStatus } from 'src/utils/assistant-action.js';
import { anyUuid } from 'src/utils/database.js';

export type AssistantAction = Selectable<AssistantActionTable>;

/** What an action needs to know about one of the person's items, as it is right now. */
export type AssistantActionItem = {
  id: string;
  type: AssetType;
  isFavorite: boolean;
  visibility: AssetVisibility;
  fileCreatedAt: Date;
  rating: number | null;
  burstId: string | null;
  score: number | null;
};

/**
 * FL-938: the assistant action journal. Every read and write is scoped to the account that owns the
 * row; there is no query that reaches another account's actions or items.
 */
@Injectable()
export class AssistantActionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  create(action: Insertable<AssistantActionTable>): Promise<AssistantAction> {
    return this.db.insertInto('assistant_action').values(action).returningAll().executeTakeFirstOrThrow();
  }

  get(id: string, userId: string): Promise<AssistantAction | undefined> {
    return this.db
      .selectFrom('assistant_action')
      .selectAll()
      .where('id', '=', id)
      .where('userId', '=', userId)
      .executeTakeFirst();
  }

  /**
   * One account's actions, newest first. `before` is the id of the last action of the previous page; a
   * cursor that names no action of this account yields an empty page.
   */
  getAll(userId: string, { before, take }: { before?: string; take: number }): Promise<AssistantAction[]> {
    return this.db
      .selectFrom('assistant_action')
      .selectAll()
      .where('userId', '=', userId)
      .$if(before !== undefined, (qb) =>
        qb.where(
          sql<boolean>`("assistant_action"."createdAt", "assistant_action"."id") < (
            SELECT "cursor"."createdAt", "cursor"."id"
            FROM "assistant_action" AS "cursor"
            WHERE "cursor"."id" = ${before}::uuid AND "cursor"."userId" = ${userId}::uuid
          )`,
        ),
      )
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(take)
      .execute();
  }

  /**
   * Move an action from one status to the next, for its owner only. Answers nothing when the action is
   * not in `from` any more, which is what makes a second confirm or a second undo a no-op.
   */
  transition(
    id: string,
    userId: string,
    from: string,
    update: Updateable<AssistantActionTable>,
  ): Promise<AssistantAction | undefined> {
    return this.db
      .updateTable('assistant_action')
      .set(update)
      .where('id', '=', id)
      .where('userId', '=', userId)
      .where('status', '=', from)
      .returningAll()
      .executeTakeFirst();
  }

  async update(id: string, userId: string, update: Updateable<AssistantActionTable>): Promise<void> {
    await this.db
      .updateTable('assistant_action')
      .set(update)
      .where('id', '=', id)
      .where('userId', '=', userId)
      .execute();
  }

  /** Expire proposals nobody confirmed and applied changes past their undo window. */
  async expire(cutoffs: { proposedBefore: Date; appliedBefore: Date }): Promise<number> {
    const result = await this.db
      .updateTable('assistant_action')
      .set({ status: AssistantActionStatus.Expired })
      .where((eb) =>
        eb.or([
          eb.and([eb('status', '=', AssistantActionStatus.Proposed), eb('createdAt', '<', cutoffs.proposedBefore)]),
          eb.and([eb('status', '=', AssistantActionStatus.Applied), eb('appliedAt', '<', cutoffs.appliedBefore)]),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * These items as they are now, when they are this account's own, not in the trash and on the
   * timeline or in the archive. Anything else — someone else's item, a partner's, a hidden motion
   * video, a trashed or missing one — is simply not answered for.
   */
  async getItems(userId: string, ids: string[]): Promise<AssistantActionItem[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('asset_best_photo_score', 'asset_best_photo_score.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.type',
        'asset.isFavorite',
        'asset.visibility',
        'asset.fileCreatedAt',
        'asset_exif.rating',
        'asset_exif.autoStackId as burstId',
        'asset_best_photo_score.score',
      ])
      .where('asset.id', '=', anyUuid(ids))
      .where('asset.ownerId', '=', userId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .execute();
    return rows.map((row) => ({ ...row, fileCreatedAt: new Date(row.fileCreatedAt) }));
  }

  /** Every item in an album, whoever owns it. Only called for an album the caller may read. */
  async getAlbumAssetIds(albumId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('album_asset')
      .select('album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .execute();
    return rows.map(({ assetId }) => assetId);
  }

  /** Which of these items are in the album. */
  async getAlbumMembers(albumId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('album_asset')
      .select('album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .where('album_asset.assetId', '=', anyUuid(ids))
      .execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  /** Which of these items carry the tag itself (not a tag nested under it). */
  async getTagMembers(tagId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('tag_asset')
      .select('tag_asset.assetId')
      .where('tag_asset.tagId', '=', tagId)
      .where('tag_asset.assetId', '=', anyUuid(ids))
      .execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  /** Every item carrying the tag. Only called for a tag the caller owns. */
  async getTagAssetIds(tagId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('tag_asset')
      .select('tag_asset.assetId')
      .where('tag_asset.tagId', '=', tagId)
      .execute();
    return rows.map(({ assetId }) => assetId);
  }
}
