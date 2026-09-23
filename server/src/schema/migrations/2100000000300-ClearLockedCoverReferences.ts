import { Kysely, sql } from 'kysely';

/**
 * Locked photos are never covers, featured photos or face thumbnails (owner decision, September 22,
 * 2026, FL-53).
 *
 * Before FL-53 a photo that moved into the Locked folder kept every such role. This repairs the data
 * saved before the fix; from now on the visibility change itself releases them
 * (`releaseLockedCoverReferences`). Nothing else is touched: every Locked photo keeps its albums,
 * spaces, people and pets.
 *
 * - Albums, collections and shared spaces whose cover is Locked fall back to their automatic cover
 *   (newest member neither Locked nor trashed), or to none. Migration 290 did this once already; it
 *   is repeated for covers saved between the two.
 * - A shared space's picture for a linked person that is Locked is cleared. The space shows no
 *   picture for them until the person is linked again, which picks one every member may see; a
 *   migration cannot tell reliably which photos are marked sensitive, so it does not choose one.
 * - A person whose featured face is on a Locked photo takes another of their faces on a photo that
 *   is not Locked (untrashed and newest first), or none, and loses the thumbnail cut from the Locked
 *   photo. The thumbnail is generated again from the new face by the missing-thumbnail job (nightly,
 *   or "Missing" under Generate Thumbnails in the job queues).
 * - A pet whose featured photo is Locked has none.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE "album"
    SET "albumThumbnailAssetId" = (
      SELECT "album_asset"."assetId"
      FROM "album_asset"
      INNER JOIN "asset"
        ON "album_asset"."assetId" = "asset"."id"
        AND "asset"."deletedAt" IS NULL
        AND "asset"."visibility" != 'locked'
      WHERE "album_asset"."albumId" = "album"."id"
      ORDER BY "asset"."fileCreatedAt" DESC
      LIMIT 1
    )
    WHERE "albumThumbnailAssetId" IN (SELECT "id" FROM "asset" WHERE "visibility" = 'locked')
  `.execute(db);

  await sql`
    UPDATE "shared_space_person"
    SET "coverAssetId" = NULL
    WHERE "coverAssetId" IN (SELECT "id" FROM "asset" WHERE "visibility" = 'locked')
  `.execute(db);

  await sql`
    UPDATE "person"
    SET
      "faceAssetId" = (
        SELECT "asset_face"."id"
        FROM "asset_face"
        INNER JOIN "asset"
          ON "asset"."id" = "asset_face"."assetId"
          AND "asset"."visibility" != 'locked'
        WHERE "asset_face"."personGroupId" = "person"."personGroupId"
          AND "asset_face"."deletedAt" IS NULL
          AND "asset_face"."isVisible" IS TRUE
        ORDER BY "asset"."deletedAt" IS NOT NULL, "asset"."fileCreatedAt" DESC
        LIMIT 1
      ),
      "thumbnailPath" = ''
    WHERE "faceAssetId" IN (
      SELECT "asset_face"."id"
      FROM "asset_face"
      INNER JOIN "asset"
        ON "asset"."id" = "asset_face"."assetId"
        AND "asset"."visibility" = 'locked'
    )
  `.execute(db);

  await sql`
    UPDATE "pet"
    SET "featuredAssetId" = NULL, "updatedAt" = now()
    WHERE "featuredAssetId" IN (SELECT "id" FROM "asset" WHERE "visibility" = 'locked')
  `.execute(db);
}

export async function down(): Promise<void> {
  // Nothing to restore: a Locked cover is never valid, and the previous covers are not recorded.
}
