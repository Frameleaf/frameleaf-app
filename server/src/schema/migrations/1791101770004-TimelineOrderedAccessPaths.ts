import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`create index asset_owner_filename_order_idx on public.asset
    ("ownerId", "originalFileName" collate "und-x-icu", "fileCreatedAt" desc, id)`.execute(db);
  await sql`create index asset_exif_rating_order_idx on public.asset_exif
    ((coalesce(rating, 0)) desc, "assetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index public.asset_exif_rating_order_idx`.execute(db);
  await sql`drop index public.asset_owner_filename_order_idx`.execute(db);
}
