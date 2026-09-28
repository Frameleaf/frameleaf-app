import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "partner" ADD COLUMN "shareLocation" boolean NOT NULL DEFAULT true`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "partner" DROP COLUMN "shareLocation"`.execute(db);
}
