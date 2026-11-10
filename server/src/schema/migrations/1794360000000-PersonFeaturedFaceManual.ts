import { Kysely, sql } from 'kysely';

/** FL-1383: marks a featured face its owner picked, so a better-looking one never replaces it. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "person" ADD "isFeaturedFaceManual" boolean NOT NULL DEFAULT false;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "person" DROP COLUMN "isFeaturedFaceManual";`.execute(db);
}
