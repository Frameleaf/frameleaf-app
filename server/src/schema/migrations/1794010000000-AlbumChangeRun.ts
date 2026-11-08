import { Kysely, sql } from 'kysely';

/** FL-1298: the record behind Undo for album merges, and later for cleanup and date healing. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.album_change_run (
      id uuid NOT NULL DEFAULT immich_uuid_v7(),
      "userId" uuid NOT NULL,
      kind text NOT NULL,
      status text NOT NULL DEFAULT 'running',
      "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
      "undoneAt" timestamp with time zone,
      summary jsonb NOT NULL DEFAULT '{}',
      CONSTRAINT album_change_run_pkey PRIMARY KEY (id),
      CONSTRAINT "album_change_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user" (id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT album_change_run_kind_check CHECK (kind = ANY (ARRAY['merge'::text, 'cleanup'::text, 'heal'::text])),
      CONSTRAINT album_change_run_status_check CHECK (status = ANY (ARRAY['running'::text, 'done'::text, 'failed'::text, 'undone'::text]))
    )
  `.execute(db);
  await sql`CREATE INDEX "album_change_run_userId_createdAt_idx" ON public.album_change_run ("userId", "createdAt")`.execute(db);
  await sql`
    CREATE TABLE public.album_change (
      "runId" uuid NOT NULL,
      seq integer NOT NULL,
      kind text NOT NULL,
      "albumId" uuid,
      "assetId" uuid,
      before jsonb,
      after jsonb,
      CONSTRAINT album_change_pkey PRIMARY KEY ("runId", seq),
      CONSTRAINT "album_change_runId_fkey" FOREIGN KEY ("runId") REFERENCES public.album_change_run (id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "album_change_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album (id) ON UPDATE CASCADE ON DELETE SET NULL,
      CONSTRAINT "album_change_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset (id) ON UPDATE CASCADE ON DELETE SET NULL
    )
  `.execute(db);
  await sql`CREATE INDEX "album_change_albumId_idx" ON public.album_change ("albumId")`.execute(db);
  await sql`CREATE INDEX "album_change_assetId_idx" ON public.album_change ("assetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.album_change`.execute(db);
  await sql`DROP TABLE public.album_change_run`.execute(db);
}
