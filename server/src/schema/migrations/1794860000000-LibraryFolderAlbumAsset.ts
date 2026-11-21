import { Kysely, sql } from 'kysely';

/**
 * FL-838: folder albums follow the approved design.
 * - The sync remembers each folder photo it put in an album, so a photo the owner takes out stays out (decision 3).
 * - An import folder's album no longer holds the other folder albums (decision 2): the folders directly in an import
 *   folder are at the top. Albums already made move out of it now; the next sync renames or removes it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE library_folder_album_asset (
    "folderAlbumId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    CONSTRAINT library_folder_album_asset_pkey PRIMARY KEY ("folderAlbumId", "assetId"),
    CONSTRAINT "library_folder_album_asset_folderAlbumId_fkey" FOREIGN KEY ("folderAlbumId") REFERENCES library_folder_album (id) ON DELETE CASCADE,
    CONSTRAINT "library_folder_album_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES asset (id) ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "library_folder_album_asset_assetId_idx" ON library_folder_album_asset ("assetId")`.execute(db);
  await sql`UPDATE album SET "parentId" = NULL
    FROM library_folder_album child, library_folder_album root, library
    WHERE album.id = child."albumId" AND album."parentId" = root."albumId"
      AND child."libraryId" = library.id AND root."libraryId" = library.id
      AND root."folderPath" = ANY (SELECT rtrim(p, '/') FROM unnest(library."importPaths") AS p)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE library_folder_album_asset`.execute(db);
}
