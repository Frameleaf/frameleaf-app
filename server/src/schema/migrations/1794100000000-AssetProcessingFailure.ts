import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.asset_processing_failure (
    "assetId" uuid NOT NULL REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE,
    step text NOT NULL,
    attempts integer NOT NULL,
    "lastError" text NOT NULL,
    "lastFailedAt" timestamptz NOT NULL,
    "quarantinedAt" timestamptz,
    "dismissedAt" timestamptz,
    PRIMARY KEY ("assetId", step)
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.asset_processing_failure`.execute(db);
}
