import { Kysely, sql } from 'kysely';

/** Year in Review groundwork: per-person, per-asset, per-day viewer open counts from web, iOS and Android. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.asset_view (
      "userId" uuid NOT NULL,
      "assetId" uuid NOT NULL,
      "viewedOn" date NOT NULL,
      "viewCount" integer NOT NULL DEFAULT 1,
      "lastViewedAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT asset_view_pkey PRIMARY KEY ("userId", "assetId", "viewedOn"),
      CONSTRAINT "asset_view_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user" (id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "asset_view_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset (id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX "asset_view_assetId_idx" ON public.asset_view ("assetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.asset_view`.execute(db);
}
