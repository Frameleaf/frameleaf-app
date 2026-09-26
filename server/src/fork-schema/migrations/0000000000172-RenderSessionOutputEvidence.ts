import { Kysely, sql } from 'kysely';

/**
 * FL-42: a render session keeps the output evidence its conformance check verified at admission:
 * the encoder and decoder names (`codecs`) and the colour precision (`colorPrecision`: maximum bit
 * depth, HDR10, Dolby Vision). Studio exports are offered only when a live, qualified session
 * verified what the export needs; CUDA being present proves none of it.
 *
 * Existing sessions keep empty evidence (null), so they qualify for nothing new until the worker
 * is admitted again with a current conformance check. A database adopted from an official install
 * has no render worker tables, so there is nothing to change there.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.render_worker_session') IS NOT NULL THEN
        ALTER TABLE public.render_worker_session ADD COLUMN IF NOT EXISTS "codecs" character varying[];
        ALTER TABLE public.render_worker_session ADD COLUMN IF NOT EXISTS "colorPrecision" jsonb;
      END IF;
    END
    $$
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE IF EXISTS public.render_worker_session DROP COLUMN IF EXISTS "colorPrecision"`.execute(db);
  await sql`ALTER TABLE IF EXISTS public.render_worker_session DROP COLUMN IF EXISTS "codecs"`.execute(db);
}
