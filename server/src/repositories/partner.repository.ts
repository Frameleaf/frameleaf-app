import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { ExpressionBuilder, Insertable, Kysely, NotNull, Updateable } from 'kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { PartnerTable } from 'src/schema/tables/partner.table.js';

export interface PartnerIds {
  sharedById: string;
  sharedWithId: string;
}

export enum PartnerDirection {
  SharedBy = 'shared-by',
  SharedWith = 'shared-with',
}

const withSharedBy = (eb: ExpressionBuilder<DB, 'partner'>) => {
  return jsonObjectFrom(
    eb.selectFrom('user as sharedBy').select(columns.user).whereRef('sharedBy.id', '=', 'partner.sharedById'),
  ).as('sharedBy');
};

const withSharedWith = (eb: ExpressionBuilder<DB, 'partner'>) => {
  return jsonObjectFrom(
    eb.selectFrom('user as sharedWith').select(columns.user).whereRef('sharedWith.id', '=', 'partner.sharedWithId'),
  ).as('sharedWith');
};

@Injectable()
export class PartnerRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getAll(userId: string) {
    return this.builder()
      .where((eb) => eb.or([eb('sharedWithId', '=', userId), eb('sharedById', '=', userId)]))
      .execute();
  }

  @GenerateSql({ params: [{ sharedWithId: DummyValue.UUID, sharedById: DummyValue.UUID }] })
  get({ sharedWithId, sharedById }: PartnerIds) {
    return this.builder()
      .where('sharedWithId', '=', sharedWithId)
      .where('sharedById', '=', sharedById)
      .executeTakeFirst();
  }

  create(values: Insertable<PartnerTable>) {
    return this.db
      .insertInto('partner')
      .values(values)
      .returningAll()
      .returning(withSharedBy)
      .returning(withSharedWith)
      .$narrowType<{ sharedWith: NotNull; sharedBy: NotNull }>()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ sharedWithId: DummyValue.UUID, sharedById: DummyValue.UUID }, { inTimeline: true }] })
  update({ sharedWithId, sharedById }: PartnerIds, values: Updateable<PartnerTable>) {
    return this.db
      .updateTable('partner')
      .set(values)
      .where('sharedWithId', '=', sharedWithId)
      .where('sharedById', '=', sharedById)
      .returningAll()
      .returning(withSharedBy)
      .returning(withSharedWith)
      .$narrowType<{ sharedWith: NotNull; sharedBy: NotNull }>()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ sharedWithId: DummyValue.UUID, sharedById: DummyValue.UUID }] })
  async remove({ sharedWithId, sharedById }: PartnerIds) {
    await this.db
      .deleteFrom('partner')
      .where('sharedWithId', '=', sharedWithId)
      .where('sharedById', '=', sharedById)
      .execute();
  }

  /**
   * FL-54 (owner default, privacy first): owners who hide their locations from the owner of any of
   * `albumIds`. Viewing an album is viewing it through its owner's eyes, so their items are treated as
   * location-hidden for everyone looking through those albums, except a viewer the owner shares
   * locations with directly (as `getLocationHiddenThroughAlbums`).
   */
  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.UUID] })
  async getLocationHiddenOwnerIdsForAlbums(albumIds: string[], viewerId: string): Promise<string[]> {
    if (albumIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('partner')
      .innerJoin('album_user as album_owner', (join) =>
        join
          .onRef('album_owner.userId', '=', 'partner.sharedWithId')
          .on('album_owner.role', '=', sql.lit(AlbumUserRole.Owner)),
      )
      .where('album_owner.albumId', 'in', albumIds)
      .where('partner.shareLocation', '=', false)
      .whereRef('partner.sharedById', '!=', 'partner.sharedWithId')
      // an owner who shares locations with the viewer directly shows them in the partner library anyway
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('partner as direct')
              .whereRef('direct.sharedById', '=', 'partner.sharedById')
              .where('direct.sharedWithId', '=', viewerId)
              .where('direct.shareLocation', '=', true),
          ),
        ),
      )
      .select('partner.sharedById')
      .distinct()
      .execute();
    return rows.map(({ sharedById }) => sharedById);
  }

  /**
   * FL-54 (owner default, privacy first): of `assetIds`, those `viewerId` reaches through an album (owned
   * or joined) whose owner the asset's owner hides locations from. The asset's owner, and partners the
   * owner shares locations with (who see them in the partner library anyway), are never affected.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async getLocationHiddenThroughAlbums(viewerId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    const rows = await this.db
      .selectFrom('album_asset')
      .innerJoin('album', (join) =>
        join.onRef('album.id', '=', 'album_asset.albumId').on('album.deletedAt', 'is', null),
      )
      .innerJoin('album_user as album_owner', (join) =>
        join.onRef('album_owner.albumId', '=', 'album.id').on('album_owner.role', '=', sql.lit(AlbumUserRole.Owner)),
      )
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .innerJoin('partner', (join) =>
        join
          .onRef('partner.sharedById', '=', 'asset.ownerId')
          .onRef('partner.sharedWithId', '=', 'album_owner.userId')
          .on('partner.shareLocation', '=', false),
      )
      .where('album_asset.assetId', 'in', assetIds)
      .where('asset.ownerId', '!=', viewerId)
      .whereRef('asset.ownerId', '!=', 'album_owner.userId')
      // the viewer reaches the item through this album: they own it or are one of its members
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user as member')
            .whereRef('member.albumId', '=', 'album.id')
            .where('member.userId', '=', viewerId),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('partner as direct')
              .whereRef('direct.sharedById', '=', 'asset.ownerId')
              .where('direct.sharedWithId', '=', viewerId)
              .where('direct.shareLocation', '=', true),
          ),
        ),
      )
      .select('album_asset.assetId')
      .distinct()
      .execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  private builder() {
    return this.db
      .selectFrom('partner')
      .innerJoin('user as sharedBy', (join) =>
        join.onRef('partner.sharedById', '=', 'sharedBy.id').on('sharedBy.deletedAt', 'is', null),
      )
      .innerJoin('user as sharedWith', (join) =>
        join.onRef('partner.sharedWithId', '=', 'sharedWith.id').on('sharedWith.deletedAt', 'is', null),
      )
      .selectAll('partner')
      .select(withSharedBy)
      .select(withSharedWith);
  }
}
