import { Kysely, sql } from 'kysely';

/**
 * "Always use the newest item" for an album cover (FL-83, AL-13). A row means the album's cover
 * follows its newest item (by the date items are taken, as the album timeline sorts them): the cover
 * moves when items are added or removed, and picking a specific item as the cover removes the row.
 * No row means the cover is the one picked by hand or the automatic cover.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema; the
 * row is removed with its album, and a row whose album is gone is ignored.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.album_cover_follows_newest (
      "albumId" uuid PRIMARY KEY,
      "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.album_cover_follows_newest`.execute(db);
}
