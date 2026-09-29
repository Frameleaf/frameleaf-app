import { Kysely, sql } from 'kysely';

/**
 * FL-146 (AL-40): a new partner share does not include locations until the sharer turns it on, as the
 * prototype shows (`shareLocation: false`). Only the column default changes: partnerships that exist keep
 * whatever their sharer has now.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "partner" ALTER COLUMN "shareLocation" SET DEFAULT false`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "partner" ALTER COLUMN "shareLocation" SET DEFAULT true`.execute(db);
}
