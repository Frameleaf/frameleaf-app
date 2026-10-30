import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE classification_rule ADD COLUMN filter jsonb;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE classification_rule DROP COLUMN filter;`.execute(db);
}
