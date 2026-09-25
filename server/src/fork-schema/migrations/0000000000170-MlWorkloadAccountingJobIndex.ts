import { Kysely, sql } from 'kysely';

/**
 * FL-71: the Job manager's Worker column reads, for each listed job, the destination of its latest
 * accounted machine-learning request (`MlDestinationRepository.getLatestJobDestinations`:
 * `WHERE "jobId" IN (…) AND "jobName" IN (…) ORDER BY "jobId", "jobName", "startedAt" DESC`).
 * Without this index that is a scan of the whole accounting table on every refresh of a queue's
 * job list. Rows without a job (probes, previews) are left out of it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS "ml_workload_accounting_jobId_jobName_startedAt_idx"
      ON public.ml_workload_accounting ("jobId", "jobName", "startedAt" DESC)
      WHERE ("jobId" IS NOT NULL)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public."ml_workload_accounting_jobId_jobName_startedAt_idx"`.execute(db);
}
