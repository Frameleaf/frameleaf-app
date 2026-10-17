import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.render_worker ADD COLUMN "gpuWorkingBudgetApproval" jsonb`.execute(db);
  await sql`ALTER TABLE public.render_worker_session ADD COLUMN "gpuWorkingBudgetEvidence" jsonb`.execute(db);
  await sql`CREATE UNIQUE INDEX render_worker_session_budget_measurement_key ON public.render_worker_session
    (("gpuWorkingBudgetEvidence"->>'measurementId'))`.execute(db);
  await sql`CREATE UNIQUE INDEX render_worker_session_budget_receipt_key ON public.render_worker_session
    (("gpuWorkingBudgetEvidence"->>'receiptDigest'))`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX public.render_worker_session_budget_measurement_key, public.render_worker_session_budget_receipt_key`.execute(
    db,
  );
  await sql`ALTER TABLE public.render_worker_session DROP COLUMN "gpuWorkingBudgetEvidence"`.execute(db);
  await sql`ALTER TABLE public.render_worker DROP COLUMN "gpuWorkingBudgetApproval"`.execute(db);
}
