import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { SharedSpaceEventType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { parseMentions } from 'src/utils/shared-space.js';

export type HouseholdRemoteComment = {
  id?: string;
  albumId: string;
  assetId: string | null;
  remoteAuthorId: string;
  isLiked: boolean;
  comment: string | null;
  createdAt?: Date;
};

/** FL-1012: comments and likes that cross a household link, on both sides of it. */
@Injectable()
export class HouseholdCommentRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /* --------------------------------- either side --------------------------------- */

  /** One author row per person per link. The name is whatever the caller has already cleaned. */
  async upsertAuthor(linkId: string, remoteUserId: string, displayName: string) {
    const { id } = await this.db
      .insertInto('household_remote_author')
      .values({ linkId, remoteUserId, displayName })
      .onConflict((oc) => oc.columns(['linkId', 'remoteUserId']).doUpdateSet({ displayName }))
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  }

  /** An activity row with who wrote it, for the author checks. */
  getActivity(id: string) {
    return this.db
      .selectFrom('activity')
      .leftJoin('household_remote_author as author', 'author.id', 'activity.remoteAuthorId')
      .select([
        'activity.id',
        'activity.albumId',
        'activity.assetId',
        'activity.userId',
        'activity.remoteAuthorId',
        'activity.isLiked',
        'activity.comment',
        'author.linkId as authorLinkId',
        'author.remoteUserId as authorRemoteUserId',
      ])
      .where('activity.id', '=', id)
      .executeTakeFirst();
  }

  private insertRemote(db: Kysely<DB>, comment: HouseholdRemoteComment) {
    return db
      .insertInto('activity')
      .values({ ...comment, userId: null })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
  }

  /** Undefined when the id is taken or this person already likes that. */
  createRemote(comment: HouseholdRemoteComment) {
    return this.insertRemote(this.db, comment);
  }

  async updateText(id: string, comment: string) {
    await this.db.updateTable('activity').set({ comment }).where('id', '=', id).execute();
  }

  async deleteActivity(id: string) {
    await this.db.deleteFrom('activity').where('id', '=', id).execute();
  }

  /** A remote comment in the space's own feed. It has no local actor, so the sentence carries no account. */
  async addEvent(albumId: string, activityId: string, isLiked: boolean) {
    await this.db
      .insertInto('shared_space_event')
      .values({
        albumId,
        actorId: null,
        type: isLiked ? SharedSpaceEventType.Like : SharedSpaceEventType.Comment,
        activityId,
      })
      .execute();
  }

  /**
   * Stores the mentions in `text` that name a current member of this local space, and returns those not mentioned
   * before. An id of the other household, or of an account outside this space, is ignored: nobody here is told.
   */
  async setMentions(activityId: string, albumId: string, text: string) {
    const named = parseMentions(text);
    const members =
      named.length === 0
        ? []
        : await this.db
            .selectFrom('album_user')
            .select('userId')
            .where('albumId', '=', albumId)
            .where('userId', 'in', named)
            .execute();
    const previous = await this.db
      .deleteFrom('shared_space_mention')
      .where('activityId', '=', activityId)
      .returning('userId')
      .execute();
    if (members.length > 0) {
      await this.db
        .insertInto('shared_space_mention')
        .values(members.map(({ userId }) => ({ activityId, userId })))
        .execute();
    }
    const known = new Set(previous.map(({ userId }) => userId));
    return members.map(({ userId }) => userId).filter((userId) => !known.has(userId));
  }

  /* ------------------------------------- sender ------------------------------------- */

  /** A body may never act as one of this server's accounts, even one that is deleted. */
  async isLocalUser(id: string) {
    return !!(await this.db.selectFrom('user').select('id').where('id', '=', id).executeTakeFirst());
  }

  /** Comments of this space with their author, for the manifest. Selects no email. */
  getComments(albumId: string, ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('activity')
      .leftJoin('user', (join) => join.onRef('user.id', '=', 'activity.userId').on('user.deletedAt', 'is', null))
      .leftJoin('household_remote_author as author', 'author.id', 'activity.remoteAuthorId')
      .select([
        'activity.id',
        'activity.assetId',
        'activity.isLiked',
        'activity.comment',
        'activity.createdAt',
        'activity.updatedAt',
        'user.id as localId',
        'user.name as localName',
        'author.remoteUserId',
        'author.displayName as remoteName',
      ])
      .where('activity.albumId', '=', albumId)
      .where('activity.id', 'in', ids)
      .where((eb) => eb.or([eb('user.id', 'is not', null), eb('author.id', 'is not', null)]))
      .execute();
  }

  /** This author's earlier like on the same thing, replaced by a like under a new id. */
  async removeRemoteLikes(albumId: string, assetId: string | null, remoteAuthorId: string) {
    const rows = await this.db
      .deleteFrom('activity')
      .where('albumId', '=', albumId)
      .where('remoteAuthorId', '=', remoteAuthorId)
      .where('isLiked', '=', true)
      .where(sql<boolean>`"assetId" is not distinct from ${assetId}::uuid`)
      .returning('id')
      .execute();
    return rows.map(({ id }) => id);
  }

  /* ------------------------------------ receiver ------------------------------------ */

  getLink(inboundShareId: string, remoteId: string) {
    return this.db
      .selectFrom('household_comment')
      .selectAll()
      .where('inboundShareId', '=', inboundShareId)
      .where('remoteId', '=', remoteId)
      .executeTakeFirst();
  }

  async deleteLink(inboundShareId: string, remoteId: string) {
    await this.db
      .deleteFrom('household_comment')
      .where('inboundShareId', '=', inboundShareId)
      .where('remoteId', '=', remoteId)
      .execute();
  }

  async countLinks(inboundShareId: string) {
    const { count } = await this.db
      .selectFrom('household_comment')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('inboundShareId', '=', inboundShareId)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** The activity row and its link commit together, so a retried page cannot post the copy twice. */
  createCopy(inboundShareId: string, remoteId: string, comment: HouseholdRemoteComment) {
    return this.db.transaction().execute(async (tx) => {
      const row = await this.insertRemote(tx, comment);
      if (row) {
        await tx.insertInto('household_comment').values({ inboundShareId, remoteId, activityId: row.id }).execute();
      }
      return row;
    });
  }

  getAcceptedShareOfAlbum(albumId: string) {
    return this.db
      .selectFrom('household_inbound_share')
      .selectAll()
      .where('albumId', '=', albumId)
      .where('state', '=', 'accepted')
      .executeTakeFirst();
  }

  /** The local copy of a sender's item, only if this link delivered it to this account and it is in this space. */
  async getLocalAsset(linkId: string, userId: string, remoteAssetId: string, albumId: string) {
    const row = await this.db
      .selectFrom('household_origin as origin')
      .innerJoin('album_asset', (join) =>
        join.onRef('album_asset.assetId', '=', 'origin.localId').on('album_asset.albumId', '=', albumId),
      )
      .select('origin.localId')
      .where('origin.linkId', '=', linkId)
      .where('origin.userId', '=', userId)
      .where('origin.kind', '=', 'asset')
      .where('origin.remoteId', '=', remoteAssetId)
      .executeTakeFirst();
    return row?.localId;
  }

  /** The sender's id for a local item, only if it came from this inbound share. */
  async getRemoteAsset(linkId: string, userId: string, shareId: string, localAssetId: string) {
    const row = await this.db
      .selectFrom('household_origin')
      .select('remoteId')
      .where('linkId', '=', linkId)
      .where('userId', '=', userId)
      .where('kind', '=', 'asset')
      .where('localId', '=', localAssetId)
      .where(sql<boolean>`${shareId}::uuid = ANY("shareIds")`)
      .executeTakeFirst();
    return row?.remoteId;
  }

  /** Queue a local change for the sender. The id on the wire is the local activity id. */
  async queue(inboundShareId: string, remoteId: string, pending: 'post' | 'put' | 'delete', activityId?: string) {
    await this.db
      .insertInto('household_comment')
      .values({ inboundShareId, remoteId, activityId, own: true, pending })
      .onConflict((oc) =>
        oc.columns(['inboundShareId', 'remoteId']).doUpdateSet({
          pending,
          revision: sql<number>`household_comment.revision + 1`,
          attempts: 0,
          nextAttemptAt: null,
        }),
      )
      .execute();
  }

  /** Local changes due to be sent, for shares still accepted. A share that was left sends nothing more. */
  getDue(linkId: string, limit: number) {
    return this.db
      .selectFrom('household_comment as queued')
      .innerJoin('household_inbound_share as share', 'share.id', 'queued.inboundShareId')
      .selectAll('queued')
      .select(['share.remoteShareId', 'share.userId', 'share.linkId'])
      .where('share.linkId', '=', linkId)
      .where('share.state', '=', 'accepted')
      .where('queued.pending', 'is not', null)
      .where((eb) =>
        eb.or([eb('queued.nextAttemptAt', 'is', null), eb('queued.nextAttemptAt', '<=', sql<Date>`now()`)]),
      )
      .orderBy(sql`queued."nextAttemptAt" asc nulls first`)
      .limit(limit)
      .execute();
  }

  /** Clears the send only if nothing newer was queued while it was on its way. */
  async markSent(inboundShareId: string, remoteId: string, revision: number) {
    await this.db
      .updateTable('household_comment')
      .set({ pending: null, attempts: 0, nextAttemptAt: null })
      .where('inboundShareId', '=', inboundShareId)
      .where('remoteId', '=', remoteId)
      .where('revision', '=', revision)
      .execute();
  }

  async retryLater(inboundShareId: string, remoteId: string, attempts: number, nextAttemptAt: Date) {
    await this.db
      .updateTable('household_comment')
      .set({ attempts, nextAttemptAt })
      .where('inboundShareId', '=', inboundShareId)
      .where('remoteId', '=', remoteId)
      .execute();
  }
}
