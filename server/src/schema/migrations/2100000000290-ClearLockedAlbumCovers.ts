import { Kysely, sql } from 'kysely';

/**
 * Album covers are never Locked photos (owner decision, September 22, 2026, FL-53).
 *
 * Before FL-53 a cover that moved into the Locked folder stayed the cover of its albums. Each album
 * whose saved cover is Locked falls back to its automatic cover: its newest member that is neither
 * Locked nor trashed, or no cover when there is none. Other albums are untouched. From now on the
 * visibility change itself releases the cover (`releaseLockedAlbumCovers`).
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Fresh installs add the locked enum value in this migration batch, before its transaction commits.
  await sql`
    UPDATE "album"
    SET "albumThumbnailAssetId" = (
      SELECT "album_asset"."assetId"
      FROM "album_asset"
      INNER JOIN "asset"
        ON "album_asset"."assetId" = "asset"."id"
        AND "asset"."deletedAt" IS NULL
        AND "asset"."visibility"::text != 'locked'
      WHERE "album_asset"."albumId" = "album"."id"
      ORDER BY "asset"."fileCreatedAt" DESC
      LIMIT 1
    )
    WHERE "albumThumbnailAssetId" IN (SELECT "id" FROM "asset" WHERE "visibility"::text = 'locked')
  `.execute(db);
}

export async function down(): Promise<void> {
  // Nothing to restore: a Locked cover is never valid, and the previous covers are not recorded.
}
