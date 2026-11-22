import { Injectable } from '@nestjs/common';
import { type Kysely, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AlbumKind, AlbumUserRole, AssetType, AssetVisibility, UserStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { hiddenFromSession } from 'src/utils/database.js';
import { everyOwnersRules } from 'src/utils/hidden-content.js';

export const HOUSEHOLD_SHARES_PER_LINK = 200;
export const HOUSEHOLD_MEMBERS_PER_SHARE = 50;
/** ponytail: a person's manifest entry names at most this many faces, which keeps one entry far below a page. */
const HOUSEHOLD_FACES_PER_PERSON = 5000;
/** ponytail: the directory lists at most this many accounts, which keeps its reply under the client's cap. */
const DIRECTORY_LIMIT = 1000;

const uuidArray = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;
const moveRow = sql`on conflict ("shareId", kind, "entityId") do update set seq = default, "changedAt" = now()`;

/** FL-979: the shares of spaces offered to linked households, their remote members and their change feed. */
@Injectable()
export class HouseholdShareRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Feed writers take one lock, so `seq` order is commit order: a reader's cursor can never pass a row that an
   * open transaction has yet to commit.
   */
  private inFeed<T>(action: (trx: Transaction<DB>) => Promise<T>) {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(-979, 1)`.execute(trx);
      return action(trx);
    });
  }

  async hasShares() {
    return !!(await this.db.selectFrom('household_share').select('id').limit(1).executeTakeFirst());
  }

  /** A share of a live space, only when it belongs to this link. */
  getShare(linkId: string, shareId: string) {
    return this.db
      .selectFrom('household_share')
      .innerJoin('album', 'album.id', 'household_share.albumId')
      .select(['household_share.id', 'household_share.albumId', 'household_share.linkId'])
      .where('household_share.id', '=', shareId)
      .where('household_share.linkId', '=', linkId)
      .where('album.deletedAt', 'is', null)
      .where('album.kind', '=', AlbumKind.Space)
      .executeTakeFirst();
  }

  getSharesOfAlbum(albumId: string) {
    return this.db.selectFrom('household_share').selectAll().where('albumId', '=', albumId).execute();
  }

  /** What `GET shares` says about each share offered over this link. */
  getOffered(linkId: string) {
    return this.db
      .selectFrom('household_share')
      .innerJoin('album', 'album.id', 'household_share.albumId')
      .innerJoin('album_user', (join) =>
        join.onRef('album_user.albumId', '=', 'album.id').on('album_user.role', '=', AlbumUserRole.Owner),
      )
      .innerJoin('user', 'user.id', 'album_user.userId')
      .select(['household_share.id', 'album.albumName', 'album.description', 'user.name as ownerName'])
      .where('household_share.linkId', '=', linkId)
      .where('album.deletedAt', 'is', null)
      .where('album.kind', '=', AlbumKind.Space)
      .orderBy('household_share.id')
      .execute();
  }

  getMembers(shareIds: string[]) {
    if (shareIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('household_share_member')
      .selectAll()
      .where('shareId', 'in', shareIds)
      .orderBy('invitedAt')
      .orderBy('remoteUserId')
      .execute();
  }

  getMember(shareId: string, remoteUserId: string) {
    return this.db
      .selectFrom('household_share_member')
      .selectAll()
      .where('shareId', '=', shareId)
      .where('remoteUserId', '=', remoteUserId)
      .executeTakeFirst();
  }

  async hasAcceptedMember(shareId: string) {
    const row = await this.db
      .selectFrom('household_share_member')
      .select('remoteUserId')
      .where('shareId', '=', shareId)
      .where('acceptedAt', 'is not', null)
      .where('leftAt', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /**
   * Adds a member, creating and seeding the share on first use. Counts and writes hold the feed lock, so two
   * invitations cannot pass a limit together. Inviting someone who left starts them again as invited.
   */
  invite(member: { albumId: string; linkId: string; remoteUserId: string; displayName: string; role: string }) {
    return this.inFeed(async (trx) => {
      let share = await trx
        .selectFrom('household_share')
        .select('id')
        .where('albumId', '=', member.albumId)
        .where('linkId', '=', member.linkId)
        .executeTakeFirst();
      if (!share) {
        const { count } = await trx
          .selectFrom('household_share')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('linkId', '=', member.linkId)
          .executeTakeFirstOrThrow();
        if (Number(count) >= HOUSEHOLD_SHARES_PER_LINK) {
          return 'share-limit' as const;
        }
        share = await trx
          .insertInto('household_share')
          .values({ albumId: member.albumId, linkId: member.linkId })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.addMissing(trx, member.albumId);
      }
      const { count } = await trx
        .selectFrom('household_share_member')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('shareId', '=', share.id)
        .where('leftAt', 'is', null)
        .where('remoteUserId', '!=', member.remoteUserId)
        .executeTakeFirstOrThrow();
      if (Number(count) >= HOUSEHOLD_MEMBERS_PER_SHARE) {
        return 'member-limit' as const;
      }
      await trx
        .insertInto('household_share_member')
        .values({
          shareId: share.id,
          remoteUserId: member.remoteUserId,
          displayName: member.displayName,
          role: member.role,
        })
        .onConflict((oc) =>
          oc.columns(['shareId', 'remoteUserId']).doUpdateSet({
            displayName: member.displayName,
            role: member.role,
            acceptedAt: sql<Date | null>`case when household_share_member."leftAt" is null then household_share_member."acceptedAt" end`,
            leftAt: null,
          }),
        )
        .execute();
      return share.id;
    });
  }

  async setRole(albumId: string, shareId: string, remoteUserId: string, role: string) {
    const updated = await this.db
      .updateTable('household_share_member')
      .set({ role })
      .where('shareId', '=', shareId)
      .where('remoteUserId', '=', remoteUserId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('household_share')
            .select('household_share.id')
            .where('household_share.id', '=', shareId)
            .where('household_share.albumId', '=', albumId),
        ),
      )
      .returning('remoteUserId')
      .executeTakeFirst();
    return !!updated;
  }

  /** Removing the last member removes the share, and its feed with it. */
  removeMember(albumId: string, shareId: string, remoteUserId: string) {
    return this.db.transaction().execute(async (trx) => {
      const share = await trx
        .selectFrom('household_share')
        .select('id')
        .where('id', '=', shareId)
        .where('albumId', '=', albumId)
        .forUpdate()
        .executeTakeFirst();
      if (!share) {
        return false;
      }
      const removed = await trx
        .deleteFrom('household_share_member')
        .where('shareId', '=', shareId)
        .where('remoteUserId', '=', remoteUserId)
        .returning('remoteUserId')
        .executeTakeFirst();
      if (!removed) {
        return false;
      }
      const left = await trx
        .selectFrom('household_share_member')
        .select('remoteUserId')
        .where('shareId', '=', shareId)
        .limit(1)
        .executeTakeFirst();
      if (!left) {
        await trx.deleteFrom('household_share').where('id', '=', shareId).execute();
      }
      return true;
    });
  }

  async accept(shareId: string, remoteUserId: string) {
    const updated = await this.db
      .updateTable('household_share_member')
      .set({ acceptedAt: sql<Date>`coalesce("acceptedAt", now())` })
      .where('shareId', '=', shareId)
      .where('remoteUserId', '=', remoteUserId)
      .where('leftAt', 'is', null)
      .returning('remoteUserId')
      .executeTakeFirst();
    return !!updated;
  }

  async leave(shareId: string, remoteUserId: string) {
    const updated = await this.db
      .updateTable('household_share_member')
      .set({ leftAt: sql<Date>`coalesce("leftAt", now())` })
      .where('shareId', '=', shareId)
      .where('remoteUserId', '=', remoteUserId)
      .returning('remoteUserId')
      .executeTakeFirst();
    return !!updated;
  }

  /* ------------------------------ the change feed: written ------------------------------ */

  /** A row for every item and linked person of the album that has none. Existing rows keep their `seq`. */
  private async addMissing(trx: Kysely<DB>, albumId: string) {
    await sql`
      insert into household_share_change ("shareId", kind, "entityId")
      select distinct hs.id, 'asset', item.id
      from household_share hs
      inner join album_asset on album_asset."albumId" = hs."albumId"
      inner join asset still on still.id = album_asset."assetId"
      cross join lateral (values (still.id), (still."livePhotoVideoId")) as item(id)
      where hs."albumId" = ${albumId}::uuid and item.id is not null
      on conflict ("shareId", kind, "entityId") do nothing
    `.execute(trx);
    await sql`
      insert into household_share_change ("shareId", kind, "entityId")
      select hs.id, 'person', link.id
      from household_share hs
      inner join shared_space_person link on link."albumId" = hs."albumId"
      where hs."albumId" = ${albumId}::uuid
      on conflict ("shareId", kind, "entityId") do nothing
    `.execute(trx);
    // after the items, so a first read meets an item before the comments on it
    await sql`
      insert into household_share_change ("shareId", kind, "entityId", "assetId")
      select hs.id, 'comment', activity.id, activity."assetId"
      from household_share hs
      inner join activity on activity."albumId" = hs."albumId"
      where hs."albumId" = ${albumId}::uuid
      on conflict ("shareId", kind, "entityId") do nothing
    `.execute(trx);
  }

  /** The comment rows of these items move after them: an item is always read before the comments on it. */
  private async touchCommentsOn(trx: Kysely<DB>, assetIds: string[]) {
    await sql`
      insert into household_share_change ("shareId", kind, "entityId", "assetId")
      select change."shareId", change.kind, change."entityId", change."assetId"
      from household_share_change change
      where change.kind = 'comment' and change."assetId" = any(${uuidArray(assetIds)})
      ${moveRow}
    `.execute(trx);
  }

  /** Comments written, edited or removed in this space. A removed one keeps its row and reads as `stop`. */
  async touchComments(albumId: string, ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    await this.inFeed(async (trx) => {
      await sql`
        insert into household_share_change ("shareId", kind, "entityId", "assetId")
        select hs.id, 'comment', target.id, activity."assetId"
        from household_share hs
        cross join unnest(${uuidArray(ids)}) as target(id)
        left join activity on activity.id = target.id
        where hs."albumId" = ${albumId}::uuid
        ${moveRow}
      `.execute(trx);
    });
  }

  /** New items of a space, for album writes that name no items. */
  async seedAlbum(albumId: string) {
    if ((await this.getSharesOfAlbum(albumId)).length > 0) {
      await this.inFeed((trx) => this.addMissing(trx, albumId));
    }
  }

  /**
   * Moves these items to a new `seq` in every share that holds them or has named them, with their live-photo
   * video parts and the linked people whose faces are on them. A removed item keeps its row, so it is re-read.
   */
  async touchAssets(ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    await this.inFeed(async (trx) => {
      await sql`
        with targets as (
          select target.id from unnest(${uuidArray(ids)}) as target(id)
          union
          select asset."livePhotoVideoId" from asset
          where asset.id = any(${uuidArray(ids)}) and asset."livePhotoVideoId" is not null
        )
        insert into household_share_change ("shareId", kind, "entityId")
        select distinct hs.id, 'asset', targets.id
        from household_share hs
        cross join targets
        where exists (
            select 1 from album_asset
            where album_asset."albumId" = hs."albumId" and album_asset."assetId" = targets.id
          )
          or exists (
            select 1 from asset still
            inner join album_asset on album_asset."assetId" = still.id
            where still."livePhotoVideoId" = targets.id and album_asset."albumId" = hs."albumId"
          )
          or exists (
            select 1 from household_share_change named
            where named."shareId" = hs.id and named.kind = 'asset' and named."entityId" = targets.id
          )
        ${moveRow}
      `.execute(trx);
      await sql`
        insert into household_share_change ("shareId", kind, "entityId")
        select distinct hs.id, 'person', link.id
        from household_share hs
        inner join shared_space_person link on link."albumId" = hs."albumId"
        inner join asset_face face on face."personGroupId" = link."personGroupId"
        where face."assetId" = any(${uuidArray(ids)})
        ${moveRow}
      `.execute(trx);
      await this.touchCommentsOn(trx, ids);
    });
  }

  /** A person was linked to or unlinked from a space. */
  async touchPerson(albumId: string, personLinkId: string) {
    await this.inFeed(async (trx) => {
      await sql`
        insert into household_share_change ("shareId", kind, "entityId")
        select hs.id, 'person', ${personLinkId}::uuid
        from household_share hs
        where hs."albumId" = ${albumId}::uuid
        ${moveRow}
      `.execute(trx);
    });
  }

  /** An owner's Locked rules changed: every row of theirs, and the people of the shares holding them, in one statement. */
  async touchOwner(ownerId: string) {
    await this.inFeed(async (trx) => {
      await sql`
        with owned as (
          select change."shareId", change.kind, change."entityId"
          from household_share_change change
          inner join asset on asset.id = change."entityId"
          where change.kind = 'asset' and asset."ownerId" = ${ownerId}::uuid
        )
        insert into household_share_change ("shareId", kind, "entityId")
        select "shareId", kind, "entityId" from owned
        union
        select people."shareId", people.kind, people."entityId"
        from household_share_change people
        where people.kind = 'person' and people."shareId" in (select "shareId" from owned)
        ${moveRow}
      `.execute(trx);
      await sql`
        insert into household_share_change ("shareId", kind, "entityId", "assetId")
        select change."shareId", change.kind, change."entityId", change."assetId"
        from household_share_change change
        inner join asset on asset.id = change."assetId"
        where change.kind = 'comment' and asset."ownerId" = ${ownerId}::uuid
        ${moveRow}
      `.execute(trx);
    });
  }

  /* ------------------------------ the change feed: read ------------------------------ */

  getChanges(shareId: string, cursor: number, take: number) {
    return this.db
      .selectFrom('household_share_change')
      .select(['seq', 'kind', 'entityId'])
      .where('shareId', '=', shareId)
      .where('seq', '>', cursor)
      .orderBy('seq', 'asc')
      .limit(take)
      .execute();
  }

  async getLastSeq(shareId: string) {
    const row = await this.db
      .selectFrom('household_share_change')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .where('shareId', '=', shareId)
      .executeTakeFirst();
    return Number(row?.seq ?? 0);
  }

  /** The fields a manifest may carry, and nothing else: no path, owner, device, favourite or sensitive column. */
  getAssets(ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.type',
        'asset.originalFileName',
        'asset.checksum',
        'asset.fileCreatedAt',
        'asset.localDateTime',
        'asset.width',
        'asset.height',
        'asset.duration',
        'asset.livePhotoVideoId',
        'asset.stackId',
        'asset.updatedAt',
        'asset_exif.fileSizeInByte',
        'asset_exif.timeZone',
        'asset_exif.description',
        'asset_exif.rating',
        'asset_exif.latitude',
        'asset_exif.longitude',
        'asset_exif.city',
        'asset_exif.state',
        'asset_exif.country',
      ])
      .where('asset.id', 'in', ids)
      .execute();
  }

  getStacks(stackIds: string[]) {
    if (stackIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('stack')
      .innerJoin('asset', 'asset.stackId', 'stack.id')
      .select(['stack.id as stackId', 'stack.primaryAssetId', 'asset.id as assetId'])
      .where('stack.id', 'in', stackIds)
      .execute();
  }

  /**
   * Of these ids, the live-photo video parts that are themselves fit to share, with their still. A part is
   * stored `hidden` and outside the album, so the space query cannot match it; the caller checks the still with
   * that query. Same owner, not trashed, not Locked, no Locked-rule or sensitive match on the part itself.
   */
  getMotionParts(ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('asset as motion')
      .innerJoin('asset as still', (join) =>
        join.onRef('still.livePhotoVideoId', '=', 'motion.id').onRef('still.ownerId', '=', 'motion.ownerId'),
      )
      .select(['motion.id as id', 'still.id as stillId'])
      .where('motion.id', 'in', ids)
      .where('motion.type', '=', AssetType.Video)
      .where('motion.visibility', '=', AssetVisibility.Hidden)
      .where('motion.deletedAt', 'is', null)
      .where(sql<boolean>`not ${hiddenFromSession({ excludeNsfw: true, ...everyOwnersRules }, 'motion')}`)
      .execute();
  }

  getOriginal(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'originalPath', 'checksum'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  getPersonLinks(albumId: string, ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('shared_space_person as link')
      .innerJoin('person', (join) =>
        join
          .onRef('person.ownerId', '=', 'link.personOwnerId')
          .onRef('person.personGroupId', '=', 'link.personGroupId'),
      )
      .select(['link.id', 'link.name', 'link.personOwnerId', 'link.personGroupId'])
      .where('link.albumId', '=', albumId)
      .where('link.id', 'in', ids)
      .execute();
  }

  /** Face boxes of this person on items of the space. The caller keeps those on visible items only. */
  getPersonFaces(albumId: string, personGroupId: string) {
    return this.db
      .selectFrom('asset_face')
      .innerJoin('album_asset', 'album_asset.assetId', 'asset_face.assetId')
      .select([
        'asset_face.assetId',
        'asset_face.boundingBoxX1',
        'asset_face.boundingBoxY1',
        'asset_face.boundingBoxX2',
        'asset_face.boundingBoxY2',
        'asset_face.imageWidth',
        'asset_face.imageHeight',
      ])
      .where('album_asset.albumId', '=', albumId)
      .where('asset_face.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .orderBy('asset_face.id')
      .limit(HOUSEHOLD_FACES_PER_PERSON)
      .execute();
  }

  /** Active accounts as the other household may see them. Selects no email. */
  getDirectory() {
    return this.db
      .selectFrom('user')
      .select(['id', 'name', 'profileImagePath'])
      .where('deletedAt', 'is', null)
      .where('status', '=', UserStatus.Active)
      .orderBy('name')
      .orderBy('id')
      .limit(DIRECTORY_LIMIT)
      .execute();
  }

  getDirectoryUser(id: string) {
    return this.db
      .selectFrom('user')
      .select(['id', 'profileImagePath'])
      .where('id', '=', id)
      .where('deletedAt', 'is', null)
      .where('status', '=', UserStatus.Active)
      .executeTakeFirst();
  }
}
