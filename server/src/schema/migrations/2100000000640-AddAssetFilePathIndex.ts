import { Kysely, sql } from 'kysely';

/**
 * An index on `asset_file.path` (FL-179).
 *
 * A storage move points every file row that names the moved path at the new one, inside the
 * transaction that holds the path's lock, and FileDelete counts the rows that still name a path
 * before it deletes the file. Both looked the path up with a scan of `asset_file`. Like
 * `asset_file_physicalFileId_idx`, this is a Frameleaf index on the shared table: a handoff leaves
 * it in place (it changes no data), and `down` drops it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS "asset_file_path_idx" ON "asset_file" ("path");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "asset_file_path_idx";`.execute(db);
}
