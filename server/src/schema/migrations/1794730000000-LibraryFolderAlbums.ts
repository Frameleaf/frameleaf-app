import { Kysely, sql } from 'kysely';

// FL-838: an album for each folder of a library, kept in sync after every scan.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE library ADD COLUMN "folderAlbums" boolean NOT NULL DEFAULT false`.execute(db);
  await sql`CREATE TABLE library_folder_album (
    id uuid NOT NULL DEFAULT uuid_generate_v4(),
    "libraryId" uuid NOT NULL,
    "folderPath" text NOT NULL,
    "albumId" uuid NOT NULL,
    "isUserEdited" boolean NOT NULL DEFAULT false,
    CONSTRAINT library_folder_album_pkey PRIMARY KEY (id),
    CONSTRAINT "library_folder_album_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES library (id) ON DELETE CASCADE,
    CONSTRAINT "library_folder_album_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES album (id) ON DELETE CASCADE,
    CONSTRAINT "library_folder_album_libraryId_folderPath_uq" UNIQUE ("libraryId", "folderPath")
  )`.execute(db);
  await sql`CREATE INDEX "library_folder_album_albumId_idx" ON library_folder_album ("albumId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE library_folder_album`.execute(db);
  await sql`ALTER TABLE library DROP COLUMN "folderAlbums"`.execute(db);
}
