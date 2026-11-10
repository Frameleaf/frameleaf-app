import { Kysely, sql } from 'kysely';

/** FL-879: restore drills and their signed reports. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.backup_restore_report (
      id uuid NOT NULL,
      target text NOT NULL,
      trigger text NOT NULL DEFAULT 'manual',
      "startedAt" timestamp with time zone NOT NULL,
      "finishedAt" timestamp with time zone,
      result text NOT NULL DEFAULT 'running',
      "failedStep" text,
      counts jsonb NOT NULL DEFAULT '{}',
      "sampleSize" integer NOT NULL DEFAULT 0,
      mismatches jsonb NOT NULL DEFAULT '[]',
      report jsonb,
      signature text,
      "keyFingerprint" text,
      "signerKey" jsonb,
      CONSTRAINT backup_restore_report_pkey PRIMARY KEY (id)
    )
  `.execute(db);
  await sql`CREATE INDEX "backup_restore_report_startedAt_idx" ON public.backup_restore_report ("startedAt")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.backup_restore_report`.execute(db);
}
