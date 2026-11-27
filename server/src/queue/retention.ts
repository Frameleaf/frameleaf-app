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
 * The runs whose photos fold: the imports. An upload or a producer run keeps taking photos in after it is enumerated,
 * so a photo folded out of one could be queued again as new work; an import admits each photo once.
 */
const FOLDING_RUN_KINDS = ['immich-import-derived', 'library-import-derived'];

/** A photo's task that keeps the photo's rows: not completed an hour ago, or still needed by another photo's work. */
const keepsPhoto = (task: ReturnType<typeof sql>) => sql`(
  ${task}.state <> 'completed' or ${task}."latestPending" is not null
  or ${task}."finishedAt" is null or ${task}."finishedAt" >= now() - interval '1 hour'
  -- a task of another photo or run that waits on this one
  or exists (select 1 from job child where child."parentId" = ${task}.id and (child."runId" is distinct from ${task}."runId"
    or child."rootItemKey" is distinct from ${task}."rootItemKey"))
  -- as retention: an attempt that did not complete needs its proof of stopping before its job may go
  or exists (select 1 from job_attempt a where a."jobId" = ${task}.id
    and (a.outcome is distinct from 'completed' or a."finishedAt" is null)
    and not exists (select 1 from system_metadata m
      where m.key = 'frameleaf-attempt-evidence:' || a.token::text
        and m.value->>'jobId' = ${task}.id::text and m.value ? 'stoppedAt')
    and not exists (select 1 from system_metadata m
      where m.key = 'frameleaf-worker-stopped:' || a."workerId"::text
        and m.value->>'workerId' = a."workerId"::text and m.value ? 'stoppedAt')))`;

/** Raised by Postgres when `lock_timeout` runs out. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * FL-1826 (owner, 2026-11-26): an open import keeps its jobs as its counts, so a long one held millions of finished
 * rows (7.2M of 9.5M on a 900,000 photo library). One page: the next 250 photos of one open import, in key order;
 * those whose every task completed over an hour ago are deleted and added to the run's `selection.folded`
 * (`RunFolded`), in one transaction with the run row locked, so `finishRuns` never sums a run half way through a page.
 *
 * The photos that can fold are found first without a lock; only their rows are then locked (a worker finishing
 * another photo never waits), and a photo is folded only when every one of its rows was locked and still qualifies.
 * The run row is waited for briefly (workers share-lock it as they queue follow-up work); a page that can't have it
 * leaves its place as it was and tries again on the next sweep. Only an enumerated import with no parked stage: a
 * parked stage can bring a photo's tasks back. `more`: the run has photos after this page, or another import follows.
 * ponytail: a folded photo no longer shows in the run's item list; the list is of what still has rows.
 */
export async function foldOpenRunsPage(db: Kysely<any>): Promise<{ folded: number; more: boolean }> {
  try {
    return await db.transaction().execute((tx) => foldPage(tx));
  } catch (error) {
    if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) return { folded: 0, more: false };
    throw error;
  }
}

async function foldPage(tx: Kysely<any>): Promise<{ folded: number; more: boolean }> {
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
  const foldable = sql`r."enumerationDone" and r."finishedAt" is null and r.kind = any(${FOLDING_RUN_KINDS}::text[])
    and not coalesce(r.selection->'holds' @? '$.* ? (@ == "parked")', false)`;
  // the cursor's import while it is still open, else the next one
  const {
    rows: [chosen],
  } = await sql<{ id: string }>`select r.id from job_run r where ${foldable}
      ${cursor?.runId ? sql`and r.id >= ${cursor.runId}::uuid` : sql``}
    order by r.id limit 1`.execute(tx);
  if (!chosen) {
    await save(null);
    return { folded: 0, more: false };
  }
  await sql`set local lock_timeout = '200ms'`.execute(tx);
  const {
    rows: [run],
  } = await sql<{ id: string; folded: unknown }>`select r.id, r.selection->'folded' folded from job_run r
    where r.id = ${chosen.id}::uuid and ${foldable} for no key update`.execute(tx);
  if (!run) return { folded: 0, more: false };
  const after = run.id === cursor?.runId ? (cursor.root ?? '') : '';
  const { rows: page } = await sql<{ root: string; folds: boolean }>`
    with page as (select distinct j."rootItemKey" root from job j
      where j."runId" = ${run.id}::uuid and j."rootItemKey" > ${after} order by 1 limit ${QUEUE_BATCH})
    select p.root, not exists (select 1 from job o where o."runId" = ${run.id}::uuid and o."rootItemKey" = p.root
      and ${keepsPhoto(sql`o`)}) folds
    from page p order by p.root`.execute(tx);
  const last = page.at(-1);
  // past this import's last photo: the next import, or the first again. Says whether anything is left this time round
  const next = async () => {
    if (last && page.length === QUEUE_BATCH) {
      await save({ runId: run.id, root: last.root });
      return true;
    }
    const {
      rows: [following],
    } = await sql<{ id: string }>`select r.id from job_run r where ${foldable} and r.id > ${run.id}::uuid
      order by r.id limit 1`.execute(tx);
    await save(following ? { runId: following.id, root: '' } : null);
    return !!following;
  };
  const roots = page.filter(({ folds }) => folds).map(({ root }) => root);
  if (roots.length === 0) return { folded: 0, more: await next() };
  // only these photos' rows; one that someone holds keeps its photo for the next time round
  const { rows: locked } = await sql<{ id: string; root: string }>`select id, "rootItemKey" root from job
    where "runId" = ${run.id}::uuid and "rootItemKey" = any(${roots}::text[]) for update skip locked`.execute(tx);
  const lockedIds = locked.map(({ id }) => id);
  const { rows: gone } = await sql<{ id: string; name: string; queue: string; root: string; createdAt: Date }>`
    select j.id, j.name, j.queue, j."rootItemKey" root, j."createdAt" from job j
    where j.id = any(${lockedIds}::uuid[])
      and not exists (select 1 from job o where o."runId" = j."runId" and o."rootItemKey" = j."rootItemKey"
        and (o.id <> all(${lockedIds}::uuid[]) or ${keepsPhoto(sql`o`)}))`.execute(tx);
  if (gone.length > 0) {
    const ids = gone.map(({ id }) => id);
    const folded: RunFolded = foldedOf(run.folded);
    folded.roots += new Set(gone.map(({ root }) => root)).size;
    for (const { name, queue, createdAt } of gone) {
      const task = folded.tasks[name];
      const at = new Date(createdAt).toISOString();
      folded.tasks[name] = { n: (task?.n ?? 0) + 1, queue, since: task?.since && task.since < at ? task.since : at };
    }
    await dropAttemptEvidence(tx, ids);
    // a task's parent is of the same photo, and goes in the same statement
    await sql`delete from job where id = any(${ids}::uuid[])`.execute(tx);
    await sql`update job_run set selection = jsonb_set(coalesce(selection, '{}'::jsonb), '{folded}',
      ${JSON.stringify(folded)}::text::jsonb) where id = ${run.id}::uuid`.execute(tx);
  }
  return { folded: gone.length, more: await next() };
}
