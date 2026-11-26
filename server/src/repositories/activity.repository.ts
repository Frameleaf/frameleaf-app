import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type NotNull, type Updateable, sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { Activity } from 'src/database.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { ActivityTable } from 'src/schema/tables/activity.table.js';
import { asUuid, dummy, withHiddenContentFilter } from 'src/utils/database.js';
import { isNotLocked, notLockedOrOwnedBy } from 'src/utils/locked.js';

export interface ActivitySearch extends HiddenContentQueryOptions, LockedVisibilityOptions {
  albumId?: string;
  assetId?: string | null;
  userId?: string;
  isLiked?: boolean;
  /**
   * Skip the Locked filter. Only for a lookup of the caller's own reactions (the duplicate-like check),
   * which never reaches another person.
   */
  includeLocked?: boolean;
}

/**
 * FL-1012: a remote author as the `user` of an activity response. Native apps decode that object strictly, so every
 * required field is there: the id of the author row (a v4 uuid, never a local account), the name, no email and no
 * picture, as a member's email is already sent empty.
 */
const remoteAuthorUser = sql<Activity['user']>`(
  select json_build_object(
    'id', author.id,
    'name', author."displayName",
    'email', '',
    'avatarColor', null,
    'profileImagePath', '',
    'profileChangedAt', activity."createdAt"
  )
  from household_remote_author author
  where author.id = activity."remoteAuthorId"
)`;

interface ActivityStatisticsOptions extends HiddenContentQueryOptions, LockedVisibilityOptions {
  albumId: string;
  assetId?: string;
}

@Injectable()
export class ActivityRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ albumId: DummyValue.UUID, excludeNsfw: true }] })
  search(options: ActivitySearch) {
    const { userId, assetId, albumId, isLiked } = options;

    return (
      this.db
        .selectFrom('activity')
        .selectAll('activity')
        .leftJoin('user as user2', (join) =>
          join.onRef('user2.id', '=', 'activity.userId').on('user2.deletedAt', 'is', null),
        )
        // a local author who is gone hides the row, as before; a remote author has no account to be gone
        .where((eb) => eb.or([eb('user2.id', 'is not', null), eb('activity.remoteAuthorId', 'is not', null)]))
        .innerJoinLateral(
          (eb) => eb.selectFrom(dummy).select(columns.userWithPrefix).as('user'),
          (join) => join.onTrue(),
        )
        .select(
          sql<
            Activity['user']
          >`case when activity."remoteAuthorId" is null then to_json("user") else ${remoteAuthorUser} end`.as('user'),
        )
        .leftJoin('asset', 'asset.id', 'activity.assetId')
        .$if(!!userId, (qb) => qb.where('activity.userId', '=', userId!))
        .$if(assetId === null, (qb) => qb.where('assetId', 'is', null))
        .$if(!!assetId, (qb) => qb.where('activity.assetId', '=', assetId!))
        .$if(!!albumId, (qb) => qb.where('activity.albumId', '=', albumId!))
        .$if(isLiked !== undefined, (qb) => qb.where('activity.isLiked', '=', isLiked!))
        .where('asset.deletedAt', 'is', null)
        // reactions on a Locked item stay with its owner's elevated session: another member never
        // learns the item's id or what was said about it (owner decision, September 22, 2026)
        .$if(!options.includeLocked, (qb) =>
          qb.where((eb) => eb.or([eb('asset.id', 'is', null), notLockedOrOwnedBy(options.lockedOwnerId, 'asset')])),
        )
        .$call((qb) => withHiddenContentFilter(qb, options))
        .orderBy('activity.createdAt', 'asc')
        .execute()
    );
  }

  @GenerateSql({ params: [{ albumId: DummyValue.UUID, userId: DummyValue.UUID }] })
  async create(activity: Insertable<ActivityTable>) {
    return this.db
      .insertInto('activity')
      .values(activity)
      .returningAll()
      .returning((eb) =>
        jsonObjectFrom(eb.selectFrom('user').whereRef('user.id', '=', 'activity.userId').select(columns.user)).as(
          'user',
        ),
      )
      .$narrowType<{ user: NotNull }>()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('activity').where('id', '=', asUuid(id)).execute();
  }

  /** One activity with its author, for the shared space comment endpoints (FL-55). */
  getById(id: string) {
    return this.db
      .selectFrom('activity')
      .selectAll('activity')
      .select((eb) =>
        sql<Activity['user']>`coalesce(${jsonObjectFrom(
          eb.selectFrom('user').whereRef('user.id', '=', 'activity.userId').select(columns.user),
        )}, ${remoteAuthorUser})`.as('user'),
      )
      .where('activity.id', '=', asUuid(id))
      .executeTakeFirst();
  }

  /** Rewrite a comment's text. The `updatedAt` trigger records when. */
  update(id: string, activity: Updateable<ActivityTable>) {
    return this.db
      .updateTable('activity')
      .set(activity)
      .where('id', '=', asUuid(id))
      .returningAll()
      .returning((eb) =>
        jsonObjectFrom(eb.selectFrom('user').whereRef('user.id', '=', 'activity.userId').select(columns.user)).as(
          'user',
        ),
      )
      .$narrowType<{ user: NotNull }>()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ albumId: DummyValue.UUID, assetId: DummyValue.UUID, excludeNsfw: true }] })
  async getStatistics({
    albumId,
    assetId,
    lockedOwnerId,
    ...options
  }: ActivityStatisticsOptions): Promise<{ comments: number; likes: number }> {
    const result = await this.db
      .selectFrom('activity')
      .select((eb) => [
        eb.fn.countAll<number>().filterWhere('activity.isLiked', '=', false).as('comments'),
        eb.fn.countAll<number>().filterWhere('activity.isLiked', '=', true).as('likes'),
      ])
      .leftJoin('user', (join) => join.onRef('user.id', '=', 'activity.userId').on('user.deletedAt', 'is', null))
      .where((eb) => eb.or([eb('user.id', 'is not', null), eb('activity.remoteAuthorId', 'is not', null)]))
      .leftJoin('asset', 'asset.id', 'activity.assetId')
      .$if(!!assetId, (qb) => qb.where('activity.assetId', '=', assetId!))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where('activity.albumId', '=', albumId)
      .where(({ or, and, eb }) => {
        // counted exactly as `search` lists: a Locked item's reactions only for its owner's elevated session
        const visible = lockedOwnerId ? notLockedOrOwnedBy(lockedOwnerId, 'asset') : isNotLocked('asset');
        return or([and([eb('asset.deletedAt', 'is', null), visible]), eb('asset.id', 'is', null)]);
      })
      .executeTakeFirstOrThrow();

    return result;
  }
}
