import { ForbiddenException, Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { PhotographyBrand, StoredShoot } from 'src/dtos/photography-workspace.dto.js';
import type { UserMetadata } from 'src/types.js';
import { AlbumUserRole, AssetVisibility, UserMetadataKey } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

@Injectable()
export class PhotographyWorkspaceRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  get(userId: string) {
    return this.db
      .selectFrom('user_metadata')
      .select(['value', 'updateId'])
      .where('userId', '=', userId)
      .where('key', '=', UserMetadataKey.PhotographyWorkspace)
      .executeTakeFirst() as Promise<
      | {
          value: {
            shoots: StoredShoot[];
            brand?: PhotographyBrand;
          };
          updateId: string;
        }
      | undefined
    >;
  }
  async save(userId: string, shoots: StoredShoot[], expectedRevision: string | null, validateAlbumIds: string[]) {
    return this.db.transaction().execute(async (tx) => {
      // Hold current ownership and deletion state until the reference write commits.
      if (validateAlbumIds.length > 0) {
        const albums = await tx
          .selectFrom('album')
          .innerJoin('album_user', 'album.id', 'album_user.albumId')
          .select('album.id')
          .where('album.id', 'in', validateAlbumIds)
          .where('album.deletedAt', 'is', null)
          .where('album_user.userId', '=', userId)
          .where('album_user.role', '=', AlbumUserRole.Owner)
          .forShare()
          .execute();
        if (albums.length !== validateAlbumIds.length) {
          throw new ForbiddenException('Source album is unavailable');
        }
      }
      if (expectedRevision !== null) {
        return tx
          .updateTable('user_metadata')
          .set({
            value: sql<
              UserMetadata[UserMetadataKey.PhotographyWorkspace]
            >`value || ${JSON.stringify({ shoots })}::text::jsonb`,
          })
          .where('userId', '=', userId)
          .where('key', '=', UserMetadataKey.PhotographyWorkspace)
          .where('updateId', '=', expectedRevision)
          .returning('updateId')
          .executeTakeFirst();
      }
      return tx
        .insertInto('user_metadata')
        .values({ userId, key: UserMetadataKey.PhotographyWorkspace, value: { shoots } })
        .onConflict((oc) => oc.columns(['userId', 'key']).doNothing())
        .returning('updateId')
        .executeTakeFirst();
    });
  }
  async saveBrand(userId: string, brand: PhotographyBrand, expectedRevision: string | null) {
    return this.db.transaction().execute(async (tx) => {
      if (expectedRevision !== null) {
        return tx
          .updateTable('user_metadata')
          .set({
            value: sql<
              UserMetadata[UserMetadataKey.PhotographyWorkspace]
            >`value || ${JSON.stringify({ brand })}::text::jsonb`,
          })
          .where('userId', '=', userId)
          .where('key', '=', UserMetadataKey.PhotographyWorkspace)
          .where('updateId', '=', expectedRevision)
          .returning('updateId')
          .executeTakeFirst();
      }
      return tx
        .insertInto('user_metadata')
        .values({ userId, key: UserMetadataKey.PhotographyWorkspace, value: { shoots: [], brand } })
        .onConflict((oc) => oc.columns(['userId', 'key']).doNothing())
        .returning('updateId')
        .executeTakeFirst();
    });
  }
  /** Shoot covers' thumbhashes: an asset has one once its thumbnail is made. Locked and trashed assets are left out. */
  async coverThumbhashes(assetIds: string[]) {
    if (assetIds.length === 0) {
      return new Map<string, Buffer>();
    }
    const rows = await this.db
      .selectFrom('asset')
      .select(['id', 'thumbhash'])
      .where('id', 'in', assetIds)
      .where('deletedAt', 'is', null)
      .where('visibility', '!=', AssetVisibility.Locked)
      .where('thumbhash', 'is not', null)
      .execute();
    return new Map(rows.map(({ id, thumbhash }) => [id, thumbhash!]));
  }
  async currentRevisions(userId: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return new Map<string, string>();
    }
    const { rows } = await sql<{
      assetId: string;
      id: string;
    }>`
      SELECT "assetId", id FROM public.asset_develop_revision
      WHERE "ownerId" = ${userId}::uuid AND "assetId" = ANY(${assetIds}::uuid[]) AND "isCurrent"
    `.execute(this.db);
    return new Map(rows.map(({ assetId, id }) => [assetId, id]));
  }
}
