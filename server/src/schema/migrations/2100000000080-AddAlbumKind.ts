import { Kysely, sql } from 'kysely';

/**
 * An album row is one of three kinds: an album (holds photos), a collection
 * (a named group of albums, one level deep) or a shared space (top level).
 *
 * Saved data that nested albums inside albums promotes the parent to a
 * collection, except albums the smart album rules fill. Nothing is deleted or
 * re-parented here; the tree endpoint tolerates deeper legacy nesting and the
 * move rules only apply to new writes.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE album ADD COLUMN kind text NOT NULL DEFAULT 'album'`.execute(db);
  await sql`ALTER TABLE album ADD CONSTRAINT album_kind_check CHECK (kind = ANY (ARRAY['album'::text, 'collection'::text, 'space'::text]))`.execute(
    db,
  );
  await sql`
    UPDATE album
    SET kind = 'collection'
    WHERE kind = 'album'
      AND id IN (SELECT DISTINCT "parentId" FROM album WHERE "parentId" IS NOT NULL)
      AND id NOT IN (SELECT "albumId" FROM smart_album)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE album DROP CONSTRAINT album_kind_check`.execute(db);
  await sql`ALTER TABLE album DROP COLUMN kind`.execute(db);
}
