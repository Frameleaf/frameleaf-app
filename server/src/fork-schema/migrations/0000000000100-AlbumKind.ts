import { Kysely, sql } from 'kysely';

/**
 * Fork-owned sidecar for the album kind (album, collection, space); pairs with
 * the legacy-fork migration 2100000000080-AddAlbumKind and is mirrored by
 * ForkAlbumMetadataRepository. Parents of albums are promoted to collections,
 * except albums the smart album rules fill.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE immich_fork.album_metadata ADD COLUMN kind text NOT NULL DEFAULT 'album'`.execute(
    db,
  );
  await sql`ALTER TABLE immich_fork.album_metadata ADD CONSTRAINT album_metadata_kind_check CHECK (kind = ANY (ARRAY['album'::text, 'collection'::text, 'space'::text]))`.execute(
    db,
  );
  await sql`
    UPDATE immich_fork.album_metadata
    SET kind = 'collection', "updatedAt" = now()
    WHERE kind = 'album'
      AND "albumId" IN (SELECT DISTINCT "parentId" FROM immich_fork.album_metadata WHERE "parentId" IS NOT NULL)
      AND "albumId" NOT IN (SELECT "albumId" FROM immich_fork.smart_album_rule)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE immich_fork.album_metadata DROP CONSTRAINT album_metadata_kind_check`.execute(db);
  await sql`ALTER TABLE immich_fork.album_metadata DROP COLUMN kind`.execute(db);
}
