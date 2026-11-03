import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE bookmark ADD COLUMN rating integer, ADD CONSTRAINT bookmark_rating_check CHECK (rating IS NULL OR rating = -1 OR rating BETWEEN 1 AND 5);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE bookmark DROP CONSTRAINT bookmark_rating_check, DROP COLUMN rating;`.execute(db);
}
