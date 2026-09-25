import { Kysely, sql } from 'kysely';

/**
 * FL-159: Frameleaf Cloud usage reconciliation (`MlDestinationRepository.applySettlements`) matches
 * settled charges to their accounting rows by `cloudJobId`. Without this index each reconcile is a scan
 * of the whole accounting table. Only rows sent to Frameleaf Cloud carry a cloud job id.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // A database adopted from an official install (official-origin) has no machine-learning
  // accounting table, so there is nothing to index there.
  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.ml_workload_accounting') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS "ml_workload_accounting_cloudJobId_idx"
          ON public.ml_workload_accounting ("cloudJobId")
          WHERE ("cloudJobId" IS NOT NULL);
      END IF;
    END
    $$
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public."ml_workload_accounting_cloudJobId_idx"`.execute(db);
}
