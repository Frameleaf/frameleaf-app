import { Injectable } from '@nestjs/common';
import { type ExpressionBuilder, type Insertable, type Kysely, type Updateable, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import type { UserMetadata, UserMetadataItem } from 'src/types.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetStatus, AssetType, AssetVisibility, UserStatus } from 'src/enum.js';
import { canWriteFork } from 'src/repositories/fork-write-guard.js';
import { UTILITY_ACTIVITY_RETENTION_DAYS } from 'src/repositories/trash.repository.js';
import { DB } from 'src/schema/index.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import { bestPhotoRank, getBestPhotoScoreTable } from 'src/utils/cover-references.js';
import { asUuid, isNotLockedAsset, nsfwAssetIdExists } from 'src/utils/database.js';
import { isLockedAssetId, isUnlockedAsset } from 'src/utils/locked-state.js';

export interface UserListFilter {
  id?: string;
  withDeleted?: boolean;
}

export interface UserStatsQueryResponse {
  userId: string;
  userName: string;
  photos: number;
  videos: number;
  usage: number;
  usagePhotos: number;
  usageVideos: number;
  quotaSizeInBytes: number | null;
}

/** FL-71: the account that owns a queue job's subject (an asset, person, library or the account itself). */
export interface JobSubjectOwner {
  subjectId: string;
  ownerId: string;
  ownerName: string;
}

/** FL-71 (CC-10): one saved change of an account's own preferences. */
export interface UserPreferenceHistoryRow {
  id: string;
  createdAt: Date;
  deviceLabel: string | null;
  changes: Array<{ path: string; before: string | null; after: string | null; protected?: boolean }>;
  omittedChanges: number;
}

/** How many preference history entries an account keeps. */
export const USER_PREFERENCE_HISTORY_LIMIT = 50;

export interface UserFindOptions {
  withDeleted?: boolean;
}

const withMetadata = (eb: ExpressionBuilder<DB, 'user'>) => {
  return jsonArrayFrom(
    eb
      .selectFrom('user_metadata')
      .select(['user_metadata.key', 'user_metadata.value'])
      .whereRef('user.id', '=', 'user_metadata.userId'),
  ).as('metadata');
};

@Injectable()
export class UserRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.BOOLEAN] })
  get(userId: string, options: UserFindOptions) {
    options ||= {};

    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .select(withMetadata)
      .where('user.id', '=', userId)
      .$if(!options.withDeleted, (eb) => eb.where('user.deletedAt', 'is', null))
      .executeTakeFirst();
  }

  /** `db` is a transaction when the read must be consistent with a write that follows (FL-67). */
  getMetadata(userId: string, db: Kysely<DB> = this.db) {
    return db
      .selectFrom('user_metadata')
      .select(['key', 'value'])
      .where('user_metadata.userId', '=', userId)
      .execute() as Promise<UserMetadataItem[]>;
  }

  @GenerateSql()
  getAdmin() {
    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .select(withMetadata)
      .where('user.isAdmin', '=', true)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql()
  getFileSamples() {
    return this.db
      .selectFrom('user')
      .select(['id', 'profileImagePath'])
      .where('profileImagePath', '!=', sql.lit(''))
      .limit(sql.lit(3))
      .execute();
  }

  @GenerateSql()
  async hasAdmin(): Promise<boolean> {
    const admin = await this.db
      .selectFrom('user')
      .select('user.id')
      .where('user.isAdmin', '=', true)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst();

    return !!admin;
  }

  /**
   * FL-76: whether an account has a Locked PIN, for the administrator's account detail. Only the
   * presence is read, never the hash; deleted accounts are included so their detail still says it.
   */
  async hasPinCode(id: string): Promise<boolean | undefined> {
    const row = await this.db
      .selectFrom('user')
      .select((eb) => eb('user.pinCode', 'is not', null).as('hasPinCode'))
      .where('user.id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : Boolean(row.hasPinCode);
  }

  /**
   * FL-71: the owning account of each id that names an asset, person (its group), library or account,
   * for the Job manager's Account column. Ids naming nothing, or a person several accounts share, are
   * left out.
   */
  async getJobSubjectOwners(ids: string[]): Promise<JobSubjectOwner[]> {
    if (ids.length === 0) {
      return [];
    }
    // One array parameter for every table, so a long job list never approaches the protocol's
    // 65,535-parameter limit.
    const { rows } = await sql<JobSubjectOwner & { owners: number }>`
      WITH "ids" AS (SELECT unnest(${ids}::uuid[]) AS "id"),
      "subject" AS (
        SELECT "asset"."id" AS "subjectId", "asset"."ownerId" FROM "asset" JOIN "ids" ON "ids"."id" = "asset"."id"
        UNION ALL
        SELECT "person"."personGroupId", "person"."ownerId" FROM "person" JOIN "ids" ON "ids"."id" = "person"."personGroupId"
        UNION ALL
        SELECT "library"."id", "library"."ownerId" FROM "library" JOIN "ids" ON "ids"."id" = "library"."id"
        UNION ALL
        SELECT "user"."id", "user"."id" FROM "user" JOIN "ids" ON "ids"."id" = "user"."id"
      )
      SELECT DISTINCT "subject"."subjectId", "subject"."ownerId", "user"."name" AS "ownerName",
        count(*) OVER (PARTITION BY "subject"."subjectId") AS "owners"
      FROM (SELECT DISTINCT "subjectId", "ownerId" FROM "subject") AS "subject"
      JOIN "user" ON "user"."id" = "subject"."ownerId"
    `.execute(this.db);
    // A person shared through a cluster group belongs to each of its members: no one account.
    return rows
      .filter(({ owners }) => Number(owners) === 1)
      .map(({ subjectId, ownerId, ownerName }) => ({ subjectId, ownerId, ownerName }));
  }

  /**
   * FL-71 (CC-10): adds one preferences change to the account's own history and keeps only its
   * newest USER_PREFERENCE_HISTORY_LIMIT entries.
   */
  async addPreferenceHistory(entry: {
    userId: string;
    deviceLabel: string | null;
    changes: UserPreferenceHistoryRow['changes'];
    omittedChanges: number;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // Skipped (never blocking the save) while the fork schema is not writable, as recipient groups are.
      if (!(await canWriteFork(trx))) {
        return false;
      }
      await sql`
        INSERT INTO immich_fork.user_preference_history ("userId", "deviceLabel", changes, "omittedChanges")
        VALUES (${entry.userId}::uuid, ${entry.deviceLabel}, ${JSON.stringify(entry.changes)}::text::jsonb, ${entry.omittedChanges})
      `.execute(trx);
      await sql`
        DELETE FROM immich_fork.user_preference_history
        WHERE "userId" = ${entry.userId}::uuid
          AND id NOT IN (
            SELECT id FROM immich_fork.user_preference_history
            WHERE "userId" = ${entry.userId}::uuid
            ORDER BY "createdAt" DESC, id DESC
            LIMIT ${USER_PREFERENCE_HISTORY_LIMIT}
          )
      `.execute(trx);
      return true;
    });
  }

  /**
   * FL-71 (CC-10): a deleted account leaves no preference history behind, nor (FL-47) its utility
   * activity. Skipped (never blocking the delete) while the fork schema is not writable, like
   * `forgetRecipient`.
   */
  async deletePreferenceHistory(userId: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await canWriteFork(trx))) {
        return false;
      }
      await sql`DELETE FROM immich_fork.user_preference_history WHERE "userId" = ${userId}::uuid`.execute(trx);
      await sql`DELETE FROM immich_fork.utility_activity WHERE "userId" = ${userId}::uuid`.execute(trx);
      return true;
    });
  }

  /**
   * FL-71 (CC-10), FL-55: fork rows of accounts that no longer exist, left behind when an account
   * was removed while the fork schema was not writable. Preference history of a removed account
   * goes; recipient groups it owned go, and it leaves everyone else's. FL-57/FL-58: its face
   * correction history, merge-suggestion answers and pet recognition run go too. Returns what was
   * removed, or undefined while the fork schema is still not writable.
   */
  async sweepRemovedAccountForkRows(): Promise<
    | {
        preferenceHistory: number;
        recipientGroups: number;
        memoryShowLess: number;
        memoryCurations: number;
        peopleAndPets: number;
        workspaceLayouts: number;
        utilityActivity: number;
      }
    | undefined
  > {
    return this.db.transaction().execute(async (trx) => {
      if (!(await canWriteFork(trx))) {
        return;
      }
      const history = await sql`
        DELETE FROM immich_fork.user_preference_history AS history
        WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE "user".id = history."userId")
      `.execute(trx);
      const groups = await sql`
        DELETE FROM immich_fork.recipient_group AS recipient_group
        WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE "user".id = recipient_group."ownerId")
      `.execute(trx);
      // FL-91: a Studio workspace layout left by an account removed during a handoff.
      const layouts = await sql`
        DELETE FROM immich_fork.studio_workspace_layout AS layout
        WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE "user".id = layout."userId")
      `.execute(trx);
      await sql`
        UPDATE immich_fork.recipient_group
        SET "userIds" = ARRAY(
              SELECT member FROM unnest("userIds") AS member
              WHERE EXISTS (SELECT 1 FROM "user" WHERE "user".id = member)
            ),
            "updatedAt" = clock_timestamp()
        WHERE EXISTS (
          SELECT 1 FROM unnest("userIds") AS member
          WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE "user".id = member)
        )
      `.execute(trx);
      // FL-47: utility activity of a removed account, and any past its retention window.
      const activity = await sql`
        DELETE FROM immich_fork.utility_activity AS activity
        WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE "user".id = activity."userId")
           OR activity."createdAt" < clock_timestamp() - make_interval(days => ${UTILITY_ACTIVITY_RETENTION_DAYS})
      `.execute(trx);
      // FL-62: the removed account's memory show-less rules and memory curation.
      const showLess = await sql`
        DELETE FROM immich_fork.memory_show_less AS rule
        WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE "user".id = rule."userId")
      `.execute(trx);
      const curations = await sql`
        DELETE FROM immich_fork.memory_curation AS curation
        WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE "user".id = curation."ownerId")
      `.execute(trx);
      let peopleAndPets = 0;
      for (const table of [
        sql`immich_fork.face_correction`,
        sql`immich_fork.person_merge_verdict`,
        sql`immich_fork.pet_recognition_run`,
      ]) {
        const removed = await sql`
          DELETE FROM ${table} AS owned
          WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE "user".id = owned."ownerId")
        `.execute(trx);
        peopleAndPets += Number(removed.numAffectedRows ?? 0);
      }
      return {
        preferenceHistory: Number(history.numAffectedRows ?? 0),
        recipientGroups: Number(groups.numAffectedRows ?? 0),
        workspaceLayouts: Number(layouts.numAffectedRows ?? 0),
        utilityActivity: Number(activity.numAffectedRows ?? 0),
        memoryShowLess: Number(showLess.numAffectedRows ?? 0),
        memoryCurations: Number(curations.numAffectedRows ?? 0),
        peopleAndPets,
      };
    });
  }

  /** FL-71 (CC-10): the account's own preference history, newest first. */
  async getPreferenceHistory(userId: string): Promise<UserPreferenceHistoryRow[]> {
    const { rows } = await sql<UserPreferenceHistoryRow>`
      SELECT id, "createdAt", "deviceLabel", changes, "omittedChanges"
      FROM immich_fork.user_preference_history
      WHERE "userId" = ${userId}::uuid
      ORDER BY "createdAt" DESC, id DESC
      LIMIT ${USER_PREFERENCE_HISTORY_LIMIT}
    `.execute(this.db);
    return rows;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForPinCode(id: string) {
    return this.db
      .selectFrom('user')
      .select(['user.pinCode', 'user.password'])
      .where('user.id', '=', id)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForChangePassword(id: string) {
    return this.db
      .selectFrom('user')
      .select(['user.id', 'user.password'])
      .where('user.id', '=', id)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.EMAIL] })
  getByEmail(email: string, options?: { withPassword?: boolean }) {
    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .select(withMetadata)
      .$if(!!options?.withPassword, (eb) => eb.select('password'))
      .where('email', '=', email)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  /**
   * `withDeleted` (FL-76): the unique constraint on `storageLabel` covers soft-deleted accounts too, so
   * a duplicate check before an insert or update must see them.
   */
  getByStorageLabel(storageLabel: string, withDeleted = false) {
    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .where('user.storageLabel', '=', storageLabel)
      .$if(!withDeleted, (qb) => qb.where('user.deletedAt', 'is', null))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  getByOAuthId(oauthId: string) {
    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .select(withMetadata)
      .where('user.oauthId', '=', oauthId)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DateTime.now().minus({ years: 1 })] })
  getDeletedAfter(target: DateTime) {
    return this.db.selectFrom('user').select(['id']).where('user.deletedAt', '<', target.toJSDate()).execute();
  }

  @GenerateSql(
    { name: 'with deleted', params: [{ withDeleted: true }] },
    { name: 'without deleted', params: [{ withDeleted: false }] },
  )
  getList({ id, withDeleted }: UserListFilter = {}) {
    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .select(withMetadata)
      .$if(!withDeleted, (qb) => qb.where('user.deletedAt', 'is', null))
      .$if(!!id, (eb) => eb.where('user.id', '=', id!))
      .orderBy('createdAt', 'desc')
      .execute();
  }

  async create(dto: Insertable<UserTable>) {
    return this.db
      .insertInto('user')
      .values(dto)
      .returning(columns.userAdmin)
      .returning(withMetadata)
      .executeTakeFirstOrThrow();
  }

  update(id: string, dto: Updateable<UserTable>) {
    return this.db
      .updateTable('user')
      .set(dto)
      .where('user.id', '=', asUuid(id))
      .where('user.deletedAt', 'is', null)
      .returning(columns.userAdmin)
      .returning(withMetadata)
      .executeTakeFirstOrThrow();
  }

  /**
   * Whether the user's profile picture was copied from a photo that is Locked now (FL-53). Such a
   * picture is never served; `replaceLockedProfileImages` gives the user another one.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async hasLockedProfileImageSource(id: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('user')
      .select('user.id')
      .where('user.id', '=', asUuid(id))
      .where(isLockedAssetId(sql.ref('user.profileImageAssetId')))
      .executeTakeFirst();
    return !!row;
  }

  /** Users whose profile picture was copied from a photo that is Locked now (FL-53). */
  @GenerateSql()
  getLockedProfileImageSources() {
    return this.db
      .selectFrom('user')
      .select(['user.id', 'user.profileImagePath', 'user.profileImageAssetId'])
      .where('user.profileImageAssetId', 'is not', null)
      .where(isLockedAssetId(sql.ref('user.profileImageAssetId')))
      .where('user.deletedAt', 'is', null)
      .execute();
  }

  /**
   * The photo a profile picture is copied from in place of one that became Locked (owner decisions 2
   * and 4, FL-53). A profile picture is seen by everyone on the server, so only a photo of the user's
   * own that anyone may see: an image on the Timeline, not Locked, trashed or sensitive. Photos marked
   * as Best Photos first, the highest score first, then the newest. Undefined when there is none.
   *
   * The owner's first choice, a face crop of the person the user is, does not apply yet: no account is
   * linked to a person.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getProfileImageReplacement(userId: string): Promise<{ id: string; path: string } | undefined> {
    const scores = await getBestPhotoScoreTable(this.db);
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_file', (join) =>
        join.onRef('asset_file.assetId', '=', 'asset.id').on('asset_file.type', '=', sql.lit(AssetFileType.Preview)),
      )
      .select(['asset.id', 'asset_file.path'])
      .where('asset.ownerId', '=', asUuid(userId))
      .where('asset.type', '=', sql.lit(AssetType.Image))
      .where('asset.status', '=', sql.lit(AssetStatus.Active))
      .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
      .where(isUnlockedAsset())
      .where('asset.deletedAt', 'is', null)
      .where(sql<boolean>`not ${nsfwAssetIdExists(sql.ref('asset.id'))}`)
      .orderBy(bestPhotoRank(scores, sql.ref('asset.id')), 'desc')
      .orderBy('asset.fileCreatedAt', 'desc')
      .orderBy('asset_file.isEdited', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Replaces a profile picture copied from the Locked photo `lockedAssetId`, unless the user set
   * another picture in the meantime. Whether it replaced it.
   */
  @GenerateSql({
    params: [DummyValue.UUID, DummyValue.UUID, { profileImagePath: DummyValue.STRING, profileImageAssetId: null }],
  })
  async replaceLockedProfileImage(
    id: string,
    lockedAssetId: string,
    value: { profileImagePath: string; profileImageAssetId: string | null },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('user')
      .set({ ...value, profileChangedAt: new Date() })
      .where('user.id', '=', asUuid(id))
      .where('user.profileImageAssetId', '=', asUuid(lockedAssetId))
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async updateAll(dto: Updateable<UserTable>) {
    await this.db.updateTable('user').set(dto).execute();
  }

  restore(id: string) {
    return this.db
      .updateTable('user')
      .set({ status: UserStatus.Active, deletedAt: null })
      .where('user.id', '=', asUuid(id))
      .returning(columns.userAdmin)
      .returning(withMetadata)
      .executeTakeFirstOrThrow();
  }

  async upsertMetadata<T extends keyof UserMetadata>(
    id: string,
    { key, value }: { key: T; value: UserMetadata[T] },
    db: Kysely<DB> = this.db,
  ) {
    await db
      .insertInto('user_metadata')
      .values({ userId: id, key, value })
      .onConflict((oc) =>
        oc.columns(['userId', 'key']).doUpdateSet({
          key,
          value,
        }),
      )
      .execute();
  }

  async deleteMetadata<T extends keyof UserMetadata>(id: string, key: T) {
    await this.db.deleteFrom('user_metadata').where('userId', '=', id).where('key', '=', key).execute();
  }

  delete(user: { id: string }, hard?: boolean) {
    return hard
      ? this.db.deleteFrom('user').where('id', '=', user.id).execute()
      : this.db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', user.id).execute();
  }

  @GenerateSql()
  getUserStats() {
    return this.db
      .selectFrom('user')
      .leftJoin('asset', (join) => join.onRef('asset.ownerId', '=', 'user.id').on('asset.deletedAt', 'is', null))
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['user.id as userId', 'user.name as userName', 'user.quotaSizeInBytes'])
      .select((eb) => [
        eb.fn
          .countAll<number>()
          .filterWhere((eb) =>
            eb.and([
              eb('asset.type', '=', sql.lit(AssetType.Image)),
              eb('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden)),
              // an administrator's per-user counts never include Locked media (FL-34)
              isNotLockedAsset(eb),
            ]),
          )
          .as('photos'),
        eb.fn
          .countAll<number>()
          .filterWhere((eb) =>
            eb.and([
              eb('asset.type', '=', sql.lit(AssetType.Video)),
              eb('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden)),
              // an administrator's per-user counts never include Locked media (FL-34)
              isNotLockedAsset(eb),
            ]),
          )
          .as('videos'),
        eb.fn
          .coalesce(
            eb.fn.sum<number>('asset_exif.fileSizeInByte').filterWhere('asset.libraryId', 'is', null),
            eb.lit(0),
          )
          .as('usage'),
        eb.fn
          .coalesce(
            eb.fn
              .sum<number>('asset_exif.fileSizeInByte')
              .filterWhere((eb) =>
                eb.and([eb('asset.libraryId', 'is', null), eb('asset.type', '=', sql.lit(AssetType.Image))]),
              ),
            eb.lit(0),
          )
          .as('usagePhotos'),
        eb.fn
          .coalesce(
            eb.fn
              .sum<number>('asset_exif.fileSizeInByte')
              .filterWhere((eb) =>
                eb.and([eb('asset.libraryId', 'is', null), eb('asset.type', '=', sql.lit(AssetType.Video))]),
              ),
            eb.lit(0),
          )
          .as('usageVideos'),
      ])
      .groupBy('user.id')
      .orderBy('user.createdAt', 'asc')
      .execute();
  }

  @GenerateSql()
  async getCount(): Promise<number> {
    const result = await this.db
      .selectFrom('user')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('user.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.NUMBER] })
  async updateUsage(id: string, delta: number): Promise<void> {
    await this.db
      .updateTable('user')
      .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${delta}`, updatedAt: new Date() })
      .where('id', '=', asUuid(id))
      .where('user.deletedAt', 'is', null)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async syncUsage(id?: string) {
    const query = this.db
      .updateTable('user')
      .set({
        quotaUsageInBytes: (eb) =>
          eb
            .selectFrom('asset')
            .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
            .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('asset_exif.fileSizeInByte'), eb.lit(0)).as('usage'))
            .where('asset.libraryId', 'is', null)
            .where('asset.ownerId', '=', eb.ref('user.id')),
        updatedAt: new Date(),
      })
      .where('user.deletedAt', 'is', null)
      .$if(id !== undefined, (eb) => eb.where('user.id', '=', asUuid(id!)));

    await query.execute();
  }
}
