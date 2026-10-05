// A terminal queue state is accounting, not proof that its executor stopped. Keep this
// predicate aligned with server/src/queue/retention.ts, including already-cleared jobs.
const executionBlockerSql = `
  SELECT 'attempt' AS kind, a."jobId"::text AS id,
    coalesce(j.state = 'active' AND j.token = a.token, false) AS active
  FROM job_attempt a LEFT JOIN job j ON j.id = a."jobId"
  WHERE (a.outcome IS DISTINCT FROM 'completed' OR a."finishedAt" IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM system_metadata m
      WHERE m.key = 'frameleaf-attempt-evidence:' || a.token::text
        AND m.value->>'jobId' = a."jobId"::text AND m.value ? 'stoppedAt'
    )
    AND NOT EXISTS (
      SELECT 1 FROM system_metadata m
      WHERE m.key = 'frameleaf-worker-stopped:' || a."workerId"::text
        AND m.value->>'workerId' = a."workerId"::text AND m.value ? 'stoppedAt'
    )
  UNION ALL
  SELECT 'operation' AS kind, id::text, false AS active
  FROM media_operation WHERE "errorCode" = 'executor_stop_unconfirmed'
  LIMIT 1
`;

/**
 * @param {(text: string) => Promise<{rows: {kind: 'attempt' | 'operation', id: string, active: boolean}[]}>} query
 */
export const getResetExecutionBlocker = async (query) => (await query(executionBlockerSql)).rows[0];

/**
 * The failed domain row may no longer retain its executor identity after sensitive payload
 * cleanup. Never clear that unresolved error or infer stop from its null claim. It needs real
 * worker reconciliation; even a proof for some other retained attempt cannot authorize reset.
 * @param {{kind: 'attempt' | 'operation', id: string}} blocker
 */
export const resetExecutionRefusal = (blocker) =>
  new Error(`Reset refused: executor stop is unconfirmed for retained ${blocker.kind} ${blocker.id}`);

/**
 * @param {Parameters<typeof getResetExecutionBlocker>[0]} query
 * @param {() => Promise<boolean>} drain
 */
export const drainAfterExecutorStop = async (query, drain) => {
  const blocker = await getResetExecutionBlocker(query);
  if (blocker) {
    if (!blocker.active) {
      throw resetExecutionRefusal(blocker);
    }
    // Request cancellation separately, then join its real stop within the caller's deadline.
    return true;
  }
  return drain();
};

/** @param {Parameters<typeof getResetExecutionBlocker>[0]} query */
export const assertResetExecutionsStopped = async (query) => {
  const blocker = await getResetExecutionBlocker(query);
  if (blocker) {
    throw resetExecutionRefusal(blocker);
  }
};
