import { Kysely, sql } from 'kysely';

/** FL-1337: the append-only history of steps taken on each damaged or missing file. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.asset_health_step (
      id uuid NOT NULL DEFAULT immich_uuid_v7(),
      "healthId" uuid NOT NULL,
      "assetId" uuid NOT NULL,
      at timestamp with time zone NOT NULL DEFAULT now(),
      step text NOT NULL,
      outcome text NOT NULL,
      facts jsonb NOT NULL DEFAULT '{}',
      undo jsonb,
      CONSTRAINT asset_health_step_pkey PRIMARY KEY (id),
      CONSTRAINT "asset_health_step_healthId_fkey" FOREIGN KEY ("healthId") REFERENCES public.asset_health (id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "asset_health_step_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset (id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX "asset_health_step_healthId_at_id_idx" ON public.asset_health_step ("healthId", at, id)`.execute(db);
  await sql`CREATE INDEX "asset_health_step_assetId_idx" ON public.asset_health_step ("assetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.asset_health_step`.execute(db);
}
