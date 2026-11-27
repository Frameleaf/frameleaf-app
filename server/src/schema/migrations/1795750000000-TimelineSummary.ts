import { Kysely, sql } from 'kysely';

/** FL-1792: each month of a timeline summary as last ranked, so a server start does not rank the library again. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.timeline_summary (
      key text NOT NULL,
      "timeBucket" text NOT NULL,
      "userId" uuid NOT NULL,
      fingerprint text NOT NULL,
      pages jsonb NOT NULL,
      "usedAt" timestamp with time zone NOT NULL,
      CONSTRAINT "timeline_summary_pkey" PRIMARY KEY (key, "timeBucket"),
      CONSTRAINT "timeline_summary_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user" (id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX "timeline_summary_userId_idx" ON public.timeline_summary ("userId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.timeline_summary`.execute(db);
}
