import { Kysely, sql } from 'kysely';

/**
 * The steps each queued workflow run has completed (FL-179).
 *
 * When a worker stops mid-run, the queue replays the job with the same data from its first step. A
 * run now records each step it completes in `workflow_run_step`, keyed by the job's `executionId`, so
 * the replay skips them instead of running a step's changes or requests again. The table sits beside
 * the shared workflow schema; nothing in `workflow`, `workflow_step` or `workflow_log` changes shape.
 * Rows go with their workflow, and the nightly database cleanup removes old ones. `down` drops the
 * table; a replay then runs every step again, as before.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS "workflow_run_step" (
  "executionId" uuid NOT NULL,
  "stepId" uuid NOT NULL,
  "workflowId" uuid NOT NULL,
  "halted" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_run_step_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "workflow_run_step_pkey" PRIMARY KEY ("executionId", "stepId")
);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "workflow_run_step_workflowId_idx" ON "workflow_run_step" ("workflowId");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS "workflow_run_step";`.execute(db);
}
