import { Kysely, sql } from 'kysely';

/** Preserve last-per-type ACKs while new space identities bootstrap newest first. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE session_tag_sync_state ADD COLUMN "deliveryOrder" bigint;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE session_tag_sync_state DROP COLUMN "deliveryOrder";`.execute(db);
}
