import { Kysely, sql } from 'kysely';

/** FL-811: a video can be complete without a separate playback copy. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_job_status ADD COLUMN "transcodeSkippedFor" text`.execute(db);
  await sql`CREATE INDEX job_live_asset_step ON public.job (queue, name, (lower(data->>'id')) COLLATE "C")
    WHERE state IN ('pending', 'waiting', 'active')`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX public.job_live_asset_step`.execute(db);
  await sql`ALTER TABLE public.asset_job_status DROP COLUMN "transcodeSkippedFor"`.execute(db);
}
