import { Kysely, sql } from 'kysely';

/** FL-923: an album can say it holds scans, so uploads into it are offered a split. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" ADD COLUMN "holdsScans" boolean NOT NULL DEFAULT false;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" DROP COLUMN "holdsScans";`.execute(db);
}
