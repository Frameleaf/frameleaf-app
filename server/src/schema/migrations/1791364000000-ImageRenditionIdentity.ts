import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table public.asset_file add column "renditionIdentity" varchar`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table public.asset_file drop column "renditionIdentity"`.execute(db);
}
