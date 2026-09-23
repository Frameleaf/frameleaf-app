import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable, Kysely, Updateable } from 'kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { AlbumUserTable } from 'src/schema/tables/album-user.table.js';
import { SharedSpaceInviteTable } from 'src/schema/tables/shared-space-invite.table.js';

export type AlbumPermissionId = {
  albumId: string;
  userId: string;
};

/** A pending invitation to a shared space. It grants nothing until accepted. */
export type SharedSpaceInvite = {
  albumId: string;
  userId: string;
  role: AlbumUserRole;
  invitedById: string | null;
  createdAt: Date;
};

@Injectable()
export class AlbumUserRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

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
        oc.columns(['albumId', 'userId']).doUpdateSet({ role: invite.role, invitedById: invite.invitedById ?? null }),
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
}
