import { Kysely, sql } from 'kysely';
import {
  RunLive,
  RunSummary,
  aggregateRun,
  causeCounts,
  lastProgress,
  readSurroundings,
  storedLive,
  summarizeRunFailures,
  tallyRun,
} from 'src/queue/run-query.js';

/** The run `r`'s live work that keeps it open: pending tasks of a parked stage don't. */
const liveWork = sql<boolean>`exists (select 1 from job j where j."runId" = r.id
  and j.state in ('pending','waiting','active') and not (j.state in ('pending','waiting') and j.name = any(array(
    select stage from jsonb_each_text(case when jsonb_typeof(r.selection->'holds') = 'object'
      then r.selection->'holds' else '{}' end) holds(stage, reason) where reason = 'parked'))))`;

/**
 * FL-1265: the coordinator sweep finishes runs. A run is finished when it is enumerated and has no live job (parked
 * stages aside); its counts are added up once, in the same statement that stamps `finishedAt`, so Activity and
 * pruned history read the stored summary from then on. A run already stamped whose summary is missing or stale keeps
 * its `finishedAt` and gets one. Reopening a run sets `finishedAt` to null, which leaves the summary stale.
 *
 * Each run is its own transaction: the run row is locked `for no key update skip locked` (jobs can still be inserted
 * against it), so whoever reopens it in the meantime either waits for this to commit or is seen by the final check.
 * Returns how many runs were finished.
 * ponytail: the open-run check reads each enumerated open run's first live job; parked-only runs read their parked tasks.
 */
export async function finishRuns(db: Kysely<any>, limit: number): Promise<number> {
  const { rows: candidates } = await sql<{ id: string }>`select r.id from job_run r where r."enumerationDone"
      and (r."finishedAt" is null or not coalesce(r.summary->>'complete' = 'true'
        and (r.summary->>'finishedAt')::timestamptz = r."finishedAt", false))
      and not ${liveWork}
    order by r."createdAt", r.id limit ${limit}`.execute(db);
  if (candidates.length === 0) return 0;
  const around = await readSurroundings(db);
  let finished = 0;
  for (const { id } of candidates) {
    const done = await db.transaction().execute(async (tx) => {
      await sql`set local statement_timeout = '120s'`.execute(tx);
      const {
        rows: [run],
      } = await sql<{ holds: unknown }>`select r.selection->'holds' holds from job_run r
        where r.id = ${id}::uuid and r."enumerationDone" and not ${liveWork}
        for no key update skip locked`.execute(tx);
      if (!run) return false;
      const aggregate = await aggregateRun(tx, { id, holds: run.holds }, around, true);
      // FL-1349: the left-over photos by cause, kept so Recent work still says them once history is pruned
      const failures = aggregate.stageTotals.failed + aggregate.stageTotals.needsAttention;
      const failureCauses =
        failures > 0 ? causeCounts(await summarizeRunFailures(tx, id, aggregate.countsPhotos)) : undefined;
      const summary: Omit<RunSummary, 'complete' | 'finishedAt'> = {
        counts: aggregate.counts,
        stageTotals: aggregate.stageTotals,
        dependencyFailed: aggregate.dependencyFailed,
        lastProgressAt: aggregate.lastProgressAt?.toISOString() ?? null,
        lastStage: aggregate.lastStage,
        countsPhotos: aggregate.countsPhotos,
        failedQueues: aggregate.failedQueues,
        ...(failureCauses && { failureCauses }),
      };
      const { numAffectedRows } = await sql`update job_run r set "finishedAt" = coalesce(r."finishedAt", now()),
          summary = ${JSON.stringify(summary)}::text::jsonb
            || jsonb_build_object('complete', true, 'finishedAt', coalesce(r."finishedAt", now()))
        where r.id = ${id}::uuid and r."enumerationDone" and not ${liveWork}`.execute(tx);
      return numAffectedRows === 1n;
    });
    if (done) finished++;
  }
  return finished;
}

/** FL-1656: an unfinished run with more jobs than this has its counts stored; a smaller one is counted when read. */
export const STORED_COUNTS_FROM = 20_000;
/** A run at work is counted again no sooner than this, and than ten times what its last count cost. */
const BUSY_REST = 15_000;
/** A run where nothing moves is still counted again after this long (and a hundred times its cost). */
const IDLE_REST = 5 * 60_000;
/** One visit keeps counting first and out-of-date tallies for this long. */
const REFRESH_BUDGET = 20_000;

/**
 * FL-1656: the coordinator sweep keeps a tally (`RunLive`, in `job_run.summary.live`) of each large unfinished run, so
 * Activity reads the run's counts from its row instead of counting millions of jobs on every poll. Holds and queue
 * switches are applied when the tally is read, so a pause shows at once; the tasks running now are read with it.
 *
 * One run per visit, the one counted longest ago, and none within ten times the cost of the newest count: counting
 * takes at most a tenth of this connection's time however many runs are open. A run where nothing is running, being
 * enumerated or lately finished waits far longer. A run not yet tallied, or changed by hand since (`staleAt`: Try
 * again, Stop trying, Empty), is counted at once. Returns the runs counted.
 * ponytail: a tally is as old as its run's turn; counts kept as jobs change state (a trigger and a per-run ledger of
 * photos) would be exact, at a cost on every job transition.
 */
export async function refreshRunCounts(
  db: Kysely<any>,
  { from = STORED_COUNTS_FROM, now = () => Date.now() }: { from?: number; now?: () => number } = {},
): Promise<string[]> {
  const { rows } = await sql<{
    id: string;
    live: unknown;
    stale: boolean;
    enumerationDone: boolean;
    running: boolean;
  }>`select r.id, r.summary->'live' live, coalesce(r.summary ? 'staleAt', false) stale, r."enumerationDone",
      exists (select 1 from job j where j.state = 'active' and j."runId" = r.id) running
    from job_run r where r."finishedAt" is null order by r."createdAt", r.id`.execute(db);
  const started = now();
  const counted: string[] = [];
  const tallies = rows.map((row) => ({ ...row, live: storedLive(row.live) }));
  const age = (live: RunLive) => started - new Date(live.takenAt).getTime() - live.costMs;

  for (const run of tallies) {
    if (now() - started >= REFRESH_BUDGET) return counted;
    if (run.live && !run.stale) continue;
    if (!run.live) {
      const {
        rows: [size],
      } = await sql<{ n: number }>`select count(*)::int n from (select 1 from job where "runId" = ${run.id}::uuid
        limit ${from + 1}) jobs`.execute(db);
      if (size.n <= from) continue;
    }
    if (await storeRunCounts(db, run.id, run.live?.takenAt ?? null)) counted.push(run.id);
  }
  if (counted.length > 0) return counted;

  const kept = tallies.flatMap((run) => (run.live ? [{ ...run, live: run.live }] : []));
  if (kept.some(({ live }) => age(live) < 10 * live.costMs)) return counted;
  for (const run of kept.toSorted((a, b) => a.live.takenAt.localeCompare(b.live.takenAt))) {
    const { live } = run;
    const idleRest = Math.max(IDLE_REST, 100 * live.costMs);
    if (age(live) < BUSY_REST) continue;
    let busy = run.running || !run.enumerationDone || live.tasks.some((task) => task.state === 'active');
    if (!busy && age(live) < idleRest) {
      // nothing running at this moment: a job of its finished since the count says it is still at work
      const latest = await lastProgress(db, run.id, false);
      busy = !!latest && latest.at.getTime() > new Date(live.takenAt).getTime();
    }
    if (!busy && age(live) < idleRest) continue;
    if (await storeRunCounts(db, run.id, live.takenAt)) counted.push(run.id);
    break;
  }
  return counted;
}

/**
 * Counts one unfinished run and stores the tally, unless the run finished or someone else stored one meanwhile. Read
 * in one transaction for its longer statement timeout; no row is locked while counting.
 */
async function storeRunCounts(db: Kysely<any>, id: string, previous: string | null) {
  const begun = performance.now();
  const live = await db.transaction().execute(async (tx) => {
    await sql`set local statement_timeout = '120s'`.execute(tx);
    const {
      rows: [{ at }],
    } = await sql<{ at: Date }>`select clock_timestamp() at`.execute(tx);
    const tally = await tallyRun(tx, id);
    const failed = tally.tasks.some((task) => task.state === 'failed' || task.state === 'needs_attention');
    // Activity's reading of a live run's left-over photos (`toRead`): the ones with no live task left
    const failureCauses = failed
      ? causeCounts(
          await summarizeRunFailures(
            tx,
            id,
            tally.roots.some((row) => row.rooted),
            true,
          ),
        )
      : undefined;
    return { ...tally, v: 1 as const, takenAt: at.toISOString(), ...(failureCauses && { failureCauses }) };
  });
  const stored: RunLive = { ...live, costMs: Math.round(performance.now() - begun) };
  // a change by hand made after the count began keeps its mark, so the run is counted again
  const { numAffectedRows } = await sql`update job_run r set summary = jsonb_build_object('complete', false,
      'live', ${JSON.stringify(stored)}::text::jsonb) || case when (r.summary->>'staleAt')::timestamptz
        >= ${stored.takenAt}::timestamptz then jsonb_build_object('staleAt', r.summary->'staleAt') else '{}'::jsonb end
    where r.id = ${id}::uuid and r."finishedAt" is null
      and (r.summary->'live'->>'takenAt') is not distinct from ${previous}`.execute(db);
  return numAffectedRows === 1n;
}
