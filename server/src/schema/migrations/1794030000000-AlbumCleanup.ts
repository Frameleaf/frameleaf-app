import { Kysely, sql } from 'kysely';

/**
 * FL-1300: what the Magic Albums cleanup scan found, a cleanup while it is applied, and the marker that stops a
 * phone sync recreating an album the person removed.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.album_cleanup_snapshot (
      "userId" uuid NOT NULL,
      variant text NOT NULL,
      facts jsonb NOT NULL,
      "suggestionCount" integer NOT NULL,
      "computedAt" timestamp with time zone NOT NULL,
      CONSTRAINT album_cleanup_snapshot_pkey PRIMARY KEY ("userId", variant),
      CONSTRAINT "album_cleanup_snapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user" (id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
  await sql`
    CREATE TABLE public.album_cleanup_apply (
      "runId" uuid NOT NULL,
      operations jsonb NOT NULL,
      "nextIndex" integer NOT NULL DEFAULT 0,
      targets jsonb NOT NULL DEFAULT '{}',
      tally jsonb NOT NULL DEFAULT '{}',
      elevated boolean NOT NULL DEFAULT false,
      "progressAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT album_cleanup_apply_pkey PRIMARY KEY ("runId"),
      CONSTRAINT "album_cleanup_apply_runId_fkey" FOREIGN KEY ("runId") REFERENCES public.album_change_run (id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
  await sql`ALTER TABLE public.album_source_link ADD COLUMN "stayRemoved" boolean NOT NULL DEFAULT false`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.album_source_link DROP COLUMN "stayRemoved"`.execute(db);
  await sql`DROP TABLE public.album_cleanup_apply`.execute(db);
  await sql`DROP TABLE public.album_cleanup_snapshot`.execute(db);
}
