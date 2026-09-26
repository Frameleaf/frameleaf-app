import { Kysely, sql } from 'kysely';

/**
 * An index on `asset_file.path` (FL-179), under a Frameleaf name so that an index upstream adds with
 * the default name cannot collide with it.
 *
 * A storage move points every file row that names the moved path at the new one, inside the
 * transaction that holds the path's lock, and FileDelete counts the rows that still name a path
 * before it deletes the file. Both looked the path up with a scan of `asset_file`. Like
 * `asset_file_physicalFileId_idx`, this is a Frameleaf index on the shared table: a handoff leaves
 * it in place (it changes no data), and `down` drops it.
 *
 * It is not built CONCURRENTLY (migrations run in a transaction), so the server start that applies it
 * holds writes to `asset_file` until the index is built; on a large library that start takes longer.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS "asset_file_path_frameleaf_idx" ON "asset_file" ("path");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "asset_file_path_frameleaf_idx";`.execute(db);
}
