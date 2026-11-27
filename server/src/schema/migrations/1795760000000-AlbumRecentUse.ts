import { Kysely, sql } from 'kysely';

// FL-1814: the albums each account itself last added items to, for the album picker's "Used lately".
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.album_recent_use (
      "userId" uuid NOT NULL,
      "albumId" uuid NOT NULL,
      "usedAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT album_recent_use_pkey PRIMARY KEY ("userId", "albumId"),
      CONSTRAINT "album_recent_use_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user" (id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "album_recent_use_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album (id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX "album_recent_use_albumId_idx" ON public.album_recent_use USING btree ("albumId")`.execute(db);
  await sql`CREATE INDEX "album_recent_use_userId_usedAt_idx" ON public.album_recent_use USING btree ("userId", "usedAt")`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.album_recent_use`.execute(db);
}
