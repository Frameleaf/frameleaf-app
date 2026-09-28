import { Injectable } from '@nestjs/common';
import { type ExpressionBuilder, type Insertable, type Kysely, type Updateable } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { StackTable } from 'src/schema/tables/stack.table.js';
import {
  asUuid,
  getHiddenContentFilter,
  hasHiddenLockedPrimary,
  withAlbumVisibility,
  withHiddenContentFilter,
} from 'src/utils/database.js';
import { onStacksJoined } from 'src/utils/locked-stacks.js';
import { isLocked } from 'src/utils/locked.js';

export interface StackSearch extends HiddenContentQueryOptions, LockedVisibilityOptions {
  ownerId: string;
  primaryAssetId?: string;
}

/**
 * `lockedOwnerId`: the viewer, when their session is elevated. Only then are their own Locked
 * members listed, and only then is a stack whose primary is Locked returned at all (FL-34).
 */
type StackPrivacyOptions = HiddenContentQueryOptions & LockedVisibilityOptions;

const withAssets = (eb: ExpressionBuilder<DB, 'stack'>, withTags = false, options: StackPrivacyOptions = {}) => {
  return jsonArrayFrom(
    eb
      .selectFrom('asset')
      .selectAll('asset')
      // FL-34: the lock, so a response reports `locked` and `mapStack` can leave it out
      .select(isLocked('asset').as('isLocked'))
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('asset_exif')
            .select(columns.exif)
            .whereRef('asset_exif.assetId', '=', 'asset.id')
            .as('exifInfo'),
        (join) => join.onTrue(),
      )
      .$if(withTags, (eb) =>
        eb.select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('tag')
              .select(columns.tag)
              .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
              .whereRef('tag_asset.assetId', '=', 'asset.id'),
          ).as('tags'),
        ),
      )
      .select((eb) => eb.fn.toJson('exifInfo').as('exifInfo'))
      .where('asset.deletedAt', 'is', null)
      .whereRef('asset.stackId', '=', 'stack.id')
      .$call((qb) => withAlbumVisibility(qb, options.lockedOwnerId))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .orderBy('asset.fileCreatedAt', 'asc'),
  ).as('assets');
};

@Injectable()
export class StackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, excludeNsfw: true }] })
  search(query: StackSearch) {
    return this.db
      .selectFrom('stack')
      .selectAll('stack')
      .select((eb) => withAssets(eb, false, query))
      .where('stack.ownerId', '=', query.ownerId)
      .where((eb) => eb.not(hasHiddenLockedPrimary(eb, query.lockedOwnerId)))
      .$if(!!query.primaryAssetId, (eb) => eb.where('stack.primaryAssetId', '=', query.primaryAssetId!))
      .$if(!!getHiddenContentFilter(query), (qb) =>
        qb
          .innerJoin('asset as primaryAsset', 'primaryAsset.id', 'stack.primaryAssetId')
          .where('primaryAsset.deletedAt', 'is', null)
          .$call((qb) => withHiddenContentFilter(qb, query, 'primaryAsset')),
      )
      .execute();
  }

  async create(entity: Omit<Insertable<StackTable>, 'primaryAssetId'>, assetIds: string[]) {
    return this.db.transaction().execute(async (tx) => {
      const stacks = await tx
        .selectFrom('stack')
        .where('stack.ownerId', '=', entity.ownerId)
        .where('stack.primaryAssetId', 'in', assetIds)
        .select('stack.id')
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('asset')
              .select('asset.id')
              .whereRef('asset.stackId', '=', 'stack.id')
              .where('asset.deletedAt', 'is', null),
          ).as('assets'),
        )
        .execute();

      const uniqueIds = new Set<string>(assetIds);

      // children
      for (const stack of stacks) {
        if (stack.assets && stack.assets.length > 0) {
          for (const asset of stack.assets) {
            uniqueIds.add(asset.id);
          }
        }
      }

      if (stacks.length > 0) {
        await tx
          .deleteFrom('stack')
          .where(
            'id',
            'in',
            stacks.map((stack) => stack.id),
          )
          .execute();
      }

      const newRecord = await tx
        .insertInto('stack')
        .values({ ...entity, primaryAssetId: assetIds[0] })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('asset')
        .set({
          stackId: newRecord.id,
          updatedAt: new Date(),
        })
        .where('id', 'in', [...uniqueIds])
        .execute();

      // a stack that holds a Locked photo is Locked as a whole (FL-53)
      const lockedAssetIds = await onStacksJoined(tx, [newRecord.id]);

      const stack = await tx
        .selectFrom('stack')
        .selectAll('stack')
        .select(withAssets)
        .where('id', '=', newRecord.id)
        .executeTakeFirstOrThrow();

      // the photos that became Locked by joining it, for the caller's follow-up
      return { ...stack, lockedAssetIds };
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('stack').where('id', '=', asUuid(id)).execute();
  }

  async deleteAll(ids: string[]): Promise<void> {
    await this.db.deleteFrom('stack').where('id', 'in', ids).execute();
  }

  update(id: string, entity: Updateable<StackTable>, options: StackPrivacyOptions = {}) {
    return this.db
      .updateTable('stack')
      .set(entity)
      .where('id', '=', asUuid(id))
      .returningAll('stack')
      .returning((eb) => withAssets(eb, true, options))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, { excludeNsfw: true }] })
  getById(id: string, options: StackPrivacyOptions = {}) {
    return this.db
      .selectFrom('stack')
      .selectAll()
      .select((eb) => withAssets(eb, true, options))
      .where('id', '=', asUuid(id))
      .where((eb) => eb.not(hasHiddenLockedPrimary(eb, options.lockedOwnerId)))
      .$if(!!getHiddenContentFilter(options), (qb) =>
        qb
          .innerJoin('asset as primaryAsset', 'primaryAsset.id', 'stack.primaryAssetId')
          .where('primaryAsset.deletedAt', 'is', null)
          .$call((qb) => withHiddenContentFilter(qb, options, 'primaryAsset')),
      )
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getForAssetRemoval(assetId: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select(['stackId as id', 'stack.primaryAssetId'])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ sourceId: DummyValue.UUID, targetId: DummyValue.UUID }] })
  async merge({ sourceId, targetId }: { sourceId: string; targetId: string }): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('asset').set({ stackId: targetId }).where('asset.stackId', '=', sourceId).execute();
      // a stack that holds a Locked photo is Locked as a whole (FL-53)
      await onStacksJoined(tx, [targetId]);
    });
  }
}
