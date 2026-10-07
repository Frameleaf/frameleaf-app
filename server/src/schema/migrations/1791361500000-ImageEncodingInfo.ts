import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table public.asset_exif add column "imageEncoding" jsonb`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table public.asset_exif drop column "imageEncoding"`.execute(db);
}
