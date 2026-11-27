import { Kysely, sql } from 'kysely';
import { recordQueueBatches } from 'src/queue/queue-problems.js';
import { type RunFolded, foldedOf } from 'src/queue/run-query.js';
import { QUEUE_BATCH } from 'src/queue/types.js';
import { dropAttemptEvidence, pruneWorkerStopEvidence } from 'src/utils/attempt-evidence.js';

const RETENTION_CURSOR = 'frameleaf-queue-retention-cursor';

/**
 * Retain open runs' jobs; bound payload/attempt cleanup independently of media execution.
 * FL-1485: a completed job is kept for one hour (owner, 2026-11-12), anything else that ended for 30 days. A 900,000
 * photo library finishes millions of jobs in days, and each kept one costs every index on this table.
 */
export async function pruneQueueHistory(db: Kysely<any>): Promise<number> {
  return (await pruneQueueHistoryPage(db)).pruned;
}

/**
 * One retention page: how many jobs it deleted, whether it read a full page of candidates (so more history may
 * follow), and whether its newest candidate is old enough to be due (so the history after it may be due too). A full
 * page can delete fewer than a page when some jobs must still be kept.
 */
export async function pruneQueueHistoryPage(
  db: Kysely<any>,
): Promise<{ pruned: number; fullPage: boolean; due: boolean }> {
  return db.transaction().execute(async (tx) => {
    const {
      rows: [lock],
    } = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(-333, 1) acquired`.execute(tx);
    if (!lock.acquired) return { pruned: 0, fullPage: false, due: false };
    // FL-1785: count what each queue finished before any of it is deleted
    await recordQueueBatches(tx);
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
          await sql<{ id: string; finishedAt: string; due: boolean }>`select id, "finishedAt"::text,
        "finishedAt" < now() - interval '1 hour' due from job
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
        and j."finishedAt" < now() - case when j.state = 'completed' then interval '1 hour' else interval '30 days' end
        and not exists(select 1 from job child where child."parentId" = j.id)
        -- FL-1265: a run's jobs are its counts until it finishes and writes its summary
        -- a parked stage can reopen a finished run, which recounts it from its jobs
        and not exists(select 1 from job_run r where r.id = j."runId"
          and (r."finishedAt" is null or r.selection->'holds' @? '$.* ? (@ == "parked")'))
        and not exists(select 1 from job_attempt a where a."jobId" = j.id
          and (a.outcome is distinct from 'completed' or a."finishedAt" is null)
          and not exists(select 1 from system_metadata m
            where m.key='frameleaf-attempt-evidence:' || a.token::text
              and m.value->>'jobId'=j.id::text and m.value ? 'stoppedAt')
          and not exists(select 1 from system_metadata m
            where m.key='frameleaf-worker-stopped:' || a."workerId"::text
              and m.value->>'workerId'=a."workerId"::text and m.value ? 'stoppedAt'))
      order by j."finishedAt", j.id`.execute(tx);
    const pruned = rows.length;
    if (pruned > 0) {
      const ids = rows.map(({ id }) => id);
      await dropAttemptEvidence(tx, ids);
      await sql`delete from job where id = any(${ids}::uuid[])`.execute(tx);
    }
    await sql`delete from job_worker where id in (
      select w.id from job_worker w where w.state = 'lost' and w."heartbeatAt" < now() - interval '7 days'
        and not exists(select 1 from job j where j."workerId" = w.id)
        and not exists(select 1 from job_attempt a where a."workerId" = w.id)
      order by w."heartbeatAt" limit ${QUEUE_BATCH} for update skip locked
    )`.execute(tx);
    await pruneWorkerStopEvidence(tx);
    return { pruned, fullPage: candidates.length === QUEUE_BATCH, due: !!last?.due };
  });
}

const FOLD_CURSOR = 'frameleaf-queue-fold-cursor';

/**
 * FL-1826 (owner, 2026-11-26): an open run keeps its jobs as its counts, so a long import held millions of finished
 * rows (7.2M of 9.5M on a 900,000 photo library). One page: the next photos of one open run, in key order; those whose
 * every task completed over an hour ago are deleted and added to the run's `selection.folded` (`RunFolded`), in one
 * transaction with the run row locked, so `finishRuns` never sums a run half way through a page.
 *
 * Only a photo with nothing but completed tasks goes: one with a failed, waiting or running task keeps every row, as
 * the failure reports and Try again read them. Only an enumerated run with no parked stage: until every photo is
 * admitted a missing row would be admitted again, and a parked stage can bring a photo's tasks back.
 * `more`: the run has photos after this page, or another open run follows it.
 * ponytail: a folded photo no longer shows in the run's item list; the list is of what still has rows.
 */
export async function foldOpenRunsPage(db: Kysely<any>): Promise<{ folded: number; more: boolean }> {
  return db.transaction().execute(async (tx) => {
    const {
      rows: [lock],
    } = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(-333, 2) acquired`.execute(tx);
    if (!lock.acquired) return { folded: 0, more: false };
    const {
      rows: [cursor],
    } = await sql<{ runId: string | null; root: string | null }>`select (value->>'runId')::uuid "runId",
      value->>'root' root from system_metadata where key = ${FOLD_CURSOR}`.execute(tx);
    const save = (value: { runId: string; root: string } | null) =>
      sql`insert into system_metadata(key, value) values (${FOLD_CURSOR}, ${JSON.stringify(value ?? {})}::text::jsonb)
        on conflict (key) do update set value = excluded.value`.execute(tx);
    // the cursor's run while it is still open, else the next one; a run someone has locked waits for its next turn
    const {
      rows: [run],
    } = await sql<{ id: string; folded: unknown }>`select r.id, r.selection->'folded' folded from job_run r
      where r."enumerationDone" and r."finishedAt" is null
        and not coalesce(r.selection->'holds' @? '$.* ? (@ == "parked")', false)
        ${cursor?.runId ? sql`and r.id >= ${cursor.runId}::uuid` : sql``}
      order by r.id limit 1 for no key update skip locked`.execute(tx);
    if (!run) {
      await save(null);
      return { folded: 0, more: false };
    }
    const after = run.id === cursor?.runId ? (cursor.root ?? '') : '';
    const { rows: page } = await sql<{ root: string }>`select distinct j."rootItemKey" root from job j
      where j."runId" = ${run.id}::uuid and j."rootItemKey" > ${after} order by 1 limit ${QUEUE_BATCH}`.execute(tx);
    const last = page.at(-1);
    // past this run's last photo: the next run, or the first again. Says whether anything is left this time round
    const next = async () => {
      if (last && page.length === QUEUE_BATCH) {
        await save({ runId: run.id, root: last.root });
        return true;
      }
      const {
        rows: [following],
      } = await sql<{ id: string }>`select r.id from job_run r where r."enumerationDone" and r."finishedAt" is null
        and r.id > ${run.id}::uuid order by r.id limit 1`.execute(tx);
      await save(following ? { runId: following.id, root: '' } : null);
      return !!following;
    };
    if (page.length === 0) return { folded: 0, more: await next() };
    const roots = page.map(({ root }) => root);
    // a row someone else holds is not waited for: its photo is left for the next time round
    const { rows: locked } = await sql<{ id: string }>`select id from job
      where "runId" = ${run.id}::uuid and "rootItemKey" = any(${roots}::text[]) for update skip locked`.execute(tx);
    const { rows: gone } = await sql<{ id: string; name: string; queue: string; root: string }>`
      select j.id, j.name, j.queue, j."rootItemKey" root from job j
      where j."runId" = ${run.id}::uuid and j."rootItemKey" = any(${roots}::text[])
        and not exists (select 1 from job o where o."runId" = j."runId" and o."rootItemKey" = j."rootItemKey" and (
          o.id <> all(${locked.map(({ id }) => id)}::uuid[])
          or o.state <> 'completed' or o."latestPending" is not null
          or o."finishedAt" is null or o."finishedAt" >= now() - interval '1 hour'
          -- a task of another photo or run that waits on one of these keeps the photo
          or exists (select 1 from job child where child."parentId" = o.id and (child."runId" is distinct from o."runId"
            or child."rootItemKey" is distinct from o."rootItemKey"))
          -- as retention: an attempt that did not complete needs its proof of stopping before its job may go
          or exists (select 1 from job_attempt a where a."jobId" = o.id
            and (a.outcome is distinct from 'completed' or a."finishedAt" is null)
            and not exists (select 1 from system_metadata m
              where m.key = 'frameleaf-attempt-evidence:' || a.token::text
                and m.value->>'jobId' = o.id::text and m.value ? 'stoppedAt')
            and not exists (select 1 from system_metadata m
              where m.key = 'frameleaf-worker-stopped:' || a."workerId"::text
                and m.value->>'workerId' = a."workerId"::text and m.value ? 'stoppedAt'))))`.execute(tx);
    if (gone.length > 0) {
      const ids = gone.map(({ id }) => id);
      const folded: RunFolded = foldedOf(run.folded);
      folded.roots += new Set(gone.map(({ root }) => root)).size;
      for (const { name, queue } of gone) {
        folded.tasks[name] = { n: (folded.tasks[name]?.n ?? 0) + 1, queue };
      }
      await dropAttemptEvidence(tx, ids);
      // children first: a task's parent is of the same photo, and goes in the same statement
      await sql`delete from job where id = any(${ids}::uuid[])`.execute(tx);
      await sql`update job_run set selection = jsonb_set(coalesce(selection, '{}'::jsonb), '{folded}',
        ${JSON.stringify(folded)}::text::jsonb) where id = ${run.id}::uuid`.execute(tx);
    }
    return { folded: gone.length, more: await next() };
  });
}
