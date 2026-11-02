import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.asset_original (
    "assetId" uuid NOT NULL REFERENCES public.asset(id) ON DELETE CASCADE ON UPDATE CASCADE,
    "physicalFileId" uuid NOT NULL REFERENCES public.physical_file(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    "originalFileName" character varying NOT NULL,
    PRIMARY KEY ("assetId", "physicalFileId")
  )`.execute(db);
  await sql`CREATE INDEX "asset_original_physicalFileId_idx" ON public.asset_original ("physicalFileId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    LOCK TABLE public.asset_original IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.asset_original) THEN
      RAISE EXCEPTION 'Additional originals must be preserved before downgrading';
    END IF;
    DROP TABLE public.asset_original;
  END $$`.execute(db);
}
