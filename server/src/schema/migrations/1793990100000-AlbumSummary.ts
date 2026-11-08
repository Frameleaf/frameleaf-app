import { Kysely, sql } from 'kysely';

/** FL-1297: each album's count and dates per viewer variant, so listing albums never aggregates. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.album_summary (
      "albumId" uuid NOT NULL,
      "viewerKey" text NOT NULL,
      "assetCount" integer NOT NULL,
      "startDate" date,
      "endDate" date,
      "lastModifiedAssetTimestamp" timestamp with time zone,
      "computedAt" timestamp with time zone NOT NULL,
      CONSTRAINT "album_summary_pkey" PRIMARY KEY ("albumId", "viewerKey"),
      CONSTRAINT "album_summary_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album (id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.album_summary`.execute(db);
}
