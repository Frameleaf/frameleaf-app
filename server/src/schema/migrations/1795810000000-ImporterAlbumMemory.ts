import { Kysely, sql } from 'kysely';

/**
 * FL-1840: importers remember the albums they made through a rename, a merge or a delete.
 *
 * - `takeout_album` keeps its row when the album is deleted (`albumId` becomes null: removed on purpose) and is keyed
 *   by `source` as well: '' for a Google Photos export, else the import connection's id. A mapping a connection's
 *   import already used is copied to that connection, so nothing an earlier import made is made again; the '' row is
 *   kept for a later Google Photos export.
 * - `photo_source_album`: the album a catalog collection became, by the catalog's own collection id.
 * - `preservation_album`: the album a package's album became, so a merge moves where a later restore goes.
 * - A phone album link outlives its album: an album that is gone means the link stays removed.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE takeout_album ALTER COLUMN "albumId" DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE takeout_album DROP CONSTRAINT "takeout_album_albumId_fkey"`.execute(db);
  await sql`
    ALTER TABLE takeout_album ADD CONSTRAINT "takeout_album_albumId_fkey"
      FOREIGN KEY ("albumId") REFERENCES album (id) ON UPDATE CASCADE ON DELETE SET NULL
  `.execute(db);
  await sql`ALTER TABLE takeout_album ADD COLUMN source text NOT NULL DEFAULT ''`.execute(db);
  await sql`ALTER TABLE takeout_album DROP CONSTRAINT "takeout_album_ownerId_folder_uq"`.execute(db);
  await sql`
    ALTER TABLE takeout_album ADD CONSTRAINT "takeout_album_ownerId_source_folder_uq" UNIQUE ("ownerId", source, folder)
  `.execute(db);
  await sql`
    INSERT INTO takeout_album ("ownerId", source, folder, "albumId")
    SELECT DISTINCT mapping."ownerId", run."connectionId"::text, mapping.folder, mapping."albumId"
    FROM takeout_album mapping
    JOIN takeout_import run ON run."ownerId" = mapping."ownerId" AND run."connectionId" IS NOT NULL
    WHERE mapping.source = ''
      AND EXISTS (SELECT 1 FROM takeout_file file WHERE file."importId" = run.id AND file.folder = mapping.folder)
    ON CONFLICT DO NOTHING
  `.execute(db);

  await sql`
    CREATE TABLE photo_source_album (
      id uuid NOT NULL DEFAULT immich_uuid_v7(),
      "ownerId" uuid NOT NULL,
      catalog text NOT NULL,
      "collectionId" text NOT NULL,
      "albumId" uuid,
      CONSTRAINT "photo_source_album_pkey" PRIMARY KEY (id),
      CONSTRAINT "photo_source_album_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" (id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "photo_source_album_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES album (id) ON UPDATE CASCADE ON DELETE SET NULL,
      CONSTRAINT "photo_source_album_ownerId_catalog_collectionId_uq" UNIQUE ("ownerId", catalog, "collectionId")
    )
  `.execute(db);
  await sql`CREATE INDEX "photo_source_album_albumId_idx" ON photo_source_album ("albumId")`.execute(db);

  await sql`
    CREATE TABLE preservation_album (
      id uuid NOT NULL DEFAULT immich_uuid_v7(),
      "ownerId" uuid NOT NULL,
      "packageIdentity" text NOT NULL,
      "sourceAlbumId" text NOT NULL,
      "albumId" uuid NOT NULL,
      CONSTRAINT "preservation_album_pkey" PRIMARY KEY (id),
      CONSTRAINT "preservation_album_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" (id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "preservation_album_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES album (id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "preservation_album_ownerId_packageIdentity_sourceAlbumId_uq" UNIQUE ("ownerId", "packageIdentity", "sourceAlbumId")
    )
  `.execute(db);
  await sql`CREATE INDEX "preservation_album_albumId_idx" ON preservation_album ("albumId")`.execute(db);

  await sql`ALTER TABLE public.album_source_link DROP CONSTRAINT album_source_link_album_fkey`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM public.album_source_link link WHERE NOT EXISTS (SELECT 1 FROM album WHERE album.id = link."albumId")`.execute(
    db,
  );
  await sql`
    ALTER TABLE public.album_source_link ADD CONSTRAINT album_source_link_album_fkey
      FOREIGN KEY ("albumId") REFERENCES public.album(id) ON DELETE CASCADE
  `.execute(db);
  await sql`DROP TABLE preservation_album`.execute(db);
  await sql`DROP TABLE photo_source_album`.execute(db);
  await sql`DELETE FROM takeout_album WHERE "albumId" IS NULL`.execute(db);
  await sql`
    DELETE FROM takeout_album mapping
    WHERE mapping.source <> '' AND EXISTS (
      SELECT 1 FROM takeout_album other
      WHERE other."ownerId" = mapping."ownerId" AND other.folder = mapping.folder
        AND (other.source < mapping.source))
  `.execute(db);
  await sql`ALTER TABLE takeout_album DROP CONSTRAINT "takeout_album_ownerId_source_folder_uq"`.execute(db);
  await sql`ALTER TABLE takeout_album ADD CONSTRAINT "takeout_album_ownerId_folder_uq" UNIQUE ("ownerId", folder)`.execute(
    db,
  );
  await sql`ALTER TABLE takeout_album DROP COLUMN source`.execute(db);
  await sql`ALTER TABLE takeout_album DROP CONSTRAINT "takeout_album_albumId_fkey"`.execute(db);
  await sql`
    ALTER TABLE takeout_album ADD CONSTRAINT "takeout_album_albumId_fkey"
      FOREIGN KEY ("albumId") REFERENCES album (id) ON UPDATE CASCADE ON DELETE CASCADE
  `.execute(db);
  await sql`ALTER TABLE takeout_album ALTER COLUMN "albumId" SET NOT NULL`.execute(db);
}
