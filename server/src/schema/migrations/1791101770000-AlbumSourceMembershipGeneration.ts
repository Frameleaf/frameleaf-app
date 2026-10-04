import { Kysely, sql } from 'kysely';

/** A source owns only the membership generation it actually inserted. */
export async function up(db: Kysely<any>): Promise<void> {
  // Existing claims have no provable generation; leave them without removal authority.
  await sql`alter table public.album_source_asset add column "membershipUpdateId" uuid`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table public.album_source_asset drop column "membershipUpdateId"`.execute(db);
}
