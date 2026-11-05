import { Kysely, sql } from 'kysely';
import { performance } from 'node:perf_hooks';
import { RUN_OUTCOMES, RunCounts, RunPage, RunPageAggregate, readRunPage } from 'src/queue/run-query.js';
import { libraryRunPending } from 'src/queue/selection-state.js';

/**
 * FL-1215: Activity reads a run's counts from its whole ledger, millions of rows after a large scan. A run's counts
 * are final once it is marked finished, fully enumerated, has no live job and its own read reports no unfinished
 * stage: from then on only a reopen can change them, and every reopen (a retry, a re-armed stage, a released
 * parked stage, a library append, a late producer selection) clears `finishedAt`. So the coordinator adds the
 * run's ledger up once, a page of roots per statement, and stores the result stamped with that `finishedAt`.
 * `listRuns` uses it only while the stamp still matches; settling again stamps a new `finishedAt`.
 *
 * The partial sum lives in `summary` while pages are added (`cursor`). A page reads its roots' rows only, and
 * every row of a root falls in one page, so per-root outcomes and per-stage counts add up exactly.
 */
const LOCK = sql`pg_try_advisory_xact_lock(-333, 2)`;

type Cursor = { bookkeepingDone: boolean; after: string | null };
type Partial = RunPageAggregate & { lastStages: string[] };
type Summary = { finishedAt: string; complete?: true; final?: false; cursor?: Cursor; partial?: Partial };

/** Every outcome at 0. */
const zero = (): RunCounts => Object.fromEntries(['total', ...RUN_OUTCOMES].map((key) => [key, 0])) as RunCounts;
/** Two count sets added outcome by outcome. */
const add = (a: RunCounts, b: RunCounts) =>
  Object.fromEntries(
    Object.keys(a).map((key) => [key, a[key as keyof RunCounts] + b[key as keyof RunCounts]]),
  ) as RunCounts;

/** One more page added to the run's partial sum; the first page starts from zero. */
const merge = (sum: Partial | undefined, page: RunPageAggregate): Partial => {
  const base: Partial = sum ?? {
    counts: zero(),
    stageTotals: zero(),
    unfinishedStages: 0,
    readyStages: 0,
    held: 0,
    dependencyWaiting: false,
    dependencyUnavailable: false,
    dependencyReasons: [],
    dependencyFailed: false,
    lastStage: null,
    lastProgressUs: null,
    lastStages: [],
  };
  const later =
    page.lastProgressUs !== null &&
    (base.lastProgressUs === null || BigInt(page.lastProgressUs) > BigInt(base.lastProgressUs));
  const tied = page.lastProgressUs !== null && page.lastProgressUs === base.lastProgressUs;
  return {
    counts: add(base.counts, page.counts),
    stageTotals: add(base.stageTotals, page.stageTotals),
    unfinishedStages: base.unfinishedStages + page.unfinishedStages,
    readyStages: base.readyStages + page.readyStages,
    held: base.held + page.held,
    dependencyWaiting: base.dependencyWaiting || page.dependencyWaiting,
    dependencyUnavailable: base.dependencyUnavailable || page.dependencyUnavailable,
    dependencyReasons: [...new Set([...(base.dependencyReasons ?? []), ...(page.dependencyReasons ?? [])])],
    dependencyFailed: base.dependencyFailed || page.dependencyFailed,
    lastProgressUs: later ? page.lastProgressUs : base.lastProgressUs,
    // The latest stage ties break by stage name in the database's collation; the final write picks from these.
    lastStages: later ? [page.lastStage!] : tied ? [...base.lastStages, page.lastStage!] : base.lastStages,
    lastStage: null,
  };
};

/** The finished run to summarise next: one already in progress first, then the most recently finished. */
const nextRun = (db: Kysely<any>) =>
  sql<{
    id: string;
    finishedAt: string;
    summary: Summary | null;
  }>`select r.id, r."finishedAt"::text "finishedAt", r.summary
    from job_run r where r."finishedAt" is not null and r."enumerationDone"
      and (r.summary is null or (r.summary->>'finishedAt')::timestamptz is distinct from r."finishedAt" or r.summary ? 'cursor')
      and not exists (select 1 from job j where j."runId" = r.id and j.state in ('pending','waiting','active'))
    order by coalesce(r.summary ? 'cursor', false) desc, r."finishedAt" desc, r.id limit 1`.execute(db);

/** Add one more page of the next finished run. False when there is nothing left to summarise. */
async function summarizeStep(db: Kysely<any>, pageRows: number): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    const {
      rows: [lock],
    } = await sql<{ acquired: boolean }>`select ${LOCK} acquired`.execute(tx);
    if (!lock.acquired) return false;
    const {
      rows: [run],
    } = await nextRun(tx);
    if (!run) return false;
    const previous = run.summary;
    const resume = previous?.cursor && previous.finishedAt === run.finishedAt ? previous : undefined;
    const cursor: Cursor = resume?.cursor ?? { bookkeepingDone: false, after: null };
    let page: RunPage;
    if (cursor.bookkeepingDone) {
      // The page ends at a root's last row: the root found `pageRows` rows on includes all of its stages.
      const {
        rows: [bound],
      } = await sql<{ upto: string }>`select "rootItemKey" upto from job_run_item
        where "runId" = ${run.id}::uuid and "rootItemKey" is not null
          ${cursor.after === null ? sql`` : sql`and "rootItemKey" > ${cursor.after}`}
        order by "rootItemKey" offset ${pageRows - 1} limit 1`.execute(tx);
      page = { runId: run.id, bookkeeping: false, after: cursor.after, upto: bound?.upto ?? null };
    } else {
      page = { runId: run.id, bookkeeping: true, after: null, upto: null };
    }
    const aggregate = await readRunPage(tx, page);
    if (!aggregate) return true;
    const partial = merge(resume?.partial, aggregate);
    const finished = !page.bookkeeping && page.upto === null;
    if (!finished) {
      const next: Summary = {
        finishedAt: run.finishedAt,
        cursor: page.bookkeeping ? { bookkeepingDone: true, after: null } : { bookkeepingDone: true, after: page.upto },
        partial,
      };
      await sql`update job_run set summary = ${JSON.stringify(next)}::text::jsonb
        where id = ${run.id}::uuid and "finishedAt" = ${run.finishedAt}::timestamptz`.execute(tx);
      return true;
    }
    // A run marked finished whose own read still has unfinished stages (or that a library append reopened for
    // enumeration since) is not final: it is recounted on every read, as before, until it settles again.
    const { numAffectedRows } =
      partial.unfinishedStages > 0
        ? { numAffectedRows: 0n }
        : await sql`update job_run r set summary = jsonb_build_object('finishedAt', ${run.finishedAt}::text,
            'complete', true, 'counts', ${JSON.stringify(partial.counts)}::text::jsonb,
            'stageTotals', ${JSON.stringify(partial.stageTotals)}::text::jsonb,
            'dependencyFailed', ${partial.dependencyFailed}::boolean, 'lastProgressUs', ${partial.lastProgressUs}::text,
            'lastStage', (select min(stage) from unnest(${partial.lastStages}::text[]) stage))
          where r.id = ${run.id}::uuid and r."finishedAt" = ${run.finishedAt}::timestamptz
            and r."enumerationDone" and not (${libraryRunPending(sql<string>`r.id`)})
            and not exists (select 1 from job j where j."runId" = r.id and j.state in ('pending','waiting','active'))`.execute(
            tx,
          );
    if (!numAffectedRows) {
      await sql`update job_run set summary = ${JSON.stringify({ finishedAt: run.finishedAt, final: false })}::text::jsonb
        where id = ${run.id}::uuid and "finishedAt" = ${run.finishedAt}::timestamptz`.execute(tx);
    }
    return true;
  });
}

/** Summarise finished runs a page at a time: at least one page, then more for up to `budgetMs`. Returns the pages added. */
export async function summarizeRuns(db: Kysely<any>, budgetMs: number, pageRows = 2000): Promise<number> {
  const start = performance.now();
  let pages = 0;
  do {
    if (!(await summarizeStep(db, pageRows))) break;
    pages++;
  } while (performance.now() - start < budgetMs);
  return pages;
}
