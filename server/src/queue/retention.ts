import { Kysely, sql } from 'kysely';
import { performance } from 'node:perf_hooks';
import { QUEUE_BATCH } from 'src/queue/types.js';
import { preserveAttemptEvidence, pruneWorkerStopEvidence } from 'src/utils/attempt-evidence.js';

const RETENTION_CURSOR = 'frameleaf-queue-retention-cursor';

/** Retain run outcomes; bound payload/attempt cleanup independently of media execution. */
export async function pruneQueueHistory(db: Kysely<any>): Promise<number> {
  return (await pruneQueueHistoryPage(db)).pruned;
}

/**
 * One retention page: how many jobs it deleted, and whether it read a full page of candidates (so more
 * history may follow). A full page can delete fewer than a page when some jobs must still be kept.
 */
export async function pruneQueueHistoryPage(db: Kysely<any>): Promise<{ pruned: number; fullPage: boolean }> {
  return db.transaction().execute(async (tx) => {
    const {
      rows: [lock],
    } = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(-333, 1) acquired`.execute(tx);
    if (!lock.acquired) return { pruned: 0, fullPage: false };
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
    return { pruned, fullPage: candidates.length === QUEUE_BATCH };
  });
}

const LEDGER_BATCH = 5000;

/**
 * FL-1215: a summarised run's item rows serve nothing once its own jobs are pruned (so nothing can retry or
 * re-arm them) and no other run reads them. They go 30 days after the run finished, like failed jobs; the run
 * keeps its summary, so Activity still lists it with the same counts, without the per-item list. Its few
 * selection headers stay (one per stage), as they always have.
 *
 * Kept for good: Manager and Immich imports (their manifest is the import's identity check), pet recognition
 * (it reads the ledger when the run settles), library scans and any frozen selection another run shares or
 * whose lineage a library proof reads.
 */
const prunableRun = sql<boolean>`r.summary->>'complete' = 'true' and (r.summary->>'finishedAt')::timestamptz = r."finishedAt"
  and not coalesce((r.summary->>'ledgerPruned')::boolean, false)
  and r."finishedAt" < now() - interval '30 days'
  and r.kind not in ('immich-import-derived','library-import-derived')
  and not (r.selection ? 'managerSetup' or r.selection ? 'managerSetupRequired' or r.selection ? 'petRunId')
  and not exists (select 1 from job j where j."runId" = r.id)
  and not exists (select 1 from job_selection_run m join job_selection s on s.id = m."selectionId"
    where m."runId" = r.id and (s."sourceKind" <> 'frozen' or s."runId" <> r.id))
  and not exists (select 1 from job_selection s join job_selection_run m on m."selectionId" = s.id
    where s."runId" = r.id and m."runId" <> r.id)
  and not exists (select 1 from job_selection s join job_selection_lineage l on l."selectionId" = s.id where s."runId" = r.id)
  and not exists (select 1 from job_selection_lineage l where l."runId" = r.id)
  and not exists (select 1 from job_run_item o where o."libraryExecutionRunId" = r.id)`;

/**
 * Deletes summarised runs' item rows, a batch per statement, for up to `budgetMs`. Each batch starts after the
 * last one's key (`ledgerAfter`): the deleted rows stay in the index until vacuum, and a batch that started at
 * the run's first key would walk all of them again.
 */
export async function pruneRunLedger(db: Kysely<any>, budgetMs: number): Promise<number> {
  const start = performance.now();
  let pruned = 0;
  while (performance.now() - start < budgetMs) {
    const deleted = await db.transaction().execute(async (tx) => {
      const {
        rows: [lock],
      } = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(-333, 3) acquired`.execute(tx);
      if (!lock.acquired) return 0;
      const {
        rows: [run],
      } = await sql<{ id: string; itemKey: string | null; stage: string | null }>`select r.id,
          r.summary #>> '{ledgerAfter,itemKey}' "itemKey", r.summary #>> '{ledgerAfter,stage}' stage
        from job_run r where ${prunableRun}
        order by r."finishedAt", r.id limit 1 for update skip locked`.execute(tx);
      if (!run) return 0;
      const {
        rows: [batch],
      } = await sql<{ count: number; itemKey: string | null; stage: string | null }>`with doomed as materialized (
          select "runId", "itemKey", stage from job_run_item where "runId" = ${run.id}::uuid
            ${run.itemKey === null ? sql`` : sql`and ("itemKey", stage) > (${run.itemKey}, ${run.stage})`}
          order by "itemKey", stage limit ${LEDGER_BATCH}
        ), gone as (
          delete from job_run_item i using doomed d
          where (i."runId", i."itemKey", i.stage) = (d."runId", d."itemKey", d.stage) returning 1
        ) select (select count(*)::int from gone) count, last."itemKey", last.stage
        from (select 1) one left join lateral (
          select "itemKey", stage from doomed order by "itemKey" desc, stage desc limit 1) last on true`.execute(tx);
      const done = batch.count < LEDGER_BATCH;
      await sql`update job_run set summary = summary || ${JSON.stringify(
        done ? { ledgerPruned: true } : { ledgerAfter: { itemKey: batch.itemKey, stage: batch.stage } },
      )}::text::jsonb where id = ${run.id}::uuid`.execute(tx);
      // A run whose last batch was empty still counts as one step, so the loop moves on.
      return Math.max(batch.count, 1);
    });
    if (deleted === 0) break;
    pruned += deleted;
  }
  return pruned;
}
