import { Kysely, sql } from 'kysely';

/**
 * Universal storage file trash (Library Care): an original nothing references any more is moved here
 * instead of being unlinked, and leaves disk only when an administrator deletes it permanently. Each row
 * is a reference that keeps its path (see `countPathReferences`). No foreign keys: the last owner and
 * asset are history and may be gone.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE immich_fork.physical_file_trash (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    "physicalFileId" uuid,
    path text NOT NULL,
    checksum bytea NOT NULL,
    "sizeInBytes" bigint NOT NULL,
    "lastOwnerId" uuid,
    "lastAssetId" uuid,
    "originalFileName" text NOT NULL,
    "trashedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT physical_file_trash_pkey PRIMARY KEY (id),
    CONSTRAINT physical_file_trash_path_key UNIQUE (path)
  )`.execute(db);
  await sql`CREATE INDEX physical_file_trash_checksum_idx
    ON immich_fork.physical_file_trash (checksum, "sizeInBytes")`.execute(db);
  await sql`CREATE INDEX physical_file_trash_trashed_at_idx ON immich_fork.physical_file_trash ("trashedAt")`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  // Dropping the rows would leave their originals on disk with nothing that names them.
  const { rows } = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM immich_fork.physical_file_trash`.execute(db);
  if (rows[0].count !== '0') {
    throw new Error('Restore or permanently delete the files in the file trash before rolling back');
  }
  await sql`DROP TABLE immich_fork.physical_file_trash`.execute(db);
}
