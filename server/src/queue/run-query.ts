import { Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import {
  NIGHTLY_RUN_KINDS,
  RUN_FAILURE_CAUSES,
  type RunFailureCause,
  causeRank,
  failureCauseName,
  failureCauseRank,
} from 'src/queue/run-failure-cause.js';

export const RUN_OUTCOMES = [
  'completed',
  'failed',
  'needsAttention',
  'cancelled',
  'active',
  'retrying',
  'delayed',
  'paused',
  'waiting',
  'blocked',
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export type RunCounts = Record<RunOutcome, number> & { total: number };
export type RunState =
  | 'running'
  | 'retrying'
  | 'delayed'
  | 'paused'
  | 'waiting'
  | 'blocked'
  | 'unavailable'
  | 'needs_attention'
  | 'completed'
  | 'completed_with_errors'
  | 'cancelled';
export type RunReason =
  | 'worker_unavailable'
  | 'no_dispatch_backlog'
  | 'first_setup_pending'
  | 'dependency_unavailable'
  | 'dependency_wait'
  | 'dependency_failed'
  | 'retry_backoff'
  | 'scheduled_delay'
  | 'queue_paused'
  | 'needs_attention'
  | 'stage_failed'
  | 'enumerating'
  | 'workload-disabled'
  | 'destination-unavailable'
  | 'destination-configuration'
  | 'destination-consent'
  | 'destination-budget'
  | 'source-unavailable'
  | 'local-capacity';
const DEPENDENCY_REASONS = new Set<string>([
  'workload-disabled',
  'destination-unavailable',
  'destination-configuration',
  'destination-consent',
  'destination-budget',
  'source-unavailable',
  'local-capacity',
]);
/** The public name of a stored dependency reason; internal ones (a missing Locked key) have none. */
const publicDependency = (reason: string) => {
  const name = reason === 'destination-capacity' ? 'destination-unavailable' : reason;
  return DEPENDENCY_REASONS.has(name) ? (name as RunReason) : undefined;
};

export type RunRead = RunCounts & {
  id: string;
  kind: string;
  createdAt: Date;
  finishedAt: Date | null;
  enumerationDone: boolean;
  stageTotals: RunCounts;
  state: RunState;
  lastProgressAt: Date | null;
  lastStage: string | null;
  reasons: RunReason[];
  noDispatchBacklog: boolean;
  /** Photos (roots) with unstarted work a setup or pause hold keeps back. */
  held: number;
  /** Something is held that the Jobs page may release (an import only once it is activated). */
  canRelease: boolean;
  /** The counts are photos (job roots); false: they are tasks. */
  countsPhotos: boolean;
  /** Queues with failed or needs-attention jobs in this run. */
  failedQueues: string[];
  /** FL-1349: the photos left over, by plain cause (stopped ones left out); absent when nothing failed. */
  failureCauses?: RunFailureCauseCount[];
  /** FL-1349: the overnight schedule's work (`NIGHTLY_RUN_KINDS`) */
  nightly: boolean;
  /** FL-1349: paused queues the run's unstarted work waits on (Resume) */
  pausedQueues: string[];
  /** FL-1349: up to three external libraries that work deferred for its source waits on */
  unreachableLibraries?: string[];
  /** FL-1349, a folded nightly card: the previous nights, newest first (at most `EARLIER_RUNS`) */
  earlierRuns?: RunEarlier[];
  /**
   * FL-1349, a folded nightly card: the same left-over photos on this many nights in a row, this one included.
   * `capped`: every night it could count back through left them all, so it may be longer ("N or more").
   */
  leftOverStreak?: { photos: number; nights: number; capped: boolean };
  /** FL-1349: photos that still need a look (the sum of `failureCauses`); present whenever `failureCauses` is */
  leftOver?: number;
  /** FL-1430: a folder scan's library, while it exists */
  libraryName?: string;
};
export type RunEarlier = { id: string; createdAt: Date; finishedAt: Date | null; total: number; leftOver: number };
export type RunFailureCauseCount = { cause: RunFailureCause; count: number };
export type RunItemRead = {
  id: string;
  outcome: RunOutcome;
  stageTotals: RunCounts;
  lastProgressAt: Date | null;
  lastStage: string | null;
  reasons: RunReason[];
};

/** What a run's stored summary holds (`run-summary.ts`); migrated and FL-1215 summaries carry fewer fields. */
export type RunSummary = {
  complete: true;
  finishedAt: string;
  counts: RunCounts;
  stageTotals: RunCounts;
  dependencyFailed?: boolean;
  lastProgressAt?: string | null;
  /** FL-1215 summaries */
  lastProgressUs?: string | null;
  lastStage?: string | null;
  countsPhotos?: boolean;
  failedQueues?: string[];
  /** FL-1349 summaries */
  failureCauses?: RunFailureCauseCount[];
};

type HoldReason = 'setup' | 'paused' | 'parked';
type Holds = Record<string, HoldReason>;
export type Header = {
  id: string;
  kind: string;
  createdAt: Date;
  finishedAt: Date | null;
  enumerationDone: boolean;
  holds: Holds | null;
  summary: RunSummary | null;
  summarized: boolean;
  /** FL-1430: a folder scan's library name (null for another run, or a deleted library) */
  libraryName?: string | null;
  /** FL-1430: a folder scan the server refused because its folder is empty or can't be reached */
  refused?: boolean;
};
/** Queue switches and worker liveness, read once for every run on a page. */
export type Surroundings = { paused: Set<string>; closed: Set<string>; workerAvailable: boolean };
/** A run's counts before they are turned into a state and reasons. */
export type RunAggregate = {
  counts: RunCounts;
  stageTotals: RunCounts;
  countsPhotos: boolean;
  failedQueues: string[];
  dependencyFailed: boolean;
  lastProgressAt: Date | null;
  lastStage: string | null;
  /** live tasks that keep the run open (parked stages left out) */
  unfinished: number;
  held: number;
  heldReasons: Set<'setup' | 'paused'>;
  dependencyReasons: RunReason[];
  deferred: number;
  /** stored with a finished run's summary */
  failureCauses?: RunFailureCauseCount[];
  /** paused queues of unstarted stages */
  pausedQueues: string[];
};

const LIVE = new Set(['pending', 'waiting', 'active']);
export const zero = (): RunCounts => Object.fromEntries(['total', ...RUN_OUTCOMES].map((key) => [key, 0])) as RunCounts;
export const add = (counts: RunCounts, outcome: RunOutcome, n: number) => {
  counts[outcome] += n;
  counts.total += n;
};

const HOLD_REASONS = new Set<unknown>(['setup', 'paused', 'parked']);
const holdsOf = (value: unknown): Holds => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, reason]) => HOLD_REASONS.has(reason))) as Holds;
};
const namesHeldAs = (holds: Holds, reason: HoldReason) =>
  Object.entries(holds)
    .filter(([, value]) => value === reason)
    .map(([name]) => name);

const IMPORT_JOURNALS: Record<string, string> = {
  'immich-import-derived': 'frameleaf_immich_import',
  'library-import-derived': 'frameleaf_library_import',
};

/** A pending task of a held, paused or closed stage, else `waiting`; first match wins. */
const liveOutcome = (name: string, holds: Holds, queueOf: Map<string, string>, around: Surroundings): RunOutcome => {
  if (holds[name] === 'setup') return 'blocked';
  if (holds[name] === 'paused') return 'paused';
  const queue = queueOf.get(name);
  if (queue && around.paused.has(queue)) return 'paused';
  if (queue && around.closed.has(queue)) return 'delayed';
  return 'waiting';
};

const PRIORITY: Record<RunOutcome, number> = {
  active: 10,
  retrying: 9,
  waiting: 8,
  delayed: 7,
  paused: 6,
  blocked: 5,
  needsAttention: 4,
  failed: 3,
  cancelled: 2,
  completed: 1,
};
export const STATE_TOP = sql<number>`max(case when state = 'active' then 10 when state in ('pending','waiting') then 8
  when state = 'needs_attention' then 4 when state in ('failed','blocked') then 3 when state = 'cancelled' then 2 else 1 end)`;
const TOP_OUTCOME: Record<number, RunOutcome> = {
  10: 'active',
  4: 'needsAttention',
  3: 'failed',
  2: 'cancelled',
  1: 'completed',
};
const stateOutcome = (state: string): RunOutcome =>
  state === 'needs_attention' ? 'needsAttention' : (state as RunOutcome);

const workerAvailable = sql<boolean>`exists (
  select 1 from job_worker where state = 'running' and "heartbeatAt" > now() - interval '60 seconds'
)`;

export async function readSurroundings(db: Kysely<any>): Promise<Surroundings> {
  const { rows } = await sql<{ name: string; paused: boolean; closed: boolean }>`select name, paused,
      coalesce("closedUntil" > now(), false) closed from job_queue where paused or "closedUntil" > now()`.execute(db);
  const {
    rows: [worker],
  } = await sql<{ available: boolean }>`select ${workerAvailable} available`.execute(db);
  return {
    paused: new Set(rows.filter((row) => row.paused).map((row) => row.name)),
    closed: new Set(rows.filter((row) => !row.paused && row.closed).map((row) => row.name)),
    workerAvailable: worker.available,
  };
}

/** The queue of each named stage of a run: any one of its jobs says it, read through the run's progress index. */
async function stageQueues(db: Kysely<any>, runId: string, names: string[]) {
  if (names.length === 0) return new Map<string, string>();
  const { rows } = await sql<{ name: string; queue: string }>`select n.name, q.queue
    from unnest(${names}::text[]) n(name)
    cross join lateral (select queue from job j where j."runId" = ${runId}::uuid and j.name = n.name limit 1) q`.execute(
    db,
  );
  return new Map(rows.map((row) => [row.name, row.queue]));
}

/**
 * The newest progress of a run: its running jobs' (few, through the active-lease index) or its latest finished job
 * among the last 5000 finished anywhere (the history index read backwards). `exact` (finishing a run, once) falls
 * back to the run's own jobs.
 * ponytail: a live run that finished nothing among the last 5000 jobs shows no last progress until it does.
 */
async function lastProgress(db: Kysely<any>, runId: string, exact: boolean) {
  const {
    rows: [latest],
  } = await sql<{ name: string; at: Date }>`select name, at from (
      (select name, greatest("progressAt", "startedAt") at from job where state = 'active' and "runId" = ${runId}::uuid)
      union all
      (select name, "finishedAt" at from (select name, "finishedAt", "runId" from job
        where state in ('completed','failed','cancelled','blocked') and "latestPending" is null
        order by "finishedAt" desc, id desc limit 5000) recent where "runId" = ${runId}::uuid)
    ) progress where at is not null order by at desc, name limit 1`.execute(db);
  if (latest || !exact) return latest;
  const {
    rows: [own],
  } = await sql<{ name: string; at: Date }>`select name, "finishedAt" at from job
    where "runId" = ${runId}::uuid and "finishedAt" is not null order by "finishedAt" desc, name limit 1`.execute(db);
  return own;
}

/** At most this many live tasks are read one by one to tell a retry's wait from ready work. */
const RETRY_PROBE = 500;

/**
 * FL-1430: the waiting tasks that wait out a retry's backoff (a failed attempt put back for later). Read only when
 * nothing of the run is running and few tasks are live (`job_run_live`, at most `RETRY_PROBE` rows): that is when a
 * card would otherwise say the run is waiting, or running, with nothing to show for it.
 */
async function retryingTasks(
  db: Kysely<any>,
  runId: string,
  tasks: Array<{ name: string; state: string; n: number }>,
  holds: Holds,
  queueOf: Map<string, string>,
  around: Surroundings,
  stageTotals: RunCounts,
) {
  const live = tasks.filter((task) => LIVE.has(task.state)).reduce((sum, task) => sum + task.n, 0);
  if (stageTotals.active > 0 || stageTotals.waiting === 0 || live > RETRY_PROBE) return 0;
  const { rows } = await sql<{ name: string; n: number }>`select name, count(*)::int n from job
    where "runId" = ${runId}::uuid and state in ('pending','waiting') and "dependencyReason" is null
      and attempt > "retryBaseAttempt" and "availableAt" > now() and "availableAt" < 'infinity'
    group by name`.execute(db);
  const waiting = rows
    .filter(({ name }) => liveOutcome(name, holds, queueOf, around) === 'waiting')
    .reduce((sum, row) => sum + row.n, 0);
  return Math.min(waiting, stageTotals.waiting);
}

/**
 * FL-1265: the counts of a run that has no valid summary. Two passes over `job_run_progress`
 * ("runId","rootItemKey",name,state), both answered from the index: one grouped by root in index order (a photo's
 * outcome is its most pressing task's), one by stage and state. Pending tasks of a parked stage are left out:
 * they don't keep the run open, and switching machine learning back on brings them back.
 * ponytail: per-task retry, delay and parent-wait outcomes aren't read here (they need the heap): pending work counts
 * as waiting unless its stage is held, or its queue (one per job name) is paused or closed; deferred work moves to
 * blocked in the task totals (and in the photos when nothing else waits). `listRunItems` reads each photo exactly.
 */
export async function aggregateRun(
  db: Kysely<any>,
  run: { id: string; holds: unknown },
  around: Surroundings,
  exact = false,
): Promise<RunAggregate> {
  const holds = holdsOf(run.holds);
  const parked = namesHeldAs(holds, 'parked');
  const notParked = sql`not (state in ('pending','waiting') and name = any(${parked}::text[]))`;
  const { rows: roots } = await sql<{ top: number; live: string[] | null; rooted: boolean; n: number }>`
    select top, live, rooted, count(*)::int n from (
      select "rootItemKey" is not null rooted, ${STATE_TOP} top,
        array_agg(distinct name) filter (where state in ('pending','waiting')) live
      from job where "runId" = ${run.id}::uuid and ${notParked}
      group by "rootItemKey"
    ) roots group by top, live, rooted`.execute(db);
  const { rows: tasks } = await sql<{ name: string; state: string; n: number }>`select name, state, count(*)::int n
    from job where "runId" = ${run.id}::uuid and ${notParked} group by name, state`.execute(db);
  const { rows: deferred } = await sql<{ reason: string; n: number }>`select "dependencyReason" reason, count(*)::int n
    from job where "runId" = ${run.id}::uuid and state = 'pending' and "dependencyReason" is not null
    group by "dependencyReason"`.execute(db);

  const liveNames = [
    ...new Set(tasks.filter((task) => task.state === 'pending' || task.state === 'waiting').map((task) => task.name)),
  ];
  const failedNames = [
    ...new Set(
      tasks.filter((task) => task.state === 'failed' || task.state === 'needs_attention').map((task) => task.name),
    ),
  ];
  const switched = around.paused.size + around.closed.size > 0;
  const queueOf = await stageQueues(db, run.id, [...new Set([...(switched ? liveNames : []), ...failedNames])]);

  const stageTotals = zero();
  for (const { name, state, n } of tasks) {
    add(
      stageTotals,
      state === 'pending' || state === 'waiting' ? liveOutcome(name, holds, queueOf, around) : stateOutcome(state),
      n,
    );
  }
  const deferredCount = deferred.reduce((sum, row) => sum + row.n, 0);
  const moved = Math.min(deferredCount, stageTotals.waiting);
  stageTotals.waiting -= moved;
  stageTotals.blocked += moved;
  const retrying = await retryingTasks(db, run.id, tasks, holds, queueOf, around, stageTotals);
  stageTotals.waiting -= retrying;
  stageTotals.retrying += retrying;

  const photos = zero();
  let held = 0;
  for (const { top, live, rooted, n } of roots) {
    if (!rooted) continue;
    let outcome = TOP_OUTCOME[top];
    if (top === 8) {
      outcome = 'blocked';
      for (const name of live ?? []) {
        const next = liveOutcome(name, holds, queueOf, around);
        if (PRIORITY[next] > PRIORITY[outcome]) outcome = next;
      }
    }
    add(photos, outcome, n);
    const isHeld = (live ?? []).some(
      (name) => name !== JobName.IdenticalFilesCheck && (holds[name] === 'setup' || holds[name] === 'paused'),
    );
    if (isHeld) held += n;
  }
  // Which photos the deferred tasks belong to isn't read; when every waiting task is deferred, so are their photos.
  if (deferredCount > 0 && stageTotals.waiting === 0) {
    photos.blocked += photos.waiting;
    photos.waiting = 0;
  }
  // FL-1430: likewise, when every waiting task waits out a retry, their photos are retrying
  if (retrying > 0 && stageTotals.waiting === 0) {
    photos.retrying += photos.waiting;
    photos.waiting = 0;
  }
  const countsPhotos = roots.some((row) => row.rooted);
  const heldReasons = new Set<'setup' | 'paused'>();
  for (const name of liveNames) {
    const reason = holds[name];
    if (reason === 'setup' || reason === 'paused') heldReasons.add(reason);
  }
  const latest = await lastProgress(db, run.id, exact);
  return {
    counts: countsPhotos ? photos : { ...stageTotals },
    stageTotals,
    countsPhotos,
    failedQueues: [
      ...new Set(failedNames.map((name) => queueOf.get(name)).filter((queue) => queue !== undefined)),
    ].sort(),
    dependencyFailed: tasks.some((task) => task.state === 'blocked'),
    lastProgressAt: latest?.at ?? null,
    lastStage: latest?.name ?? null,
    unfinished: tasks.filter((task) => LIVE.has(task.state)).reduce((sum, task) => sum + task.n, 0),
    held,
    heldReasons,
    dependencyReasons: [
      ...new Set(deferred.map((row) => publicDependency(row.reason)).filter((reason) => reason !== undefined)),
    ].sort(),
    deferred: deferredCount,
    pausedQueues: [
      ...new Set(
        liveNames.flatMap((name) => {
          const queue = queueOf.get(name);
          return queue !== undefined && around.paused.has(queue) ? [queue] : [];
        }),
      ),
    ].toSorted((a, b) => a.localeCompare(b)),
  };
}

/** The aggregate a finished run's summary stands for. */
export const fromSummary = (summary: RunSummary): RunAggregate => ({
  counts: summary.counts,
  stageTotals: summary.stageTotals,
  countsPhotos: summary.countsPhotos ?? true,
  failedQueues: summary.failedQueues ?? [],
  dependencyFailed: summary.dependencyFailed ?? summary.stageTotals.blocked > 0,
  lastProgressAt: summary.lastProgressAt
    ? new Date(summary.lastProgressAt)
    : summary.lastProgressUs
      ? new Date(Number(BigInt(summary.lastProgressUs) / 1000n))
      : null,
  lastStage: summary.lastStage ?? null,
  unfinished: 0,
  held: 0,
  heldReasons: new Set(),
  dependencyReasons: [],
  deferred: 0,
  failureCauses: summary.failureCauses,
  pausedQueues: [],
});

export const runState = (
  run: { enumerationDone: boolean; workerAvailable: boolean },
  aggregate: Pick<RunAggregate, 'stageTotals' | 'unfinished' | 'heldReasons'>,
): RunState => {
  const stages = aggregate.stageTotals;
  if (run.enumerationDone && aggregate.unfinished === 0) {
    if (stages.failed + stages.needsAttention + stages.blocked > 0) return 'completed_with_errors';
    if (stages.cancelled > 0) return 'cancelled';
    return 'completed';
  }
  // A paused setup is paused while its last started jobs finish.
  if (aggregate.heldReasons.has('paused') && !aggregate.heldReasons.has('setup')) return 'paused';
  if (stages.active > 0) return 'running';
  if (aggregate.heldReasons.has('setup')) return 'blocked';
  if (stages.paused > 0 && stages.waiting + stages.retrying + stages.delayed === 0) return 'paused';
  if (stages.delayed > 0 && stages.waiting + stages.retrying === 0) return 'delayed';
  if (stages.blocked > 0 && stages.waiting + stages.retrying === 0) return 'blocked';
  if (!run.workerAvailable) return 'unavailable';
  if (stages.retrying > 0) return 'retrying';
  if (stages.waiting > 0) return 'waiting';
  return 'running';
};

export const runReasons = (
  run: { enumerationDone: boolean; workerAvailable: boolean },
  aggregate: RunAggregate,
  noDispatchBacklog: boolean,
): RunReason[] => {
  const stages = aggregate.stageTotals;
  const reasons: RunReason[] = [];
  const open = !run.enumerationDone || aggregate.unfinished > 0;
  if (!run.enumerationDone) reasons.push('enumerating');
  const setupPending = aggregate.heldReasons.has('setup');
  if (setupPending) reasons.push('first_setup_pending');
  if (open && !run.workerAvailable && !setupPending) reasons.push('worker_unavailable');
  if (noDispatchBacklog) reasons.push('no_dispatch_backlog');
  if (aggregate.deferred > 0) reasons.push('dependency_unavailable');
  reasons.push(...aggregate.dependencyReasons);
  if (aggregate.dependencyFailed) reasons.push('dependency_failed');
  if (stages.retrying > 0) reasons.push('retry_backoff');
  if (stages.delayed > 0) reasons.push('scheduled_delay');
  if (stages.paused > 0) reasons.push('queue_paused');
  if (stages.needsAttention > 0) reasons.push('needs_attention');
  if (stages.failed > 0) reasons.push('stage_failed');
  return reasons;
};

async function importActivated(db: Kysely<any>, kind: string) {
  const journal = IMPORT_JOURNALS[kind];
  if (!journal) return true;
  const { rows } = await sql`select 1 from ${sql.table(journal)} where status = 'activated'`.execute(db);
  return rows.length > 0;
}

/**
 * How a run is read. Activity (no options): as FL-1349 read it, a finished run from its stored summary. Recent work
 * (`live`): a run's left-over photos are read as they are now, newer work in `live.supersede` taking over the ones it
 * left over again; `causes` false: the caller counts them itself (a folded night, over all its runs at once).
 */
export type ReadOptions = { live?: { supersede: FailureScope['supersede'] }; causes?: boolean };

export async function toRead(
  db: Kysely<any>,
  run: Header,
  around: Surroundings,
  options: ReadOptions = {},
): Promise<RunRead> {
  const finished = run.summarized && !!run.summary;
  const aggregate = finished ? fromSummary(run.summary!) : await aggregateRun(db, run, around);
  const context = { enumerationDone: run.enumerationDone, workerAvailable: around.workerAvailable };
  const state = runState(context, aggregate);
  const ready = aggregate.stageTotals.waiting;
  const noDispatchBacklog =
    ready > 0 &&
    aggregate.stageTotals.active === 0 &&
    (aggregate.lastProgressAt ?? run.createdAt).getTime() < Date.now() - 2 * 60_000;
  const canRelease = aggregate.heldReasons.size > 0 && (await importActivated(db, run.kind));
  const failures = aggregate.stageTotals.failed + aggregate.stageTotals.needsAttention;
  let failureCauses = finished ? aggregate.failureCauses : undefined;
  if (options.live && options.causes !== false && failures > 0) {
    // FL-1430: a finished run's causes are read as they are now (Library care may have found its photos damaged
    // since), as its review sheet reads them; one whose history is pruned keeps the causes it stored
    const roots = await failureRoots(db, {
      runs: [{ id: run.id, countsPhotos: aggregate.countsPhotos, settled: !finished }],
      supersede: options.live.supersede,
    });
    failureCauses = finished && roots.length === 0 ? aggregate.failureCauses : causeCounts(groupRoots(roots));
  } else if (!options.live && !finished && failures > 0) {
    failureCauses = causeCounts(await summarizeRunFailures(db, run.id, aggregate.countsPhotos, true));
  }
  // FL-1430: a scan refused because its folder is empty or gone couldn't reach its drive
  const unreachableLibraries = run.refused
    ? run.libraryName
      ? [run.libraryName]
      : undefined
    : aggregate.dependencyReasons.includes('source-unavailable')
      ? await waitedForLibraries(db, run.id)
      : undefined;
  const reasons = runReasons(context, aggregate, noDispatchBacklog);
  if (run.refused && !reasons.includes('source-unavailable')) reasons.push('source-unavailable');
  return {
    id: run.id,
    kind: run.kind,
    createdAt: run.createdAt,
    finishedAt: ['completed', 'completed_with_errors', 'cancelled'].includes(state) ? run.finishedAt : null,
    enumerationDone: run.enumerationDone,
    ...aggregate.counts,
    stageTotals: aggregate.stageTotals,
    state,
    lastProgressAt: aggregate.lastProgressAt,
    lastStage: aggregate.lastStage,
    reasons,
    noDispatchBacklog,
    held: aggregate.held,
    canRelease,
    countsPhotos: aggregate.countsPhotos,
    failedQueues: aggregate.failedQueues,
    ...(failureCauses && { failureCauses, leftOver: failureCauses.reduce((sum, { count }) => sum + count, 0) }),
    nightly: NIGHTLY_RUN_KINDS.includes(run.kind),
    pausedQueues: aggregate.pausedQueues,
    ...(unreachableLibraries?.length && { unreachableLibraries }),
    ...(run.libraryName && { libraryName: run.libraryName }),
  };
}

/** The external libraries (three at most) of the first 200 photos whose work waits for its source, from the deferral index. */
async function waitedForLibraries(db: Kysely<any>, runId: string) {
  const { rows } = await sql<{ name: string }>`select distinct l.name from (
      select j."rootItemKey" root from job j where j."runId" = ${runId}::uuid and j.state = 'pending'
        and j."dependencyReason" = 'source-unavailable' limit 200
    ) d join asset a on a.id = case when pg_input_is_valid(d.root, 'uuid') then d.root::uuid end
    join library l on l.id = a."libraryId" order by l.name limit 3`.execute(db);
  return rows.map(({ name }) => name);
}

export type RunFailureGroup = {
  cause: RunFailureCause;
  /** photos that still need a look */
  count: number;
  /** photos whose every failed task was stopped ("Stop trying") */
  stopped: number;
  /** photos needing a look whose damaged file a Library care fix already repaired or found again */
  repaired: number;
  queues: string[];
  /** up to three external libraries, for the drive cause */
  libraries: string[];
  /** FL-1430 (`supersede`): photos a newer run left over again, counted there instead (stopped ones aside) */
  superseded: number;
};

/** Library care's fixed-for-you states (`FileProblemRowSchema.fixState`). */
const FIXED_STATES = ['repaired', 'part-saved', 'found-again', 'restored'];

/**
 * `assetId` is the photo (the task's root), whose library, drive and findings tell the cause; `subjectId` is what the
 * task itself works on (`data.id`, as `recordProcessingFailure` and the set-aside checks key it): a follow-up task of a
 * live photo's motion part keeps the still's root.
 */
const failedColumns = sql`coalesce(j."rootItemKey", j.id::text) root, j."rootItemKey" is not null rooted, j."runId",
  j.id "jobId", j.name, j.queue, j.error,
  j.sensitive, case when pg_input_is_valid(j."rootItemKey", 'uuid') then j."rootItemKey"::uuid end "assetId",
  case when pg_input_is_valid(j.data->>'id', 'uuid') then (j.data->>'id')::uuid end "subjectId"`;
/**
 * A run's failed tasks of photos: their keys from the progress index alone ("runId","rootItemKey",name,state), then
 * the tasks by those keys. The state test is written so no index can answer it (`is true`): on a server with few
 * failures the planner would otherwise find the run by reading every failed job of every run through the queue-state
 * index; this way the run's own index entries are read and the state is checked in them, without the heap.
 */
const failedPhotoTasks = (runId: string, settled: boolean) => sql`with keys as materialized (
    select distinct k."rootItemKey", k.name, k.state from job k
    where k."runId" = ${runId}::uuid and k."rootItemKey" is not null
      and (k.state in ('failed','needs_attention')) is true
      ${
        settled
          ? sql`and not exists (select 1 from job l where l."runId" = ${runId}::uuid
              and l."rootItemKey" = k."rootItemKey" and (l.state in ('pending','waiting','active')) is true)`
          : sql``
      }
  ) select ${failedColumns} from keys k cross join lateral (select * from job j where j."runId" = ${runId}::uuid
    and j."rootItemKey" = k."rootItemKey" and j.name = k.name and j.state = k.state) j`;
/** A run that works on something other than photos: each failed task is its own item. */
const failedTasks = (runId: string) => sql`select ${failedColumns} from job j
  where j."runId" = ${runId}::uuid and (j.state in ('failed','needs_attention')) is true`;

/**
 * FL-1430: whose left-over photos are counted. One run, or a folded night's runs together (a photo left over by two
 * of them counts once); `settled` leaves out a live run's photos that still have a live task. `supersede` (Recent
 * work): the runs with a card of their own, newer than the scope, that take over a photo they left over again at the
 * same step (a stopped failure takes nothing over). Without it, nothing is taken over.
 */
export type FailureScope = {
  runs: Array<{ id: string; countsPhotos: boolean; settled?: boolean }>;
  supersede?: Array<{ id: string; createdAt: Date }>;
};
/** How many newer runs (with failures, nearest first) are probed for a photo left over again. */
export const SUPERSEDING_RUNS = 25;
const scopeOf = (scope: string | FailureScope, countsPhotos: boolean, settled: boolean): FailureScope =>
  typeof scope === 'string' ? { runs: [{ id: scope, countsPhotos, settled }] } : scope;

/**
 * FL-1430: the (photo, step, run) pairs of `failed` that a newer run of `newer` left over again at the same step, not
 * stopped there. Probed once per pair, each newer run through its own progress index.
 */
const SUPERSEDING = sql`pairs as materialized (select distinct f.root, f.name, f."runId" from failed f where f.rooted),
  superseding as materialized (select p.root, p.name, p."runId" from pairs p join job_run fr on fr.id = p."runId"
    where exists (select 1 from newer n join job s on s."runId" = n.id and s."rootItemKey" = p.root and s.name = p.name
        and (s.state in ('failed','needs_attention')) is true
      left join asset_processing_failure d on d."assetId" = case when pg_input_is_valid(s.data->>'id', 'uuid')
        then (s.data->>'id')::uuid end and d.step = s.name
      where n."createdAt" > fr."createdAt" and d."dismissedAt" is null)),`;

/**
 * FL-1349: each failed or needs-attention task of a run with its photo's cause. Read from the run's progress index
 * (`"runId"` and the two states), then one indexed lookup each into asset, asset_health (unique per asset and
 * category) and asset_processing_failure (its primary key). A photo's cause is its most telling task's
 * (`run-failure-cause.ts`), from the tasks not stopped; a photo whose every failed task was stopped is `stopped`.
 * Without photos (`countsPhotos` false) each task is its own item. `settled` leaves out photos that still have a live
 * task (a live run's left-over count never runs ahead of its photos' outcomes). FL-1430: a `FailureScope` reads
 * several runs; with `supersede` a photo whose every failed task (stopped ones aside) newer work took over is
 * `photoSuperseded`, and its cause is ranked from the tasks still its own.
 */
export const runFailureTasks = (scope: string | FailureScope, countsPhotos = true, settled = false) => {
  const { runs, supersede } = scopeOf(scope, countsPhotos, settled);
  const failed = sql.join(
    runs.map(
      (run) => sql`(${run.countsPhotos ? failedPhotoTasks(run.id, run.settled ?? false) : failedTasks(run.id)})`,
    ),
    sql` union all `,
  );
  const probes = supersede !== undefined && supersede.length > 0;
  return sql<{
    root: string;
    rooted: boolean;
    runId: string;
    jobId: string;
    name: string;
    queue: string;
    error: string | null;
    sensitive: boolean;
    assetId: string | null;
    subjectId: string | null;
    libraryId: string | null;
    rank: number;
    stopped: boolean;
    fixed: boolean;
    superseded: boolean;
    photoRank: number;
    photoStopped: boolean;
    photoSuperseded: boolean;
  }>`with ${
    probes
      ? sql`newer as materialized (select * from unnest(${supersede.map(({ id }) => id)}::uuid[],
          ${supersede.map(({ createdAt }) => createdAt.toISOString())}::timestamptz[]) n(id, "createdAt")),`
      : sql``
  } failed as (${failed}), ${probes ? SUPERSEDING : sql``} tasks as (
    select f.*, a."libraryId", ${failureCauseRank({
      asset: sql`a.id is not null`,
      error: sql`f.error`,
      external: sql`a."libraryId" is not null`,
      offline: sql`a."isOffline"`,
      finding: sql`h.finding`,
    })} rank,
      coalesce(p."dismissedAt" is not null, false) stopped, coalesce(c.fixed, false) fixed,
      ${
        probes
          ? sql`exists (select 1 from superseding x where x.root = f.root and x.name = f.name and x."runId" = f."runId")`
          : sql`false`
      } superseded
    from failed f
    left join asset a on a.id = f."assetId"
    -- an open finding; a damaged file Library care already fixed still reads as damaged ("repaired N of these")
    left join lateral (select h.category::text finding from asset_health h where h."assetId" = a.id
      and h.category in ('missing','corrupt') and ((h."resolvedAt" is null and h."dismissedAt" is null)
        or (h.category = 'corrupt' and h.evidence->>'fixState' = any(${FIXED_STATES}::text[])))
      order by h.category = 'missing' desc limit 1) h on true
    left join lateral (select c.evidence->>'fixState' = any(${FIXED_STATES}::text[]) fixed from asset_health c
      where c."assetId" = a.id and c.category = 'corrupt') c on true
    left join asset_processing_failure p on p."assetId" = f."subjectId" and p.step = f.name
  )
  select t.*, coalesce(min(rank) filter (where not stopped and not superseded) over photo,
      min(rank) filter (where not stopped) over photo, min(rank) over photo) "photoRank",
    bool_and(stopped) over photo "photoStopped",
    not bool_and(stopped) over photo and bool_and(stopped or superseded) over photo "photoSuperseded"
  from tasks t window photo as (partition by root)`;
};

/** A run's left-over photos grouped by cause, causes in order; the counts with the stopped ones add up to its failed photos. */
export const runFailureGroupsQuery = (
  scope: string | FailureScope,
  countsPhotos = true,
  settled = false,
) => sql<RunFailureGroup>`
  select ${failureCauseName(sql`t."photoRank"`)} cause,
    count(distinct t.root) filter (where not t."photoStopped" and not t."photoSuperseded")::int count,
    count(distinct t.root) filter (where t."photoStopped")::int stopped,
    count(distinct t.root) filter (where t.fixed and not t."photoStopped" and not t."photoSuperseded"
      and t."photoRank" = ${causeRank('damaged')}::int)::int repaired,
    count(distinct t.root) filter (where t."photoSuperseded" and not t."photoStopped")::int superseded,
    array_agg(distinct t.queue order by t.queue) queues,
    case when t."photoRank" = 1 then coalesce((array_agg(distinct l.name order by l.name)
      filter (where l.name is not null))[1:3], '{}') else '{}' end libraries
  from (${runFailureTasks(scope, countsPhotos, settled)}) t left join library l on l.id = t."libraryId"
  group by t."photoRank" order by t."photoRank"`;

export async function summarizeRunFailures(
  db: Kysely<any>,
  scope: string | FailureScope,
  countsPhotos = true,
  settled = false,
): Promise<RunFailureGroup[]> {
  const { rows } = await runFailureGroupsQuery(scope, countsPhotos, settled).execute(db);
  return rows;
}

/** FL-1430: one left-over photo (in a run that counts tasks, one failed task) of a scope, with what Recent work shows. */
export type FailureRoot = {
  root: string;
  rooted: boolean;
  assetId: string | null;
  runIds: string[];
  rank: number;
  stopped: boolean;
  superseded: boolean;
  fixed: boolean;
  queues: string[];
  library: string | null;
  message: string | null;
};

/**
 * FL-1430: a scope's left-over photos, one row each, read once per request: the card's causes (`groupRoots`), the
 * review's samples and message, the streak's photos and an action's photos all come from the same rows.
 */
export async function failureRoots(db: Kysely<any>, scope: FailureScope): Promise<FailureRoot[]> {
  if (scope.runs.length === 0) return [];
  const { rows } = await sql<FailureRoot>`select t.root, bool_or(t.rooted) rooted, t."assetId",
      array_agg(distinct t."runId") "runIds", min(t."photoRank") rank, bool_and(t."photoStopped") stopped,
      bool_and(t."photoSuperseded") superseded, bool_or(t.fixed) fixed,
      array_agg(distinct t.queue order by t.queue) queues, min(l.name) library,
      (array_agg(t.error order by t."jobId") filter (where not t.sensitive and t.error is not null
        and t.rank = t."photoRank"))[1] message
    from (${runFailureTasks(scope)}) t left join library l on l.id = t."libraryId"
    group by t.root, t."assetId"`.execute(db);
  return rows;
}

/** A photo that still needs a look on this card: neither stopped nor taken over by newer work. */
export const needsLook = (root: FailureRoot) => !root.stopped && !root.superseded;

/** `failureRoots` grouped by cause, as `runFailureGroupsQuery` groups them, causes in order. */
export const groupRoots = (roots: FailureRoot[]): RunFailureGroup[] => {
  const groups: RunFailureGroup[] = [];
  for (const [index, cause] of RUN_FAILURE_CAUSES.entries()) {
    const of = roots.filter((root) => root.rank === index + 1);
    if (of.length === 0) continue;
    const counted = of.filter((root) => needsLook(root));
    groups.push({
      cause,
      count: counted.length,
      stopped: of.filter((root) => root.stopped).length,
      repaired: cause === 'damaged' ? counted.filter((root) => root.fixed).length : 0,
      superseded: of.filter((root) => root.superseded && !root.stopped).length,
      queues: [...new Set(of.flatMap((root) => root.queues))].toSorted((a, b) => a.localeCompare(b)),
      libraries:
        cause === 'drive'
          ? [...new Set(of.flatMap((root) => (root.library ? [root.library] : [])))]
              .toSorted((a, b) => a.localeCompare(b))
              .slice(0, 3)
          : [],
    });
  }
  return groups;
};

/** Whether a run works on photos (`RunRead.countsPhotos`): any of its jobs has a root, from the progress index. */
export async function runCountsPhotos(db: Kysely<any>, runId: string): Promise<boolean | undefined> {
  const {
    rows: [run],
  } = await sql<{ countsPhotos: boolean }>`select exists (select 1 from job j where j."runId" = r.id
      and j."rootItemKey" is not null) "countsPhotos" from job_run r where r.id = ${runId}::uuid`.execute(db);
  return run?.countsPhotos;
}

/** The photos (roots) of one cause that still need a look; in a run that counts tasks, the failed jobs' ids. */
export async function runFailureRoots(db: Kysely<any>, runId: string, cause: RunFailureCause, countsPhotos = true) {
  const { rows } = await sql<{ root: string }>`select t.root from (${runFailureTasks(runId, countsPhotos)}) t
    where t."photoRank" = ${causeRank(cause)}::int and not t."photoStopped"
    group by t.root`.execute(db);
  return rows.map(({ root }) => root);
}

/** A run's stored cause counts, written again after Try again or Stop trying (a reopened run's summary is stale). */
export async function rewriteFailureCauses(db: Kysely<any>, runId: string) {
  const causes = causeCounts(await summarizeRunFailures(db, runId, (await runCountsPhotos(db, runId)) ?? true));
  // an empty list says nothing is left to look at (all stopped), so the card's left-over count reads 0
  await sql`update job_run set summary = jsonb_set(summary, '{failureCauses}', ${JSON.stringify(causes)}::text::jsonb)
    where id = ${runId}::uuid and jsonb_typeof(summary) = 'object'`.execute(db);
}

/** What a run's card and summary keep: the causes with photos still needing a look. */
export const causeCounts = (groups: RunFailureGroup[]): RunFailureCauseCount[] =>
  groups.filter((group) => group.count > 0).map(({ cause, count }) => ({ cause, count }));

/** A stored summary is the run's counts while it was taken at the run's current `finishedAt`. */
export const SUMMARIZED = sql<boolean>`coalesce(r."finishedAt" is not null and r.summary->>'complete' = 'true'
  and (r.summary->>'finishedAt')::timestamptz = r."finishedAt", false)`;

const headers = (where: ReturnType<typeof sql>, take: number, skip: number, unfinishedFirst = true) => sql<Header>`
  select r.id, r.kind, r."createdAt", r."finishedAt", r."enumerationDone", r.selection->'holds' holds, r.summary,
    ${SUMMARIZED} summarized
  from job_run r ${where}
  order by ${unfinishedFirst ? sql`r."finishedAt" is not null,` : sql``} r."createdAt" desc, r.id desc
  limit ${take} offset ${skip}`;

/**
 * Activity's runs, unfinished first. A finished run reads its stored summary; an unfinished one is counted from its
 * jobs (`aggregateRun`), one run at a time. The store shares a costly read between pollers (`costReusedRead`).
 * Recent work (`foldNightly`) reads through `listRecentWork` (`recent-work.ts`) instead.
 */
export async function listRuns(db: Kysely<any>, take: number, skip: number): Promise<RunRead[]> {
  const { rows } = await headers(sql``, take, skip).execute(db);
  if (rows.length === 0) return [];
  const around = await readSurroundings(db);
  const runs: RunRead[] = [];
  for (const row of rows) runs.push(await toRead(db, row, around));
  return runs;
}

export async function getRun(db: Kysely<any>, runId: string): Promise<RunRead | undefined> {
  const {
    rows: [row],
  } = await headers(sql`where r.id = ${runId}::uuid`, 1, 0).execute(db);
  return row ? toRead(db, row, await readSurroundings(db)) : undefined;
}

/** A page of a run's photos (roots, in root order) with the outcome of each of their tasks. */
export async function listRunItems(
  db: Kysely<any>,
  runId: string,
  take: number,
  skip: number,
): Promise<RunItemRead[] | undefined> {
  const {
    rows: [run],
  } = await sql<{ holds: unknown }>`select selection->'holds' holds from job_run where id = ${runId}::uuid`.execute(db);
  if (!run) return;
  const holds = holdsOf(run.holds);
  const notParked = sql`not (j.state in ('pending','waiting') and j.name = any(${namesHeldAs(holds, 'parked')}::text[]))`;
  const { rows: page } = await sql<{ root: string }>`select j."rootItemKey" root from job j
    where j."runId" = ${runId}::uuid and j."rootItemKey" is not null and ${notParked}
    group by j."rootItemKey" order by j."rootItemKey" limit ${take} offset ${skip}`.execute(db);
  if (page.length === 0) return [];
  const { rows: tasks } = await sql<{
    root: string;
    name: string;
    state: string;
    held: boolean;
    paused: boolean;
    closed: boolean;
    dependencyReason: string | null;
    parentState: string | null;
    retrying: boolean;
    delayed: boolean;
    meaningfulAt: Date | null;
  }>`select j."rootItemKey" root, j.name, j.state, j."availableAt" = 'infinity' held, coalesce(q.paused, false) paused,
      coalesce(q."closedUntil" > now(), false) closed, j."dependencyReason", p.state "parentState",
      j.attempt > j."retryBaseAttempt" retrying, j."availableAt" > now() delayed,
      greatest(j."progressAt", j."startedAt", j."finishedAt") "meaningfulAt"
    from job j left join job_queue q on q.name = j.queue left join job p on p.id = j."parentId"
    where j."runId" = ${runId}::uuid and j."rootItemKey" = any(${page.map(({ root }) => root)}::text[]) and ${notParked}`.execute(
    db,
  );
  const outcomeOf = (task: (typeof tasks)[number]): RunOutcome => {
    if (task.state !== 'pending' && task.state !== 'waiting') return stateOutcome(task.state);
    if (task.held) return holds[task.name] === 'paused' ? 'paused' : 'blocked';
    if (task.paused) return 'paused';
    if (task.dependencyReason || (task.parentState && task.parentState !== 'completed')) return 'blocked';
    if (task.retrying) return 'retrying';
    if (task.delayed || task.closed) return 'delayed';
    return 'waiting';
  };
  return page.map(({ root }) => {
    const own = tasks.filter((task) => task.root === root);
    const stageTotals = zero();
    let outcome: RunOutcome = 'completed';
    let latest: (typeof tasks)[number] | undefined;
    const dependencies = new Set<RunReason>();
    let dependencyUnavailable = false;
    for (const task of own) {
      const taskOutcome = outcomeOf(task);
      add(stageTotals, taskOutcome, 1);
      // A live blocked task outranks a finished failure; a stored `blocked` (failed prerequisite) does not.
      const live = task.state === 'pending' || task.state === 'waiting';
      const priority = taskOutcome === 'blocked' && !live ? PRIORITY.failed : PRIORITY[taskOutcome];
      if (priority > PRIORITY[outcome]) outcome = priority === PRIORITY.failed ? 'failed' : taskOutcome;
      if (live && task.dependencyReason) {
        dependencyUnavailable = true;
        const reason = publicDependency(task.dependencyReason);
        if (reason) dependencies.add(reason);
      }
      if (
        task.meaningfulAt &&
        (!latest?.meaningfulAt ||
          task.meaningfulAt > latest.meaningfulAt ||
          (task.meaningfulAt.getTime() === latest.meaningfulAt.getTime() && task.name < latest.name))
      ) {
        latest = task;
      }
    }
    const unfinished = own.some((task) => LIVE.has(task.state));
    const reasons: RunReason[] = [];
    if (own.some((task) => task.state === 'blocked')) reasons.push('dependency_failed');
    if (dependencyUnavailable) reasons.push('dependency_unavailable');
    else if (outcome === 'blocked' && unfinished) reasons.push('dependency_wait');
    const waitReason = ({ retrying: 'retry_backoff', delayed: 'scheduled_delay', paused: 'queue_paused' } as const)[
      outcome as 'retrying' | 'delayed' | 'paused'
    ];
    if (waitReason) reasons.push(waitReason);
    if (stageTotals.needsAttention > 0) reasons.push('needs_attention');
    if (stageTotals.failed > 0) reasons.push('stage_failed');
    reasons.push(...[...dependencies].sort());
    return {
      id: createHash('md5').update(`${runId}:${root}`).digest('hex'),
      outcome,
      stageTotals,
      lastProgressAt: latest?.meaningfulAt ?? null,
      lastStage: latest?.name ?? null,
      reasons,
    };
  });
}

/** Editor and video-conversion deliveries report their media operation's state (paused, cancelled, a lost
 * lease still rendering) and one delivery per operation, as the queue page's counts do. */
const operationQueue = (name: string) => name === QueueName.Editor || name === QueueName.VideoConversion;

const reportedJobsForRun = (name: string) => {
  const columns = sql`j.id, j.queue, j."createdAt", j."progressAt", j."startedAt", j."finishedAt", j."runId", j."parentId",
    j."dependencyReason", j.attempt, j."retryBaseAttempt", j."latestPending"`;
  return operationQueue(name)
    ? sql`select ${columns}, r.state, r."availableAt", r."operationPaused"
        from (${reportedQueueJobs(name)}) r join job j on j.id = r.id`
    : sql`select ${columns}, j.state, j."availableAt", false "operationPaused" from job j where j.queue = ${name}`;
};

/** One queue's current work for Background work: its live jobs and the jobs of runs still open. */
export async function observeQueueRun(db: Kysely<any>, name: string) {
  // Passed as values, not a subquery: the planner then reads each open run's own job count. A subquery is
  // planned for an average run, which after a large scan means a pass over the queue's whole history.
  const { rows: open } = await sql<{ id: string }>`select id from job_run where "finishedAt" is null`.execute(db);
  const openRuns = open.map(({ id }) => id);
  const {
    rows: [row],
  } = await sql<{
    active: number;
    waiting: number;
    processed: number;
    startedAt: Date | null;
    lastProgressAt: Date | null;
    workerAvailable: boolean;
    delayed: number;
    paused: number;
    blocked: number;
    retrying: number;
    noDispatchBacklog: boolean;
  }>`with reported as ${operationQueue(name) ? sql`materialized` : sql`not materialized`} (${reportedJobsForRun(name)}),
    current_jobs as (
      -- Two indexed reads instead of a pass over the queue's whole kept history (FL-1215): its live jobs, and
      -- the finished jobs of runs still open.
      select j.*, q.paused or j."operationPaused" paused, p.state "parentState" from reported j join job_queue q on q.name = j.queue
      left join job p on p.id = j."parentId"
      where j.state in ('pending','waiting','active')
      union all
      select j.*, q.paused or j."operationPaused" paused, p.state "parentState" from reported j join job_queue q on q.name = j.queue
      left join job p on p.id = j."parentId"
      where j.state not in ('pending','waiting','active') and j."runId" = any(${openRuns}::uuid[])
    ), loose_start as (
      select min("createdAt") at from current_jobs where "runId" is null
    ), loose_done as (
      -- Jobs outside a run (upload thumbnails, metadata…) leave the live set when they finish: count the ones
      -- finished since the oldest still waiting was queued, or Activity's percentage stays at 0 (FL-588).
      -- With none waiting there is nothing to count, so the kept history is not read at all.
      select count(*)::int n from reported f where (select at from loose_start) is not null and f."runId" is null
        and f.state in ('completed','failed','cancelled','blocked') and f."latestPending" is null
        and f."finishedAt" >= (select at from loose_start)
    ) select count(*) filter (where state = 'active')::int active,
      count(*) filter (where state in ('pending','waiting'))::int waiting,
      (count(*) filter (where state in ('completed','failed','needs_attention','blocked','cancelled'))
        + (select n from loose_done))::int processed,
      min("createdAt") "startedAt", max(greatest("progressAt", "startedAt", "finishedAt")) "lastProgressAt",
      ${workerAvailable} "workerAvailable",
      count(*) filter (where state in ('pending','waiting') and not paused
        and (("parentState" is distinct from 'completed' and "parentId" is not null) or "dependencyReason" is not null))::int blocked,
      count(*) filter (where state in ('pending','waiting') and paused)::int paused,
      count(*) filter (where state in ('pending','waiting') and not paused and "dependencyReason" is null
        and ("parentId" is null or "parentState" = 'completed') and "availableAt" > now() and attempt = "retryBaseAttempt")::int delayed,
      count(*) filter (where state in ('pending','waiting') and not paused and "dependencyReason" is null
        and ("parentId" is null or "parentState" = 'completed') and attempt > "retryBaseAttempt")::int retrying,
      coalesce(count(*) filter (where state in ('pending','waiting') and not paused and "availableAt" <= now()
        and "dependencyReason" is null and ("parentId" is null or "parentState" = 'completed')) > 0
        and count(*) filter (where state = 'active') = 0
        and coalesce(max(greatest("progressAt", "startedAt", "finishedAt")), min("createdAt")) < now() - interval '2 minutes', false) "noDispatchBacklog"
      from current_jobs`.execute(db);
  return row;
}

/** Individual edit operations own their one domain retry across queue deliveries. Keep
 * failed attempt rows intact; report one latest delivery of the exact operation instead.
 * Run-backed selections retain their existing ledger interpretation.
 */
export const reportedQueueJobs = (queue: string) => {
  if (queue !== QueueName.Editor && queue !== QueueName.VideoConversion) {
    return sql`select j.*,false "operationPaused" from job j where j.queue=${queue}`;
  }
  return sql`
  with deliveries as materialized (
    select j.id,j.queue,j.name,j.data,j.sensitive,j."createdAt",j.attempt,j.error,j.state "rawState",
      j."availableAt",o.id "operationId",o.status "operationState",o."retryAt",
      (o.id is not null and j."cancelRequestedAt" is null and (
        j.state in ('pending','waiting','active','completed')
        or (j.state='needs_attention' and a.outcome='needs_attention' and a."finishedAt" is not null and (
          (stopped.value->>'jobId'=j.id::text and stopped.value ? 'stoppedAt')
          or (worker.value->>'workerId'=a."workerId"::text and worker.value ? 'stoppedAt'))))) authoritative
    from job j left join media_operation o
      on o.id=case when j.data->>'operationId' ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
        then (j.data->>'operationId')::uuid end
      and j."runId" is null and j."itemKey" is null and j."rootItemKey" is null
      and o.kind='quick_edit' and o.snapshot->>'executor'='job_queue'
      and j.name in ('AssetEditThumbnailGeneration','AssetVideoEditGeneration','AssetDevelopRender')
      and o.snapshot->'job'->>'name'=j.name and o.snapshot->'job'->'data'->>'id'=j.data->>'id'
      and (o.snapshot->'job'->'data'->>'versionId') is not distinct from (j.data->>'versionId')
    left join job_attempt a on j.state='needs_attention' and a."jobId"=j.id and a.attempt=j.attempt
    left join system_metadata stopped on stopped.key='frameleaf-attempt-evidence:' || a.token::text
    left join system_metadata worker on worker.key='frameleaf-worker-stopped:' || a."workerId"::text
    where j.queue=${queue}
  ), ranked as (
    select *,row_number() over (partition by "operationId" order by "createdAt" desc,id desc) delivery
      from deliveries where authoritative
  ), latest as (
    select id,queue,name,data,sensitive,"createdAt",attempt,error,"rawState","availableAt","operationId",
      "operationState","retryAt",authoritative from ranked where delivery=1
    union all select * from deliveries where not coalesce(authoritative,false)
  ) select id,queue,name,data,sensitive,"createdAt",attempt,error,
    case when authoritative and "rawState"!='active' then case "operationState"
      when 'queued' then 'pending' when 'paused' then 'pending'
      when 'preparing' then 'active' when 'rendering' then 'active' when 'validating' then 'active'
      when 'cancelling' then 'active' when 'completed' then 'completed' when 'cancelled' then 'cancelled'
      when 'failed' then case when "rawState"='needs_attention' then "rawState" else 'failed' end
      else "rawState" end else "rawState" end state,
    case when authoritative and "operationState"='queued' then coalesce("retryAt","availableAt")
      else "availableAt" end "availableAt",
    coalesce(authoritative and "operationState"='paused',false) "operationPaused"
  from latest`;
};
