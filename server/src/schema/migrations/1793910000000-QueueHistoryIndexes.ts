import { Kysely, sql } from 'kysely';

/**
 * FL-1213: indexes for queue history at million-item scale. Queue status counts each queue's jobs
 * by state, kept history included (a full table scan per queue before); maintenance sweeps
 * `system_metadata` by key prefix every 30 seconds (a full scan of every attempt-evidence row before).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS "job_queue_state_idx" ON "job" ("queue", "state", "availableAt")`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "system_metadata_key_prefix_idx" ON "system_metadata" ("key" text_pattern_ops)`.execute(
    db,
  );
}

/** Drops both indexes; the reads they serve still work, only slower. */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "system_metadata_key_prefix_idx"`.execute(db);
  await sql`DROP INDEX IF EXISTS "job_queue_state_idx"`.execute(db);
}
