import { Kysely, sql } from 'kysely';

/**
 * FL-1560: the start timecode a video records. Empty for every existing asset until its metadata is
 * read again, so the column is added without rewriting the table.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_exif ADD COLUMN "timecode" text`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_exif DROP COLUMN "timecode"`.execute(db);
}
