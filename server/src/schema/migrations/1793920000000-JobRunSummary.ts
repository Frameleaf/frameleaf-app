import { Kysely, sql } from 'kysely';

/**
 * FL-1215: a finished run's counts, stored once they can no longer change, so Activity never recounts its
 * ledger again. Null until the queue coordinator has summarised the run; existing runs are summarised then.
 * `job_run_live` answers "does this run still have a live job" without reading the run's kept history
 * (4M rows after a 1M-item scan); it holds live jobs only.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "job_run" ADD COLUMN IF NOT EXISTS "summary" jsonb`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "job_run_live" ON "job" ("runId")
    WHERE "runId" IS NOT NULL AND state IN ('pending','waiting','active')`.execute(db);
}

/**
 * Reads recount every run from its ledger again. Refused once any run's ledger has been pruned: those counts live
 * only in the summary. Holds the pruning lock, so a sweep cannot prune between the check and the drop.
 */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(-333, 3)`.execute(db);
  const { rows } = await sql`SELECT 1 FROM "job_run"
    WHERE "summary" ? 'ledgerAfter' OR "summary"->>'ledgerPruned' = 'true' LIMIT 1`.execute(db);
  if (rows.length > 0) throw new Error('Cannot revert JobRunSummary: some run ledgers were already pruned');
  await sql`DROP INDEX IF EXISTS "job_run_live"`.execute(db);
  await sql`ALTER TABLE "job_run" DROP COLUMN IF EXISTS "summary"`.execute(db);
}
