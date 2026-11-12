import { Kysely, sql } from 'kysely';

/**
 * FL-1485: every job execution used to write a `frameleaf-attempt-evidence:` row into system_metadata, kept for as
 * long as a file the job made existed: 7.8 million rows on a 900,000 photo library. A cleanly completed attempt
 * is its own proof and a job that is gone needs none, so only the proof of an attempt that is still in
 * `job_attempt` and did not complete stays.
 * ponytail: one DELETE; the space goes back to the table, not the disk. `VACUUM FULL system_metadata` returns it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  if (!db.isTransaction) return db.transaction().execute(up);
  await sql`SET LOCAL statement_timeout = 0`.execute(db);
  await sql`
    DELETE FROM system_metadata m
    WHERE starts_with(m.key, 'frameleaf-attempt-evidence:')
      AND NOT EXISTS (
        SELECT 1 FROM job_attempt a
        WHERE a.token::text = substring(m.key from 28)
          AND (a.outcome IS DISTINCT FROM 'completed' OR a."finishedAt" IS NULL)
      )
  `.execute(db);
}

export async function down(): Promise<void> {}
