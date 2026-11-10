import { Kysely, sql } from 'kysely';

/** FL-811: a video can be complete without a separate playback copy. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_job_status ADD COLUMN "transcodeSkippedFor" text`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_job_status DROP COLUMN "transcodeSkippedFor"`.execute(db);
}
