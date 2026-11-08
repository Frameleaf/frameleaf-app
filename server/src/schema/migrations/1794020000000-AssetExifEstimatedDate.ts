import { Kysely, sql } from 'kysely';

/**
 * FL-1299: the capture date that date healing estimated. Empty for every existing photo, so the column
 * is added without rewriting the table.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_exif ADD COLUMN "estimatedDateTimeOriginal" timestamp with time zone`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_exif DROP COLUMN "estimatedDateTimeOriginal"`.execute(db);
}
