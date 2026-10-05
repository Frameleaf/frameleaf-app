import { Kysely, sql } from 'kysely';
import { QUEUE_BATCH } from 'src/queue/types.js';
import { preserveAttemptEvidence, pruneWorkerStopEvidence } from 'src/utils/attempt-evidence.js';

const RETENTION_CURSOR = 'frameleaf-queue-retention-cursor';

/** Retain run outcomes; bound payload/attempt cleanup independently of media execution. */
export async function pruneQueueHistory(db: Kysely<any>): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const {
      rows: [lock],
    } = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(-333, 1) acquired`.execute(tx);
    if (!lock.acquired) return 0;
    const {
      rows: [cursor],
    } = await sql<{
      finishedAt: string | null;
      id: string | null;
      throughAt: string | null;
      throughId: string | null;
    }>`select value->>'finishedAt' as "finishedAt", (value->>'id')::uuid as id,
      value->>'throughAt' as "throughAt", (value->>'throughId')::uuid as "throughId"
      from system_metadata where key=${RETENTION_CURSOR}`.execute(tx);
    const continuing = !!(cursor?.throughAt && cursor.throughId);
    const through = continuing
      ? cursor
      : (
          await sql<{
            throughAt: string;
            throughId: string;
          }>`select id as "throughId", "finishedAt"::text as "throughAt" from job
            where state in ('completed','failed','cancelled','blocked') and "latestPending" is null
              and "finishedAt" is not null order by job."finishedAt" desc,id desc limit 1`.execute(tx)
        ).rows[0];
    // LIMIT must precede dependency/evidence checks. Otherwise an ineligible parent prefix
    // can force every coordinator sweep to rescan the entire retained history.
    const candidates = through
      ? (
          await sql<{ id: string; finishedAt: string }>`select id, "finishedAt"::text from job
      where state in ('completed','failed','cancelled','blocked') and "latestPending" is null
        and "finishedAt" is not null
        and ("finishedAt",id) <= (${through.throughAt}::timestamptz,${through.throughId}::uuid)
        ${continuing && cursor?.finishedAt && cursor.id ? sql`and ("finishedAt",id) > (${cursor.finishedAt}::timestamptz,${cursor.id}::uuid)` : sql``}
      order by job."finishedAt", id limit ${QUEUE_BATCH}`.execute(tx)
        ).rows
      : [];
    const last = candidates.at(-1);
    // Freeze the pass end so new completions cannot prevent revisiting blocked parents.
    // Cursor and deletion commit together; interruption cannot skip a partially checked page.
    await sql`insert into system_metadata(key,value) values (${RETENTION_CURSOR},
      ${
        last && candidates.length === QUEUE_BATCH
          ? sql`jsonb_build_object('finishedAt',${last.finishedAt}::timestamptz,'id',${last.id}::uuid,
        'throughAt',${through!.throughAt}::timestamptz,'throughId',${through!.throughId}::uuid)`
          : sql`'{}'::jsonb`
      })
      on conflict(key) do update set value=excluded.value`.execute(tx);
    // Lock only the selected page. LIMIT with SKIP LOCKED alone scans past every locked row.
    const { rows: locked } = await sql<{ id: string }>`select id from job
      where id=any(${candidates.map(({ id }) => id)}::uuid[]) for update skip locked`.execute(tx);
    const { rows } = await sql<{ id: string }>`select j.id from job j
      where j.id = any(${locked.map(({ id }) => id)}::uuid[])
        and j.state in ('completed','failed','cancelled','blocked') and j."latestPending" is null
        and j."finishedAt" < now() - case when j.state = 'completed' then interval '7 days' else interval '30 days' end
        and not exists(select 1 from job child where child."parentId" = j.id)
        and not exists(select 1 from job_run_item child where child."libraryParentId"=j.id and not child."libraryOriginComplete")
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
      order by j."finishedAt", j.id`.execute(tx);
    let pruned = 0;
    if (rows.length > 0) {
      const ids = await preserveAttemptEvidence(
        tx,
        rows.map(({ id }) => id),
      );
      pruned = ids.length;
      // The manifest, stage state and original root identity are retained. Old handler payloads
      // are no longer needed after every associated run closes.
      await sql`update job_run_item i set state=case when i.state='cancelled' then i.state else j.state end, "jobId" = null, selection = '{}'::jsonb,
        "libraryIntent" = case when "libraryIntent" is null then null
          else "libraryIntent" - 'options' || jsonb_build_object('data', '{}'::jsonb) end
        from job j where i."jobId"=j.id and j.id = any(${ids}::uuid[])`.execute(tx);
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
