import { Kysely, sql } from 'kysely';

/**
 * The owner's curation of a memory (FL-62): hidden from the memories list (restorable from
 * "Hidden memories"), their own title, and the order they put its items in. One row per memory,
 * written only by its owner.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema: a
 * row whose memory was deleted is ignored when memories are read and removed by the memories
 * cleanup job.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.memory_curation (
      "memoryId" uuid PRIMARY KEY,
      "ownerId" uuid NOT NULL,
      "hiddenAt" timestamptz,
      title text,
      "assetOrder" uuid[],
      "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT memory_curation_title_check CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200)
    )
  `.execute(db);
  await sql`CREATE INDEX memory_curation_owner_idx ON immich_fork.memory_curation ("ownerId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.memory_curation`.execute(db);
}
