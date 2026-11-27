import { Kysely, sql } from 'kysely';

/**
 * FL-1838: "Folders in this album". How each folder inside an album made from a folder shows there, per album
 * (`library_folder_album.displayChoices`, null follows the library) and per library (`library.folderAlbumDisplay`, null
 * uses Frameleaf's defaults), and the same photo found in more than one of those folders (`album_folder_version`).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE library ADD COLUMN "folderAlbumDisplay" jsonb`.execute(db);
  await sql`ALTER TABLE library_folder_album ADD COLUMN "displayChoices" jsonb`.execute(db);
  await sql`CREATE TABLE album_folder_version (
    "albumId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "frontAssetId" uuid NOT NULL,
    "matchedBy" text NOT NULL,
    CONSTRAINT album_folder_version_pkey PRIMARY KEY ("albumId", "assetId"),
    CONSTRAINT "album_folder_version_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES album (id) ON DELETE CASCADE,
    CONSTRAINT "album_folder_version_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES asset (id) ON DELETE CASCADE,
    CONSTRAINT "album_folder_version_frontAssetId_fkey" FOREIGN KEY ("frontAssetId") REFERENCES asset (id) ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "album_folder_version_assetId_idx" ON album_folder_version ("assetId")`.execute(db);
  await sql`CREATE INDEX "album_folder_version_albumId_frontAssetId_idx" ON album_folder_version ("albumId", "frontAssetId")`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE album_folder_version`.execute(db);
  await sql`ALTER TABLE library_folder_album DROP COLUMN "displayChoices"`.execute(db);
  await sql`ALTER TABLE library DROP COLUMN "folderAlbumDisplay"`.execute(db);
}
