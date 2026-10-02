import { Kysely, sql } from 'kysely';

/** Local capture references survive restarts and never expose the buddy's opaque vault to ingestion. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE immich_fork.buddy_backup_reference (
    "runId" uuid NOT NULL, path text NOT NULL, "deleteRequested" boolean NOT NULL DEFAULT false,
    released boolean NOT NULL DEFAULT false,
    "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY ("runId", path)
  )`.execute(db);
  await sql`CREATE INDEX buddy_backup_reference_path_idx ON immich_fork.buddy_backup_reference (path)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Never release a live capture's physical file ownership as a side effect of rollback.
  const { rows } = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM immich_fork.buddy_backup_reference`.execute(db);
  if (rows[0].count !== '0')
    throw new Error('Abandon or finish Buddy backups before rolling back their file references');
  await sql`DROP TABLE immich_fork.buddy_backup_reference`.execute(db);
}
