import { Kysely, sql } from 'kysely';

/**
 * A source claim belongs to one actual album membership generation, not just an asset id.
 * Existing claims remain unknown: backfilling today's membership would invent ownership of a
 * possible manual replacement. Null generations therefore confer no removal authority.
 * Fork-owned only, with no official-schema foreign key or trigger.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE immich_fork.album_source_asset ADD COLUMN "membershipUpdateId" uuid`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE immich_fork.album_source_asset DROP COLUMN "membershipUpdateId"`.execute(db);
}
