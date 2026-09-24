import { BadRequestException, Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole, SharedSpaceEventType } from 'src/enum.js';
import { canWriteFork, lockForkWrites } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';
import { AlbumUserTable } from 'src/schema/tables/album-user.table.js';
import { SharedSpaceAlbumTable } from 'src/schema/tables/shared-space-album.table.js';
import { SharedSpaceCommentThreadTable } from 'src/schema/tables/shared-space-comment-thread.table.js';
import { SharedSpaceEventTable } from 'src/schema/tables/shared-space-event.table.js';
import { SharedSpaceInviteTable } from 'src/schema/tables/shared-space-invite.table.js';
import { SharedSpacePersonTable } from 'src/schema/tables/shared-space-person.table.js';
import { withDefaultVisibility, withHiddenContentFilter } from 'src/utils/database.js';
import { isLocked } from 'src/utils/locked.js';

export type AlbumPermissionId = {
  albumId: string;
  userId: string;
};

/** The most recipient groups one person may keep (FL-55). */
export const RECIPIENT_GROUP_LIMIT = 100;

/**
 * A named recipient shortcut (FL-55): the owner's own saved list of people to invite together.
 * It grants nothing and is never shown to anyone but its owner.
 */
export type RecipientGroup = {
  id: string;
  ownerId: string;
  name: string;
  userIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

/** A pending invitation to a shared space. It grants nothing until accepted. */
export type SharedSpaceInvite = {
  albumId: string;
  userId: string;
  role: AlbumUserRole;
  invitedById: string | null;
  createdAt: Date;
};

/** One album a member pointed at from a shared space. The album itself is untouched. */
export type SharedSpaceAlbumLink = {
  albumId: string;
  linkedAlbumId: string;
  linkedAlbumName: string;
  linkedAlbumIcon: string | null;
  linkedById: string | null;
  createdAt: Date;
};

/** How much of a linked album is actually in the space, for the viewer. */
export type SharedSpaceLinkedAlbumCount = {
  albumId: string;
  assetCount: number;
  thumbnailAssetId: string | null;
};

/**
 * One person a member linked into a shared space. `personOwnerId` and
 * `personGroupId` say whose person it is and are never sent to a client;
 * `name` and `coverAssetId` are the space's own identity for them.
 */
export type SharedSpacePersonLink = {
  id: string;
  albumId: string;
  personOwnerId: string;
  personGroupId: string;
  name: string;
  coverAssetId: string | null;
  createdAt: Date;
};

/** A person of the viewer's own, seen on assets that are in the space. */
export type SharedSpacePersonCandidate = {
  personGroupId: string;
  name: string;
  thumbnailPath: string;
  isHidden: boolean;
  isFavorite: boolean;
  color: string | null;
  birthDate: Date | null;
  updatedAt: Date;
  assetCount: number;
};

/** One member's last-seen marker for one shared space. */
export type SharedSpaceVisit = {
  albumId: string;
  userId: string;
  lastSeenAt: Date;
};

/**
 * One stored feed event, as read back. `activityAssetId` and `activityComment`
 * come from the joined `activity` row of a comment or like event and are null
 * otherwise. Ids only: the service decides per viewer what may leave.
 */
export type SharedSpaceEvent = {
  id: string;
  albumId: string;
  actorId: string | null;
  type: SharedSpaceEventType;
  targetUserId: string | null;
  activityId: string | null;
  assetIds: string[];
  subject: string | null;
  createdAt: Date;
  activityAssetId: string | null;
  activityComment: string | null;
};

/** A member named in a comment. */
export type SharedSpaceMention = {
  activityId: string;
  userId: string;
};

/** A reply, and the top-level comment it answers. */
export type SharedSpaceCommentThread = {
  activityId: string;
  parentActivityId: string;
};

@Injectable()
export class AlbumUserRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** FL-55: one owner's named recipient shortcuts, by name. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getRecipientGroups(ownerId: string): Promise<RecipientGroup[]> {
    const { rows } = await sql<RecipientGroup>`
      SELECT id::text AS id, "ownerId"::text AS "ownerId", name, "userIds"::text[] AS "userIds", "createdAt", "updatedAt"
      FROM immich_fork.recipient_group
      WHERE "ownerId" = ${ownerId}::uuid
      ORDER BY lower(name), id
    `.execute(this.db);
    return rows;
  }

  /** FL-55: a shortcut, only when `ownerId` owns it — anyone else's reads as not found. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async getRecipientGroup(ownerId: string, id: string): Promise<RecipientGroup | undefined> {
    const { rows } = await sql<RecipientGroup>`
      SELECT id::text AS id, "ownerId"::text AS "ownerId", name, "userIds"::text[] AS "userIds", "createdAt", "updatedAt"
      FROM immich_fork.recipient_group
      WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}::uuid
    `.execute(this.db);
    return rows[0];
  }

  /**
   * FL-55: saves a named shortcut. Writes only the shortcut itself — never an album user, an
   * invitation or any other grant — through the fork-writer guard like every fork-owned table.
   */
  async createRecipientGroup(ownerId: string, name: string, userIds: string[]): Promise<RecipientGroup> {
    return this.db.transaction().execute(async (tx) => {
      await lockForkWrites(tx, 'Recipient groups are unavailable during database handoff');
      // One owner's groups are counted under a per-owner lock, so two saves cannot both pass the cap.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recipient_group:${ownerId}`}, 0))`.execute(tx);
      const { rows: counted } = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM immich_fork.recipient_group WHERE "ownerId" = ${ownerId}::uuid
      `.execute(tx);
      if ((counted[0]?.count ?? 0) >= RECIPIENT_GROUP_LIMIT) {
        throw new BadRequestException(`You can keep up to ${RECIPIENT_GROUP_LIMIT} recipient groups`);
      }
      const { rows } = await sql<RecipientGroup>`
        INSERT INTO immich_fork.recipient_group ("ownerId", name, "userIds")
        VALUES (${ownerId}::uuid, ${name}, ${userIds}::uuid[])
        RETURNING id::text AS id, "ownerId"::text AS "ownerId", name, "userIds"::text[] AS "userIds", "createdAt", "updatedAt"
      `.execute(tx);
      return rows[0];
    });
  }

  /** FL-55: renames or re-lists an owner's shortcut; undefined when it is not theirs. */
  async updateRecipientGroup(
    ownerId: string,
    id: string,
    { name, userIds }: { name?: string; userIds?: string[] },
  ): Promise<RecipientGroup | undefined> {
    return this.db.transaction().execute(async (tx) => {
      await lockForkWrites(tx, 'Recipient groups are unavailable during database handoff');
      const { rows } = await sql<RecipientGroup>`
        UPDATE immich_fork.recipient_group
        SET name = coalesce(${name ?? null}::text, name),
            "userIds" = coalesce(${userIds ?? null}::uuid[], "userIds"),
            "updatedAt" = clock_timestamp()
        WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}::uuid
        RETURNING id::text AS id, "ownerId"::text AS "ownerId", name, "userIds"::text[] AS "userIds", "createdAt", "updatedAt"
      `.execute(tx);
      return rows[0];
    });
  }

  /**
   * FL-55: a deleted account leaves no recipient data behind — its own groups go, and it is taken
   * out of everyone else's. Skipped (never blocking the delete) while the fork schema is not
   * writable; reading a group already leaves out people who no longer exist.
   */
  async forgetRecipient(userId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      if (!(await canWriteFork(tx))) {
        return;
      }
      await sql`DELETE FROM immich_fork.recipient_group WHERE "ownerId" = ${userId}::uuid`.execute(tx);
      await sql`
        UPDATE immich_fork.recipient_group
        SET "userIds" = array_remove("userIds", ${userId}::uuid), "updatedAt" = clock_timestamp()
        WHERE ${userId}::uuid = ANY("userIds")
      `.execute(tx);
    });
  }

  /** FL-55: deletes an owner's shortcut; false when it is not theirs. Nobody's access changes. */
  async deleteRecipientGroup(ownerId: string, id: string): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await lockForkWrites(tx, 'Recipient groups are unavailable during database handoff');
      const { numAffectedRows } = await sql`
        DELETE FROM immich_fork.recipient_group WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}::uuid
      `.execute(tx);
      return (numAffectedRows ?? 0n) > 0n;
    });
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, albumId: DummyValue.UUID }] })
  create(albumUser: Insertable<AlbumUserTable>) {
    return this.db
      .insertInto('album_user')
      .values(albumUser)
      .returning(['userId', 'albumId', 'role'])
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, albumId: DummyValue.UUID }, { role: AlbumUserRole.Viewer }] })
  async update({ userId, albumId }: AlbumPermissionId, dto: Updateable<AlbumUserTable>) {
    await this.db
      .updateTable('album_user')
      .set(dto)
      .where('userId', '=', userId)
      .where('albumId', '=', albumId)
      .execute();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, albumId: DummyValue.UUID }] })
  async delete({ userId, albumId }: AlbumPermissionId): Promise<void> {
    await this.db.deleteFrom('album_user').where('userId', '=', userId).where('albumId', '=', albumId).execute();
  }

  /* ------------------------------------------------------------------ */
  /* Shared space invitations (FL-55)                                    */
  /*                                                                     */
  /* A pending invitation is deliberately not an `album_user` row: until */
  /* the recipient accepts they hold no membership at all, so no access  */
  /* check, listing, sync feed or activity rule can reach the space      */
  /* through it. Accepting is the only thing that creates membership.    */
  /* ------------------------------------------------------------------ */

  /** Create or replace the pending invitation for one person. */
  async createInvite(invite: Insertable<SharedSpaceInviteTable>): Promise<SharedSpaceInvite> {
    return this.db
      .insertInto('shared_space_invite')
      .values(invite)
      .onConflict((oc) =>
        oc.columns(['albumId', 'userId']).doUpdateSet({
          role: invite.role ?? AlbumUserRole.Editor,
          invitedById: invite.invitedById ?? null,
        }),
      )
      .returning(['albumId', 'userId', 'role', 'invitedById', 'createdAt'])
      .executeTakeFirstOrThrow();
  }

  async getInvite({ albumId, userId }: AlbumPermissionId): Promise<SharedSpaceInvite | undefined> {
    return this.db
      .selectFrom('shared_space_invite')
      .select(['albumId', 'userId', 'role', 'invitedById', 'createdAt'])
      .where('albumId', '=', albumId)
      .where('userId', '=', userId)
      .executeTakeFirst();
  }

  /** Every space this person has been invited to and has not answered. */
  async getInvitesForUser(userId: string): Promise<SharedSpaceInvite[]> {
    return this.db
      .selectFrom('shared_space_invite')
      .select(['albumId', 'userId', 'role', 'invitedById', 'createdAt'])
      .where('userId', '=', userId)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  /** Who has been invited to a space and has not answered, for the owner's member list. */
  async getInvitesForAlbum(albumId: string): Promise<SharedSpaceInvite[]> {
    return this.db
      .selectFrom('shared_space_invite')
      .select(['albumId', 'userId', 'role', 'invitedById', 'createdAt'])
      .where('albumId', '=', albumId)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  async deleteInvite({ albumId, userId }: AlbumPermissionId): Promise<void> {
    await this.db
      .deleteFrom('shared_space_invite')
      .where('albumId', '=', albumId)
      .where('userId', '=', userId)
      .execute();
  }

  /* ------------------------------------------------------------------ */
  /* Shared space panels (FL-55)                                         */
  /*                                                                     */
  /* Albums and people linked into a space, and each member's last-seen  */
  /* marker. All three hang off an album exactly as `album_user` does,   */
  /* which is why they live here rather than in a repository of their    */
  /* own. None of them is a grant: a link never widens what anybody may  */
  /* read, and every read below is confined to assets that are already   */
  /* in the space, with Locked media (`withDefaultVisibility`) and media */
  /* marked sensitive (`excludeNsfw`) excluded before anything is        */
  /* counted, named or shown.                                            */
  /* ------------------------------------------------------------------ */

  /** The albums linked into one space, with just enough of each album to name it. */
  async getLinkedAlbums(spaceId: string): Promise<SharedSpaceAlbumLink[]> {
    return this.db
      .selectFrom('shared_space_album as link')
      .innerJoin('album', 'album.id', 'link.linkedAlbumId')
      .where('link.albumId', '=', spaceId)
      .where('album.deletedAt', 'is', null)
      .select([
        'link.albumId as albumId',
        'link.linkedAlbumId as linkedAlbumId',
        'album.albumName as linkedAlbumName',
        'album.icon as linkedAlbumIcon',
        'link.linkedById as linkedById',
        'link.createdAt as createdAt',
      ])
      .orderBy('album.albumName', 'asc')
      .execute();
  }

  async getLinkedAlbum(albumId: string, linkedAlbumId: string): Promise<SharedSpaceAlbumLink | undefined> {
    return this.db
      .selectFrom('shared_space_album as link')
      .innerJoin('album', 'album.id', 'link.linkedAlbumId')
      .where('link.albumId', '=', albumId)
      .where('link.linkedAlbumId', '=', linkedAlbumId)
      .select([
        'link.albumId as albumId',
        'link.linkedAlbumId as linkedAlbumId',
        'album.albumName as linkedAlbumName',
        'album.icon as linkedAlbumIcon',
        'link.linkedById as linkedById',
        'link.createdAt as createdAt',
      ])
      .executeTakeFirst();
  }

  /** Link an album into a space. Re-linking is a no-op, never a second row. */
  async createLinkedAlbum(link: Insertable<SharedSpaceAlbumTable>): Promise<void> {
    await this.db
      .insertInto('shared_space_album')
      .values(link)
      .onConflict((oc) => oc.columns(['albumId', 'linkedAlbumId']).doNothing())
      .execute();
  }

  /** Remove the reference. No asset, album, member or grant changes. */
  async deleteLinkedAlbum(albumId: string, linkedAlbumId: string): Promise<void> {
    await this.db
      .deleteFrom('shared_space_album')
      .where('albumId', '=', albumId)
      .where('linkedAlbumId', '=', linkedAlbumId)
      .execute();
  }

  /**
   * How many of the space's assets are also in each linked album, and which of
   * them to show as the tile's picture.
   *
   * The intersection is the point: a linked album is a reference, so the only
   * thing the space can honestly say about it is how much of it is here. Both
   * the count and the thumbnail therefore come from assets that are already in
   * the space, which every member can already see — linking never turns into a
   * way to look at an album you were not given.
   */
  async getLinkedAlbumCounts(
    spaceId: string,
    linkedAlbumIds: string[],
    options: HiddenContentQueryOptions = {},
  ): Promise<SharedSpaceLinkedAlbumCount[]> {
    if (linkedAlbumIds.length === 0) {
      return [];
    }

    return this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .innerJoin('album_asset as space_asset', 'space_asset.assetId', 'asset.id')
      .innerJoin('album_asset as linked_asset', 'linked_asset.assetId', 'asset.id')
      .where('space_asset.albumId', '=', spaceId)
      .where('linked_asset.albumId', 'in', linkedAlbumIds)
      .where('asset.deletedAt', 'is', null)
      .select('linked_asset.albumId as albumId')
      .select((eb) => sql<number>`${eb.fn.count('asset.id')}::int`.as('assetCount'))
      .select(
        sql<string | null>`(array_agg("asset"."id" order by "asset"."fileCreatedAt" desc))[1]`.as('thumbnailAssetId'),
      )
      .groupBy('linked_asset.albumId')
      .execute();
  }

  /**
   * The people linked into one space.
   *
   * `person` is inner-joined so a link whose person has been deleted stops
   * appearing, but nothing of the person row is selected: the space's identity
   * for somebody is the link's own `name` and `coverAssetId`, never the
   * owner's private naming of their own faces.
   *
   * A Locked photo is never the cover (FL-53). Moving a photo into the Locked
   * folder already replaces it (`releaseLockedCoverReferences`); the read still
   * answers no cover rather than a Locked id, whatever wrote the row.
   */
  async getLinkedPeople(spaceId: string): Promise<SharedSpacePersonLink[]> {
    return this.db
      .selectFrom('shared_space_person as link')
      .innerJoin('person', (join) =>
        join
          .onRef('person.ownerId', '=', 'link.personOwnerId')
          .onRef('person.personGroupId', '=', 'link.personGroupId'),
      )
      .leftJoin('asset as cover', (join) => join.onRef('cover.id', '=', 'link.coverAssetId').on(isLocked('cover')))
      .where('link.albumId', '=', spaceId)
      .select([
        'link.id as id',
        'link.albumId as albumId',
        'link.personOwnerId as personOwnerId',
        'link.personGroupId as personGroupId',
        'link.name as name',
        sql<string | null>`case when "cover"."id" is null then "link"."coverAssetId" end`.as('coverAssetId'),
        'link.createdAt as createdAt',
      ])
      .orderBy('link.name', 'asc')
      .orderBy('link.createdAt', 'asc')
      .execute();
  }

  async getLinkedPerson(id: string): Promise<SharedSpacePersonLink | undefined> {
    return this.db
      .selectFrom('shared_space_person')
      .select(['id', 'albumId', 'personOwnerId', 'personGroupId', 'name', 'coverAssetId', 'createdAt'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Link a person into a space, or rename the link this member already has. */
  async createLinkedPerson(link: Insertable<SharedSpacePersonTable>): Promise<SharedSpacePersonLink> {
    return this.db
      .insertInto('shared_space_person')
      .values(link)
      .onConflict((oc) =>
        oc.columns(['albumId', 'personOwnerId', 'personGroupId']).doUpdateSet({
          name: link.name ?? '',
          coverAssetId: link.coverAssetId ?? null,
        }),
      )
      .returning(['id', 'albumId', 'personOwnerId', 'personGroupId', 'name', 'coverAssetId', 'createdAt'])
      .executeTakeFirstOrThrow();
  }

  /** Remove the link and only the link: the person, their faces and the space stay as they are. */
  async deleteLinkedPerson(id: string): Promise<void> {
    await this.db.deleteFrom('shared_space_person').where('id', '=', id).execute();
  }

  /** How many of the space's visible assets show each linked person. */
  async getLinkedPersonCounts(
    spaceId: string,
    personGroupIds: string[],
    options: HiddenContentQueryOptions = {},
  ): Promise<{ personGroupId: string; assetCount: number }[]> {
    if (personGroupIds.length === 0) {
      return [];
    }

    return this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .innerJoin('asset_face', 'asset_face.assetId', 'asset.id')
      .where('album_asset.albumId', '=', spaceId)
      .where('asset.deletedAt', 'is', null)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .where('asset_face.personGroupId', 'in', personGroupIds)
      .select((eb) => sql<string>`${eb.ref('asset_face.personGroupId')}`.as('personGroupId'))
      .select((eb) => sql<number>`count(distinct ${eb.ref('asset.id')})::int`.as('assetCount'))
      .groupBy('asset_face.personGroupId')
      .execute();
  }

  /**
   * The picture the space shows for a person it has just been given: the most
   * recent asset that is already in the space and shows them. Never the
   * person's own thumbnail, which belongs to their owner alone.
   */
  async getLinkedPersonCoverAssetId(
    spaceId: string,
    personGroupId: string,
    options: HiddenContentQueryOptions = {},
  ): Promise<string | null> {
    const row = await this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .innerJoin('asset_face', 'asset_face.assetId', 'asset.id')
      .where('album_asset.albumId', '=', spaceId)
      .where('asset.deletedAt', 'is', null)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .where('asset_face.personGroupId', '=', personGroupId)
      .select('asset.id as id')
      .orderBy('asset.fileCreatedAt', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row?.id ?? null;
  }

  /**
   * The people the viewer could offer to link: their OWN people, seen on assets
   * that are in the space.
   *
   * `person.ownerId = ownerId` is the whole privacy argument for the people
   * panel. Every person row returned here belongs to the person asking, so
   * nothing is disclosed about how anybody else has named their own faces.
   * Publishing one into the space is the separate, deliberate act of making a
   * link, which carries a name of its own.
   */
  async getSpacePersonCandidates(
    spaceId: string,
    ownerId: string,
    options: HiddenContentQueryOptions = {},
  ): Promise<SharedSpacePersonCandidate[]> {
    return this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .innerJoin('asset_face', 'asset_face.assetId', 'asset.id')
      .innerJoin('person', (join) =>
        join.onRef('person.personGroupId', '=', 'asset_face.personGroupId').on('person.ownerId', '=', ownerId),
      )
      .where('album_asset.albumId', '=', spaceId)
      .where('asset.deletedAt', 'is', null)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .where('person.isHidden', '=', false)
      .select([
        'person.personGroupId as personGroupId',
        'person.name as name',
        'person.thumbnailPath as thumbnailPath',
        'person.isHidden as isHidden',
        'person.isFavorite as isFavorite',
        'person.color as color',
        'person.birthDate as birthDate',
        'person.updatedAt as updatedAt',
      ])
      .select((eb) => sql<number>`count(distinct ${eb.ref('asset.id')})::int`.as('assetCount'))
      .groupBy([
        'person.personGroupId',
        'person.name',
        'person.thumbnailPath',
        'person.isHidden',
        'person.isFavorite',
        'person.color',
        'person.birthDate',
        'person.updatedAt',
      ])
      .orderBy('assetCount', 'desc')
      .orderBy('person.name', 'asc')
      .execute() as Promise<SharedSpacePersonCandidate[]>;
  }

  async getSpaceVisit({ albumId, userId }: AlbumPermissionId): Promise<SharedSpaceVisit | undefined> {
    return this.db
      .selectFrom('shared_space_visit')
      .select(['albumId', 'userId', 'lastSeenAt'])
      .where('albumId', '=', albumId)
      .where('userId', '=', userId)
      .executeTakeFirst();
  }

  /** Move this member's marker forward. Nobody else's marker changes. */
  async setSpaceVisit({ albumId, userId }: AlbumPermissionId, lastSeenAt: Date): Promise<void> {
    await this.db
      .insertInto('shared_space_visit')
      .values({ albumId, userId, lastSeenAt })
      .onConflict((oc) => oc.columns(['albumId', 'userId']).doUpdateSet({ lastSeenAt }))
      .execute();
  }

  /**
   * What has arrived in the space since a moment, for one member.
   *
   * `since` of `undefined` means this member has never marked the space seen,
   * so everything in it is new to them. Their own additions are left out —
   * "new since your last visit" is about what other people brought — and the
   * same exclusions as every other space read apply before anything is counted.
   */
  private spaceNewAssetsQuery(
    spaceId: string,
    { since, viewerId }: { since?: Date; viewerId: string },
    options: HiddenContentQueryOptions = {},
  ) {
    return this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .where('album_asset.albumId', '=', spaceId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.ownerId', '!=', viewerId)
      .$if(since !== undefined, (qb) => qb.where('album_asset.createdAt', '>', since!));
  }

  async getSpaceNewAssetCount(
    spaceId: string,
    args: { since?: Date; viewerId: string },
    options: HiddenContentQueryOptions = {},
  ): Promise<number> {
    const row = await this.spaceNewAssetsQuery(spaceId, args, options)
      .select((eb) => sql<number>`count(distinct ${eb.ref('asset.id')})::int`.as('assetCount'))
      .executeTakeFirst();

    return row?.assetCount ?? 0;
  }

  async getSpaceNewAssetIds(
    spaceId: string,
    args: { since?: Date; viewerId: string; take: number },
    options: HiddenContentQueryOptions = {},
  ): Promise<string[]> {
    const rows = await this.spaceNewAssetsQuery(spaceId, args, options)
      .select('asset.id as id')
      .distinct()
      .orderBy('asset.id', 'asc')
      .limit(args.take)
      .execute();

    return rows.map(({ id }) => id);
  }

  /* ------------------------------------------------------------------ */
  /* Activity feed and mentions (FL-55)                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Record that something happened in a space.
   *
   * This is a plain insert of ids. It never reads an asset, so it works for
   * every actor and every item — Locked, sensitive or hidden — without an
   * elevated session; what a member later sees of it is the reader's problem,
   * not the writer's.
   */
  async createSpaceEvent(event: Insertable<SharedSpaceEventTable>): Promise<void> {
    await this.db.insertInto('shared_space_event').values(event).execute();
  }

  /** The space's events, newest first, joined to the comment or like they announce. */
  async getSpaceEvents(
    spaceId: string,
    { before, since, take }: { before?: Date; since?: Date; take: number },
  ): Promise<SharedSpaceEvent[]> {
    return this.db
      .selectFrom('shared_space_event as event')
      .leftJoin('activity', 'activity.id', 'event.activityId')
      .select([
        'event.id',
        'event.albumId',
        'event.actorId',
        'event.type',
        'event.targetUserId',
        'event.activityId',
        'event.assetIds',
        'event.subject',
        'event.createdAt',
        'activity.assetId as activityAssetId',
        'activity.comment as activityComment',
      ])
      .where('event.albumId', '=', spaceId)
      .$if(before !== undefined, (qb) => qb.where('event.createdAt', '<', before!))
      .$if(since !== undefined, (qb) => qb.where('event.createdAt', '>', since!))
      .orderBy('event.createdAt', 'desc')
      .orderBy('event.id', 'desc')
      .limit(take)
      .execute();
  }

  /**
   * Of these asset ids, the ones a viewer may see.
   *
   * The same exclusions as every other read of a space: Locked and hidden media
   * through the default visibility filter, media marked sensitive and the
   * viewer's own suppression settings through the hidden-content filter, and
   * deleted media. With `inSpace` the item must also still be in the space, so
   * an addition is only ever shown as items that are actually there; a removal
   * checks without it, because those items are gone from the space by definition.
   */
  async filterVisibleSpaceAssetIds(
    spaceId: string,
    assetIds: string[],
    options: HiddenContentQueryOptions,
    { inSpace }: { inSpace: boolean },
  ): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    const rows = await this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .select('asset.id')
      .where('asset.id', 'in', assetIds)
      .where('asset.deletedAt', 'is', null)
      .$if(inSpace, (qb) =>
        qb.where((eb) =>
          eb.exists(
            eb
              .selectFrom('album_asset')
              .select('album_asset.assetId')
              .whereRef('album_asset.assetId', '=', 'asset.id')
              .where('album_asset.albumId', '=', spaceId),
          ),
        ),
      )
      .execute();

    return new Set(rows.map(({ id }) => id));
  }

  async createMentions(activityId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    await this.db
      .insertInto('shared_space_mention')
      .values(userIds.map((userId) => ({ activityId, userId })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async deleteMentions(activityId: string): Promise<void> {
    await this.db.deleteFrom('shared_space_mention').where('activityId', '=', activityId).execute();
  }

  async getMentions(activityIds: string[]): Promise<SharedSpaceMention[]> {
    if (activityIds.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('shared_space_mention')
      .select(['activityId', 'userId'])
      .where('activityId', 'in', activityIds)
      .execute();
  }

  /* ------------------------------------------------------------------ */
  /* Threaded replies (FL-55)                                            */
  /* ------------------------------------------------------------------ */

  /** Record that a comment is a reply. The parent is always a top-level comment. */
  async createCommentThread(thread: Insertable<SharedSpaceCommentThreadTable>): Promise<void> {
    await this.db.insertInto('shared_space_comment_thread').values(thread).execute();
  }

  /** Of these comments, the ones that are replies, with the comment each answers. */
  async getCommentParents(activityIds: string[]): Promise<SharedSpaceCommentThread[]> {
    if (activityIds.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('shared_space_comment_thread')
      .select(['activityId', 'parentActivityId'])
      .where('activityId', 'in', activityIds)
      .execute();
  }

  /** The replies under these top-level comments. */
  async getCommentReplies(parentActivityIds: string[]): Promise<SharedSpaceCommentThread[]> {
    if (parentActivityIds.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('shared_space_comment_thread')
      .select(['activityId', 'parentActivityId'])
      .where('parentActivityId', 'in', parentActivityIds)
      .execute();
  }

  /**
   * Delete a comment and every reply under it, in one statement.
   *
   * Removing a comment removes its thread: the reply `activity` rows go with
   * the parent, and with them — through the existing cascades — their
   * mentions, their feed events and their thread rows. One statement, so a
   * failure leaves the thread whole rather than half gone.
   */
  async deleteCommentWithReplies(activityId: string): Promise<void> {
    await this.db
      .deleteFrom('activity')
      .where((eb) =>
        eb.or([
          eb('activity.id', '=', activityId),
          eb(
            'activity.id',
            'in',
            eb
              .selectFrom('shared_space_comment_thread')
              .select('shared_space_comment_thread.activityId')
              .where('shared_space_comment_thread.parentActivityId', '=', activityId),
          ),
        ]),
      )
      .execute();
  }
}
