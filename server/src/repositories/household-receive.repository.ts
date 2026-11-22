import { Injectable } from '@nestjs/common';
import { type Insertable, Kysely, type Selectable, type Transaction, type Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type {
  HouseholdFaceBox,
  HouseholdInboundShareTable,
  HouseholdOriginTable,
} from 'src/schema/tables/household-receive.table.js';
import { UserStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

export type HouseholdInboundShare = Selectable<HouseholdInboundShareTable>;
export type HouseholdOrigin = Selectable<HouseholdOriginTable>;
export type HouseholdOriginKey = { linkId: string; remoteId: string; kind: 'asset' | 'person'; userId: string };
export type HouseholdLocalFace = {
  id: string;
  remoteAssetId: string;
  personGroupId: string | null;
  correctedAt: Date | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
};

const originKey = <T extends { where: any }>(query: T, key: HouseholdOriginKey): T =>
  query
    .where('linkId', '=', key.linkId)
    .where('remoteId', '=', key.remoteId)
    .where('kind', '=', key.kind)
    .where('userId', '=', key.userId);

/** FL-994: what this server received from linked households, per local account. */
@Injectable()
export class HouseholdReceiveRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /* --------------------------------- inbound shares --------------------------------- */

  getShare(id: string) {
    return this.db.selectFrom('household_inbound_share').selectAll().where('id', '=', id).executeTakeFirst();
  }

  getSharesOfLink(linkId: string) {
    return this.db.selectFrom('household_inbound_share').selectAll().where('linkId', '=', linkId).execute();
  }

  getSharesOfUser(userId: string) {
    return this.db
      .selectFrom('household_inbound_share')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  /** Accounts that can receive: they exist, are active and are not being deleted. */
  async getActiveUserIds(ids: string[]) {
    if (ids.length === 0) {
      return new Set<string>();
    }
    const rows = await this.db
      .selectFrom('user')
      .select('id')
      .where('id', 'in', ids)
      .where('status', '=', UserStatus.Active)
      .where('deletedAt', 'is', null)
      .execute();
    return new Set(rows.map(({ id }) => id));
  }

  /** The row when it is new; undefined when this person was already invited to this share. */
  createInvited(share: Insertable<HouseholdInboundShareTable>) {
    return this.db
      .insertInto('household_inbound_share')
      .values(share)
      .onConflict((oc) => oc.columns(['linkId', 'remoteShareId', 'userId']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  updateShare(id: string, change: Updateable<HouseholdInboundShareTable>) {
    return this.db
      .updateTable('household_inbound_share')
      .set(change)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Accepted shares of this link whose next pull is due. */
  getDue(linkId: string) {
    return this.db
      .selectFrom('household_inbound_share')
      .selectAll()
      .where('linkId', '=', linkId)
      .where('state', '=', 'accepted')
      .where((eb) => eb.or([eb('nextPullAt', 'is', null), eb('nextPullAt', '<=', sql<Date>`now()`)]))
      .orderBy('createdAt', 'asc')
      .execute();
  }

  async pullNow(linkId: string) {
    await this.db
      .updateTable('household_inbound_share')
      .set({ nextPullAt: null })
      .where('linkId', '=', linkId)
      .where('state', '=', 'accepted')
      .where('lastError', 'is distinct from', 'over-quota')
      // a poke never cuts a failing share's backoff short
      .where('failures', '=', 0)
      .execute();
  }

  /** One pull per share at a time, across workers. False while another holds the lease. */
  async claimPull(id: string, ms: number) {
    const row = await this.db
      .updateTable('household_inbound_share')
      .set({ pullingUntil: sql<Date>`now() + ${`${ms} milliseconds`}::interval` })
      .where('id', '=', id)
      .where('state', '=', 'accepted')
      .where((eb) => eb.or([eb('pullingUntil', 'is', null), eb('pullingUntil', '<', sql<Date>`now()`)]))
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  async renewPull(id: string, ms: number) {
    await this.db
      .updateTable('household_inbound_share')
      .set({ pullingUntil: sql<Date>`now() + ${`${ms} milliseconds`}::interval` })
      .where('id', '=', id)
      .execute();
  }

  /* ------------------------------------- origins ------------------------------------- */

  getOrigin(key: HouseholdOriginKey) {
    return originKey(this.db.selectFrom('household_origin').selectAll(), key).executeTakeFirst();
  }

  /** The first origin for this key wins: a second arrival never takes over a row. */
  async createOrigin(origin: Insertable<HouseholdOriginTable>, db: Kysely<DB> = this.db) {
    await db
      .insertInto('household_origin')
      // the application's clock, as a full read's start is: the two are compared
      .values({ lastSeenAt: new Date(), ...origin })
      .onConflict((oc) => oc.columns(['linkId', 'remoteId', 'kind', 'userId']).doNothing())
      .execute();
  }

  /** The asset, its origin and nothing else commit together, so a copy never exists without its tombstone. */
  publish<T>(write: (tx: Transaction<DB>) => Promise<T>) {
    return this.db.transaction().execute(write);
  }

  updateOrigin(key: HouseholdOriginKey, change: Updateable<HouseholdOriginTable>) {
    return originKey(this.db.updateTable('household_origin').set(change), key).execute();
  }

  async addOriginShare(key: HouseholdOriginKey, shareId: string) {
    await originKey(
      this.db
        .updateTable('household_origin')
        .set({ shareIds: sql<string[]>`array_append("shareIds", ${shareId}::uuid)` })
        .where(sql<boolean>`NOT (${shareId}::uuid = ANY("shareIds"))`),
      key,
    ).execute();
  }

  async markSeen(key: HouseholdOriginKey) {
    await originKey(this.db.updateTable('household_origin').set({ lastSeenAt: new Date() }), key).execute();
  }

  /** Runs `apply` holding the row, re-read, so a recipient's edit cannot interleave with a followed write. */
  withFollowingOrigin(key: HouseholdOriginKey, apply: (origin: HouseholdOrigin, tx: Transaction<DB>) => Promise<void>) {
    return this.db.transaction().execute(async (tx) => {
      const origin = await originKey(tx.selectFrom('household_origin').selectAll(), key).forUpdate().executeTakeFirst();
      if (origin?.followUntilEdited) {
        await apply(origin, tx);
      }
    });
  }

  async stopFollowing(key: HouseholdOriginKey) {
    await originKey(this.db.updateTable('household_origin').set({ followUntilEdited: false }), key).execute();
  }

  /** The stills waiting for this live video part. */
  getWaitingStills(linkId: string, userId: string, motionRemoteId: string) {
    return this.db
      .selectFrom('household_origin')
      .selectAll()
      .where('linkId', '=', linkId)
      .where('userId', '=', userId)
      .where('kind', '=', 'asset')
      .where('pairedRemoteId', '=', motionRemoteId)
      .execute();
  }

  /**
   * This person left this share: it no longer places anything, and whatever no other share of theirs still holds
   * stops following. Rows and local items all stay.
   */
  async leaveOrigins(share: { id: string; linkId: string; userId: string }) {
    const others = await this.db
      .selectFrom('household_inbound_share')
      .select('id')
      .where('linkId', '=', share.linkId)
      .where('userId', '=', share.userId)
      .where('state', '=', 'accepted')
      .where('id', '<>', share.id)
      .execute();
    const live = others.map(({ id }) => id);
    await this.db
      .updateTable('household_origin')
      .set({
        shareIds: sql<string[]>`array_remove("shareIds", ${share.id}::uuid)`,
        followUntilEdited:
          live.length > 0
            ? sql<boolean>`"followUntilEdited" AND (kind = 'person' OR "shareIds" && ${live}::uuid[])`
            : false,
      })
      .where('linkId', '=', share.linkId)
      .where('userId', '=', share.userId)
      .where((eb) => eb.or([sql<boolean>`${share.id}::uuid = ANY("shareIds")`, eb('kind', '=', 'person')]))
      .execute();
    if (live.length === 0) {
      await this.db
        .deleteFrom('household_person_pending')
        .where('linkId', '=', share.linkId)
        .where('userId', '=', share.userId)
        .execute();
    }
  }

  /** A full read finished: items of this share it did not list stop following. They stay. */
  async stopUnseen(share: { id: string; linkId: string; userId: string }, since: Date) {
    await this.db
      .updateTable('household_origin')
      .set({ followUntilEdited: false })
      .where('linkId', '=', share.linkId)
      .where('userId', '=', share.userId)
      .where('kind', '=', 'asset')
      .where('lastSeenAt', '<', since)
      .where(sql<boolean>`${share.id}::uuid = ANY("shareIds")`)
      .execute();
  }

  /* --------------------------------- received files --------------------------------- */

  getReceivedFile(linkId: string, checksum: Buffer) {
    return this.db
      .selectFrom('household_received_file')
      .selectAll()
      .where('linkId', '=', linkId)
      .where('checksum', '=', checksum)
      .executeTakeFirst();
  }

  async saveReceivedFile(linkId: string, checksum: Buffer, path: string, size: number) {
    await this.db
      .insertInto('household_received_file')
      .values({ linkId, checksum, path, size })
      .onConflict((oc) => oc.columns(['linkId', 'checksum']).doUpdateSet({ path, size, receivedAt: sql<Date>`now()` }))
      .execute();
  }

  async deleteReceivedFile(linkId: string, checksum: Buffer) {
    await this.db
      .deleteFrom('household_received_file')
      .where('linkId', '=', linkId)
      .where('checksum', '=', checksum)
      .execute();
  }

  /* -------------------------------------- people -------------------------------------- */

  async savePendingPerson(linkId: string, userId: string, remoteId: string, name: string, faces: HouseholdFaceBox[]) {
    const value = sql<HouseholdFaceBox[]>`${JSON.stringify(faces)}::text::jsonb`;
    await this.db
      .insertInto('household_person_pending')
      .values({ linkId, userId, remoteId, name, faces: value })
      .onConflict((oc) => oc.columns(['linkId', 'userId', 'remoteId']).doUpdateSet({ name, faces: value }))
      .execute();
  }

  async deletePendingPerson(linkId: string, userId: string, remoteId: string) {
    await this.db
      .deleteFrom('household_person_pending')
      .where('linkId', '=', linkId)
      .where('userId', '=', userId)
      .where('remoteId', '=', remoteId)
      .execute();
  }

  // ponytail: fifty people per link per poll, picked at random so entries that never resolve cannot starve the rest
  getPendingPeople(linkId: string) {
    return this.db
      .selectFrom('household_person_pending')
      .selectAll()
      .where('linkId', '=', linkId)
      .orderBy(sql`random()`)
      .limit(50)
      .execute();
  }

  async countPendingPeople(linkId: string, userId: string) {
    const { count } = await this.db
      .selectFrom('household_person_pending')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('linkId', '=', linkId)
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /**
   * The recipient's own detected faces on the copies of these remote items. Only copies this link delivered to this
   * account are looked at, so a manifest can never name a face on anything else in the library.
   */
  async getLocalFaces(linkId: string, userId: string, remoteAssetIds: string[]): Promise<HouseholdLocalFace[]> {
    if (remoteAssetIds.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('household_origin as origin')
      .innerJoin('asset', (join) =>
        join
          .onRef('asset.id', '=', 'origin.localId')
          .on('asset.ownerId', '=', userId)
          .on('asset.deletedAt', 'is', null),
      )
      .innerJoin('asset_face as face', 'face.assetId', 'asset.id')
      .select([
        'face.id',
        'origin.remoteId as remoteAssetId',
        'face.personGroupId',
        'face.correctedAt',
        'face.boundingBoxX1 as x1',
        'face.boundingBoxY1 as y1',
        'face.boundingBoxX2 as x2',
        'face.boundingBoxY2 as y2',
        'face.imageWidth as width',
        'face.imageHeight as height',
      ])
      .where('origin.linkId', '=', linkId)
      .where('origin.userId', '=', userId)
      .where('origin.kind', '=', 'asset')
      .where('origin.isCopy', '=', true)
      .where('origin.remoteId', 'in', remoteAssetIds)
      .where('face.deletedAt', 'is', null)
      .execute() as unknown as Promise<HouseholdLocalFace[]>;
  }

  /** Whether face detection has finished on every local copy of these remote items. */
  async facesDone(linkId: string, userId: string, remoteAssetIds: string[]) {
    if (remoteAssetIds.length === 0) {
      return true;
    }
    const rows = await this.db
      .selectFrom('household_origin as origin')
      .innerJoin('asset', 'asset.id', 'origin.localId')
      .leftJoin('asset_job_status as status', 'status.assetId', 'asset.id')
      .select(['origin.remoteId', 'status.facesRecognizedAt'])
      .where('origin.linkId', '=', linkId)
      .where('origin.userId', '=', userId)
      .where('origin.kind', '=', 'asset')
      .where('origin.remoteId', 'in', remoteAssetIds)
      .execute();
    return rows.length === new Set(remoteAssetIds).size && rows.every((row) => !!row.facesRecognizedAt);
  }

  /** A new person of the recipient's, in their recognition group, as a partner's person copy is made. */
  createPerson(ownerId: string, name: string) {
    return this.db.transaction().execute(async (tx) => {
      const group = await tx
        .insertInto('person_group')
        .columns(['clusterGroupId'])
        .expression((eb) => eb.selectFrom('user').select('clusterGroupId').where('id', '=', ownerId))
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.insertInto('person').values({ ownerId, personGroupId: group.id, name }).execute();
      return group.id;
    });
  }

  /** Date fields of a followed copy, in the caller's transaction. */
  async setAssetDates(tx: Transaction<DB>, id: string, fileCreatedAt: Date, localDateTime: Date) {
    await tx.updateTable('asset').set({ fileCreatedAt, localDateTime }).where('id', '=', id).execute();
  }
}
