import { Kysely, sql } from 'kysely';

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

/** Retention owns the job rows. Completed handlers are stopped; lease expiry alone is never evidence. */
export async function preserveAttemptEvidence(db: Kysely<any>, ids: string[]): Promise<string[]> {
  await sql`INSERT INTO system_metadata (key,value)
    SELECT ${ATTEMPT_EVIDENCE_PREFIX} || a.token::text,
      jsonb_build_object('jobId',a."jobId"::text,'stoppedAt',CASE WHEN a.outcome='completed' THEN extract(epoch FROM a."finishedAt")*1000
        ELSE (worker.value->>'stoppedAt')::numeric END,
        'recordedAt',extract(epoch FROM clock_timestamp())*1000,'seenPass',NULL)
    FROM job_attempt a LEFT JOIN system_metadata worker ON worker.key='frameleaf-worker-stopped:' || a."workerId"::text
      WHERE a."jobId"=ANY(${ids}::uuid[]) AND a."finishedAt" IS NOT NULL
        AND (a.outcome='completed' OR worker.value->>'workerId'=a."workerId"::text)
    ON CONFLICT (key) DO NOTHING`.execute(db);
  const { rows } = await sql<{ id: string }>`SELECT j.id FROM job j WHERE j.id=ANY(${ids}::uuid[])
    AND NOT EXISTS (SELECT 1 FROM job_attempt a WHERE a."jobId"=j.id AND NOT EXISTS (
      SELECT 1 FROM system_metadata m WHERE m.key=${ATTEMPT_EVIDENCE_PREFIX} || a.token::text
        AND m.value->>'jobId'=j.id::text AND m.value ? 'stoppedAt'))`.execute(db);
  return rows.map(({ id }) => id);
}

/** Complete traversals only, in small pages. Concurrently created evidence waits for the next pass. */
export async function pruneAttemptEvidence(db: Kysely<any>, pass: { id: string; startedAt: number }) {
  const { rows } = await sql`DELETE FROM system_metadata WHERE key IN (
    SELECT m.key FROM system_metadata m WHERE starts_with(m.key, ${ATTEMPT_EVIDENCE_PREFIX})
      AND (m.value->>'recordedAt')::numeric < ${pass.startedAt}
      AND m.value->>'seenPass' IS DISTINCT FROM ${pass.id}
      AND NOT EXISTS (SELECT 1 FROM job_attempt a WHERE a.token=substring(m.key from ${ATTEMPT_EVIDENCE_PREFIX.length + 1}::integer)::uuid)
    ORDER BY m.key LIMIT 250 FOR UPDATE SKIP LOCKED
  ) RETURNING key`.execute(db);
  return rows.length;
}
