import { Kysely, sql } from 'kysely';
import { RunSummary, aggregateRun, causeCounts, readSurroundings, summarizeRunFailures } from 'src/queue/run-query.js';

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
