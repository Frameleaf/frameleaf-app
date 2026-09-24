import { Kysely, sql } from 'kysely';

/**
 * Custom album order (FL-52). Each person arranges their own album directory: the collections,
 * the albums that stand on their own, the albums inside each collection and the shared spaces are
 * put in the order they choose, and that order is theirs alone. A row is one album's place for one
 * person; the group it belongs to is wherever the album sits in that person's directory, so moving
 * an album into or out of a collection keeps its row and only its neighbours change.
 *
 * Reordering changes organization only: no access, membership or album row is touched. Fork-owned,
 * so it does not foreign-key into the official schema; rows for albums a person can no longer see
 * are ignored when the directory is read.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.album_position (
      "userId" uuid NOT NULL,
      "albumId" uuid NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY ("userId", "albumId")
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.album_position`.execute(db);
}
