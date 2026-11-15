import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE photo_source ADD COLUMN catalog jsonb`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE photo_source DROP COLUMN catalog`.execute(db);
}
