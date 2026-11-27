import { Kysely, sql } from 'kysely';

/**
 * FL-1837: which folders of a library become albums. A library from before keeps null, which makes an album for every
 * folder as it always has. An album kept as made when the rules changed ("new folders only") is marked `isKept`.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE library ADD COLUMN "folderAlbumOptions" jsonb`.execute(db);
  await sql`ALTER TABLE library_folder_album ADD COLUMN "isKept" boolean NOT NULL DEFAULT false`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE library_folder_album DROP COLUMN "isKept"`.execute(db);
  await sql`ALTER TABLE library DROP COLUMN "folderAlbumOptions"`.execute(db);
}
