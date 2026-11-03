import { Kysely, sql } from 'kysely';

/**
 * FL-522: a person can hide one of their smart albums from their own library. `smart_album` is one row
 * per person and kind, so the choice is theirs alone; the album keeps filling while hidden.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "smart_album" ADD "hiddenAt" timestamp with time zone`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "smart_album" DROP COLUMN "hiddenAt"`.execute(db);
}
