import { Kysely, sql } from 'kysely';

/**
 * FL-1479: a job's `availableAt` is both when it may run and its place in line. A retry or a wait for a busy server
 * replaces it, so a job started by hand or for photos that just came in came back behind the whole backlog.
 * `resumeAt` keeps that place while the job waits; `job_resume` finds the jobs whose wait is over.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "resumeAt" timestamp with time zone`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "job_resume" ON "job" ("queue", "availableAt")
    WHERE "resumeAt" IS NOT NULL AND state IN ('pending','waiting')`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "job_resume"`.execute(db);
  await sql`ALTER TABLE "job" DROP COLUMN IF EXISTS "resumeAt"`.execute(db);
}
