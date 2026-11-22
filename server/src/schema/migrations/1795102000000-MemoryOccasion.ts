import { Kysely, sql } from 'kysely';

/** FL-880: which occasion a memory was made for (Mother's Day, Father's Day); null for every other memory. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "memory" ADD COLUMN "occasion" text;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "memory" DROP COLUMN "occasion";`.execute(db);
}
