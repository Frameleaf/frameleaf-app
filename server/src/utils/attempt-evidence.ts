import { Kysely, type QueryExecutorProvider, sql } from 'kysely';

export const ATTEMPT_EVIDENCE_PREFIX = 'frameleaf-attempt-evidence:';

/** Called only after the executor returned or its worker and native children were confirmed stopped. */
export async function recordStoppedAttempt(db: Kysely<any>, jobId: string, token: string) {
  await db.transaction().execute(async (tx) => {
    await sql`SET LOCAL lock_timeout='1s'`.execute(tx);
    await sql`SET LOCAL statement_timeout='3s'`.execute(tx);
    await sql`INSERT INTO system_metadata (key,value)
    VALUES (${ATTEMPT_EVIDENCE_PREFIX + token}, jsonb_build_object('jobId',${jobId}::text,
      'stoppedAt',extract(epoch FROM clock_timestamp())*1000,
      'recordedAt',extract(epoch FROM clock_timestamp())*1000,'seenPass',NULL))
    ON CONFLICT (key) DO NOTHING`.execute(tx);
  });
}

export async function pruneWorkerStopEvidence(db: Kysely<any>) {
  await sql`DELETE FROM system_metadata WHERE key IN (
    SELECT m.key FROM system_metadata m WHERE starts_with(m.key, 'frameleaf-worker-stopped:')
      AND NOT EXISTS (SELECT 1 FROM job_worker w WHERE w.id=(m.value->>'workerId')::uuid)
      AND NOT EXISTS (SELECT 1 FROM job_attempt a WHERE a."workerId"=(m.value->>'workerId')::uuid)
      AND NOT EXISTS (SELECT 1 FROM job j WHERE j."workerId"=(m.value->>'workerId')::uuid)
    ORDER BY m.key LIMIT 250 FOR UPDATE SKIP LOCKED)`.execute(db);
}

/**
 * FL-1485: retention deletes the proof with the job. Once a job is gone its outputs need none (`sweepAttemptOutputs`),
 * and keeping one row per pruned job put millions of rows into system_metadata.
 */
export async function dropAttemptEvidence(db: Kysely<any>, ids: string[]) {
  await sql`DELETE FROM system_metadata WHERE key IN (
    SELECT ${ATTEMPT_EVIDENCE_PREFIX} || a.token::text FROM job_attempt a WHERE a."jobId"=ANY(${ids}::uuid[]))`.execute(
    db,
  );
}

/** Complete traversals only, in small pages. Concurrently created evidence waits for the next pass. */
export async function pruneAttemptEvidence(db: QueryExecutorProvider, pass: { id: string; startedAt: number }) {
  const { rows } = await sql`DELETE FROM system_metadata WHERE key IN (
    SELECT m.key FROM system_metadata m WHERE starts_with(m.key, ${ATTEMPT_EVIDENCE_PREFIX})
      AND (m.value->>'recordedAt')::numeric < ${pass.startedAt}
      AND m.value->>'seenPass' IS DISTINCT FROM ${pass.id}
      AND NOT EXISTS (SELECT 1 FROM job_attempt a WHERE a.token=substring(m.key from ${ATTEMPT_EVIDENCE_PREFIX.length + 1}::integer)::uuid)
    ORDER BY m.key LIMIT 250 FOR UPDATE SKIP LOCKED
  ) RETURNING key`.execute(db);
  return rows.length;
}
