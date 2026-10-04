import { Kysely, sql } from 'kysely';
import { QUEUE_BATCH } from 'src/queue/types.js';
import { preserveAttemptEvidence, pruneWorkerStopEvidence } from 'src/utils/attempt-evidence.js';

/** Retain run outcomes; bound payload/attempt cleanup independently of media execution. */
export async function pruneQueueHistory(db: Kysely<any>): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const {
      rows: [lock],
    } = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(-333, 1) acquired`.execute(tx);
    if (!lock.acquired) return 0;
    const { rows } = await sql<{ id: string }>`select j.id from job j
      where j.state in ('completed','failed','cancelled','blocked') and j."latestPending" is null
        and j."finishedAt" < now() - case when j.state = 'completed' then interval '7 days' else interval '30 days' end
        and not exists(select 1 from job child where child."parentId" = j.id)
        and not exists(select 1 from job_run_item i join job_run r on r.id = i."runId"
          where i."jobId" = j.id and r."finishedAt" is null)
        and not exists(select 1 from job_attempt a where a."jobId" = j.id
          and (a.outcome is distinct from 'completed' or a."finishedAt" is null)
          and not exists(select 1 from system_metadata m
            where m.key='frameleaf-attempt-evidence:' || a.token::text
              and m.value->>'jobId'=j.id::text and m.value ? 'stoppedAt')
          and not exists(select 1 from system_metadata m
            where m.key='frameleaf-worker-stopped:' || a."workerId"::text
              and m.value->>'workerId'=a."workerId"::text and m.value ? 'stoppedAt'))
      order by j."finishedAt", j.id limit ${QUEUE_BATCH} for update of j skip locked`.execute(tx);
    let pruned = 0;
    if (rows.length) {
      const ids = await preserveAttemptEvidence(
        tx,
        rows.map(({ id }) => id),
      );
      pruned = ids.length;
      // The manifest, stage state and original root identity are retained. Old handler payloads
      // are no longer needed after every associated run closes.
      await sql`update job_run_item set "jobId" = null, selection = '{}'::jsonb
        where "jobId" = any(${ids}::uuid[])`.execute(tx);
      await sql`delete from job where id = any(${ids}::uuid[])`.execute(tx);
    }
    await sql`delete from job_worker where id in (
      select w.id from job_worker w where w.state = 'lost' and w."heartbeatAt" < now() - interval '7 days'
        and not exists(select 1 from job j where j."workerId" = w.id)
        and not exists(select 1 from job_attempt a where a."workerId" = w.id)
      order by w."heartbeatAt" limit ${QUEUE_BATCH} for update skip locked
    )`.execute(tx);
    await pruneWorkerStopEvidence(tx);
    return pruned;
  });
}
