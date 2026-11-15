import { ForbiddenException, Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { PhotographyBrand, StoredShoot } from 'src/dtos/photography-workspace.dto.js';
import type { UserMetadata } from 'src/types.js';
import { defaults } from 'src/dtos/config.dto.js';
import { AlbumUserRole, UserMetadataKey } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { isNotLocked } from 'src/utils/locked.js';

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
      .where(isNotLocked('asset'))
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

  /**
   * FL-863: each photo's faces for culling: how many, how many have closed or soft eyes by the admin's
   * thresholds (`machineLearning.eyeScores`), and how many aren't scored yet. Photos with no face are left out.
   * ponytail: the thresholds are read from the stored settings with the built-in defaults, so a config file's
   * values don't apply here; read them through the config service if that's ever needed.
   */
  async eyeSummaries(assetIds: string[]) {
    type Summary = { faceCount: number; closedCount: number; softCount: number; unscoredCount: number };
    if (assetIds.length === 0) {
      return new Map<string, Summary>();
    }
    const { closedBelow, softBelow } = defaults.machineLearning.eyeScores;
    const { rows } = await sql<Summary & { assetId: string }>`
      WITH limits AS (
        SELECT coalesce((value->'machineLearning'->'eyeScores'->>'closedBelow')::real, ${closedBelow}) AS closed,
          coalesce((value->'machineLearning'->'eyeScores'->>'softBelow')::real, ${softBelow}) AS soft
        FROM (SELECT (SELECT value FROM public.system_metadata WHERE key = 'system-config') AS value) config
      )
      SELECT face."assetId", count(*)::int AS "faceCount",
        count(*) FILTER (WHERE face."eyesOpen" < limits.closed)::int AS "closedCount",
        count(*) FILTER (WHERE face."eyeSharpness" < limits.soft)::int AS "softCount",
        count(*) FILTER (WHERE face."eyeScoreVersion" IS NULL)::int AS "unscoredCount"
      FROM public.asset_face face CROSS JOIN limits
      WHERE face."assetId" = ANY(${assetIds}::uuid[]) AND face."deletedAt" IS NULL AND face."isVisible"
      GROUP BY face."assetId"
    `.execute(this.db);
    return new Map(rows.map(({ assetId, ...summary }) => [assetId, summary]));
  }
}
