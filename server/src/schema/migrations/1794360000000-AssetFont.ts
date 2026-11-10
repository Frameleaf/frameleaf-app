import { Kysely, sql } from 'kysely';

/** FL-1359: fonts in Boards. One row of facts beside each font asset. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.asset_font (
      "assetId" uuid NOT NULL,
      family text NOT NULL,
      style text NOT NULL,
      weight integer,
      italic boolean NOT NULL DEFAULT false,
      "glyphCount" integer NOT NULL DEFAULT 0,
      axes jsonb NOT NULL DEFAULT '[]',
      instances jsonb NOT NULL DEFAULT '[]',
      features jsonb NOT NULL DEFAULT '[]',
      scripts jsonb NOT NULL DEFAULT '[]',
      license text,
      "licenseUrl" text,
      faces jsonb NOT NULL DEFAULT '[]',
      "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT asset_font_pkey PRIMARY KEY ("assetId"),
      CONSTRAINT "asset_font_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset (id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.asset_font`.execute(db);
}
