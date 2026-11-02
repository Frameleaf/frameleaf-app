import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`create index asset_owner_taken_page_idx on public.asset
    ("ownerId", (date_trunc('MONTH', "localDateTime" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
    (("localDateTime" AT TIME ZONE 'UTC')::date), "fileCreatedAt", "originalFileName", id)`.execute(db);
  await sql`create index asset_owner_added_page_idx on public.asset
    ("ownerId", (date_trunc('MONTH', "createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
    (("createdAt" AT TIME ZONE 'UTC')::date), "createdAt", "originalFileName", id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index public.asset_owner_added_page_idx`.execute(db);
  await sql`drop index public.asset_owner_taken_page_idx`.execute(db);
}
