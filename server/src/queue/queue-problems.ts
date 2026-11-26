import { type Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { QueueName } from 'src/enum.js';
import {
  QUEUE_PROBLEM_CAUSES,
  type QueueProblemCause,
  problemRank,
  queueProblemRank,
  singleMessage,
} from 'src/queue/run-failure-cause.js';
import { type RunFailurePrivacy, visibleAssetIds } from 'src/queue/run-failures.js';

export type QueueProblemUnit = 'photos' | 'videos' | 'jobs';
export type QueueProblem = {
  cause: QueueProblemCause;
  /** photos (failed jobs, for work that is no photo's) that still need a look */
  count: number;
  unit: QueueProblemUnit;
  queues: string[];
  /** one of the server's messages, from a job that may show it on a photo the reader may see */
  message: string | null;
};

/** How many messages per cause are checked for one the reader may see. */
const MESSAGE_CANDIDATES = 20;

/**
 * FL-1486: every failed job with its problem (`queueProblemRank`), stopped ones marked. A photo's problem is its most
 * telling task's, from the tasks not stopped (as a run's left-over photos are counted, `runFailureTasks`); a failed
 * job of no photo is its own item. The queues are named so the queue-state index answers it (it leads with `queue`).
 */
const problemTasks = sql`with failed as materialized (
    select coalesce(j."rootItemKey", j.id::text) root, j."rootItemKey" is not null rooted, j.id "jobId", j.name, j.queue,
      j.error, j.sensitive, j."cancelReason" = 'deadline' deadline,
      case when pg_input_is_valid(j."rootItemKey", 'uuid') then j."rootItemKey"::uuid end "assetId",
      case when pg_input_is_valid(j.data->>'id', 'uuid') then (j.data->>'id')::uuid end "subjectId"
    from job j where j.queue = any(${Object.values(QueueName)}::text[]) and j.state in ('failed','needs_attention')
  ), tasks as (
    select f.*, a.type = 'VIDEO' video, ${queueProblemRank({
      asset: sql`a.id is not null`,
      error: sql`f.error`,
      external: sql`a."libraryId" is not null`,
      offline: sql`a."isOffline"`,
      finding: sql`h.finding`,
      deadline: sql`f.deadline`,
    })} rank, coalesce(p."dismissedAt" is not null, false) stopped
    from failed f
    left join asset a on a.id = f."assetId"
    left join lateral (select h.category::text finding from asset_health h where h."assetId" = a.id
      and h.category in ('missing','corrupt') and h."resolvedAt" is null and h."dismissedAt" is null
      order by h.category = 'missing' desc limit 1) h on true
    left join asset_processing_failure p on p."assetId" = f."subjectId" and p.step = f.name
  ) select t.*, min(t.rank) over (partition by t.root) "photoRank" from tasks t where not t.stopped`;

/**
 * The problems with anything to look at, most photos first. Counts cover every account's work; the message only comes
 * from a job that isn't `sensitive`, on a photo the reader may see (`run-failures.ts`), or from work that is no photo's.
 */
export async function listQueueProblems(db: Kysely<DB>, privacy: RunFailurePrivacy): Promise<QueueProblem[]> {
  const { rows } = await sql<{
    rank: number;
    count: number;
    rooted: boolean;
    videos: boolean | null;
    queues: string[];
    candidates: Array<{ assetId: string | null; message: string }> | null;
  }>`select t."photoRank" rank, count(distinct t.root)::int count, bool_or(t.rooted) rooted,
      bool_and(t.video) videos, array_agg(distinct t.queue order by t.queue) filter (where t.rank = t."photoRank") queues,
      (array_agg(jsonb_build_object('assetId', t."assetId", 'message', t.error) order by t."jobId")
        filter (where not t.sensitive and t.error is not null and t.rank = t."photoRank"))[1:${MESSAGE_CANDIDATES}::int] candidates
    from (${problemTasks}) t group by t."photoRank" order by count desc, t."photoRank"`.execute(db);

  const ids = rows.flatMap(({ candidates }) => (candidates ?? []).flatMap(({ assetId }) => (assetId ? [assetId] : [])));
  const visible = ids.length === 0 ? new Set<string>() : await visibleAssetIds(db, ids, privacy);
  return rows.map(({ rank, count, rooted, videos, queues, candidates }) => ({
    cause: QUEUE_PROBLEM_CAUSES[rank - 1],
    count,
    unit: rooted ? (videos ? 'videos' : 'photos') : 'jobs',
    queues: queues ?? [],
    message: singleMessage(
      (candidates ?? []).find(({ assetId }) => (assetId ? visible.has(assetId) : !rooted))?.message ?? null,
    ),
  }));
}

/** The failed jobs behind one problem (not stopped), by queue: what Try again puts back and Stop trying stops. */
export async function queueProblemJobs(db: Kysely<DB>, cause: QueueProblemCause) {
  const { rows } = await sql<{ queue: string; ids: string[]; roots: number }>`
    select t.queue, array_agg(t."jobId") ids, count(distinct t.root)::int roots
    from (${problemTasks}) t where t."photoRank" = ${problemRank(cause)}::int group by t.queue`.execute(db);
  return rows;
}

export type QueueHold = {
  name: string;
  paused: boolean;
  /** quiet hours: nothing new starts until then */
  closedUntil: Date | null;
  /** nothing of it can run until a job in this other queue finishes */
  waitingFor: string | null;
};

/**
 * Why each queue is not running, as the queue table and the jobs say it: paused, closed by quiet hours, or waiting for
 * a step in another queue: nothing of it running, and the jobs next in line each have an unfinished parent elsewhere.
 */
export async function queueHolds(db: Kysely<DB>): Promise<QueueHold[]> {
  const live = sql`('pending','waiting','active')`;
  // ponytail: the next 50 in line speak for the queue; reading every waiting job's parent costs a lookup each
  const { rows } = await sql<QueueHold>`select q.name, q.paused,
      case when q."closedUntil" > now() then q."closedUntil" end "closedUntil",
      case when not exists (select 1 from job a where a.queue = q.name and a.state = 'active') then (
        select case when bool_and(n.parent is not null) then min(n.parent) end from (
          select (select p.queue from job p where p.id = j."parentId" and p.queue <> j.queue and p.state in ${live}) parent
          from job j where j.queue = q.name and j.state in ('pending','waiting')
          order by j."availableAt", j."createdAt", j.id limit 50) n) end "waitingFor"
    from job_queue q`.execute(db);
  return rows;
}

const QUEUE_BATCH_KEY = 'frameleaf-queue-batch';
const finishedJobs = sql`j.state = 'completed' and j."latestPending" is null`;

/**
 * FL-1785: how many jobs each queue has finished since it last had nothing to do, kept so a progress bar survives the
 * hour a finished job is kept for (FL-1485). Called by the sweep that deletes finished jobs, in its transaction, so
 * every job is counted before it can go. A queue with no work left drops out, and starts again from nothing.
 */
export async function recordQueueBatches(db: Kysely<any>) {
  // ponytail: a job that commits after this snapshot with an earlier finish time is missed; a per-job counter on
  // job_queue would be exact, at the cost of every worker updating one row
  await sql`with prev as (select value from system_metadata where key = ${QUEUE_BATCH_KEY}),
    since as (select coalesce((select (value->>'at')::timestamptz from prev), now() - interval '1 hour') at),
    finished as (select j.queue, count(*) n from job j, since
      where ${finishedJobs} and j."finishedAt" > since.at and j."finishedAt" <= now() group by j.queue),
    live as (select q.name from job_queue q where exists (
      select 1 from job j where j.queue = q.name and j.state in ('pending','waiting','active')))
    insert into system_metadata(key, value) select ${QUEUE_BATCH_KEY}, jsonb_build_object('at', now(), 'done',
      coalesce((select jsonb_object_agg(l.name,
        coalesce(((select value from prev)->'done'->>l.name)::bigint, 0) + coalesce(f.n, 0))
        from live l left join finished f on f.queue = l.name), '{}'::jsonb))
    on conflict (key) do update set value = excluded.value`.execute(db);
}

export type QueueProgress = { name: string; done: number; perHour: number };

/** FL-1785: each queue's finished jobs of its current batch (`recordQueueBatches` plus those since), and its pace. */
export async function queueProgress(db: Kysely<DB>): Promise<QueueProgress[]> {
  // the hour bounds the read if the sweep has not run; finished jobs older than that may already be gone
  const { rows } = await sql<QueueProgress>`with prev as (
      select value, greatest((value->>'at')::timestamptz, now() - interval '1 hour') at
      from system_metadata where key = ${QUEUE_BATCH_KEY}
      union all select '{}'::jsonb, now() - interval '1 hour' limit 1),
    finished as (select j.queue, count(*) filter (where j."finishedAt" > prev.at) tail,
        count(*) filter (where j."finishedAt" > now() - interval '10 minutes') recent
      from job j, prev where ${finishedJobs}
        and j."finishedAt" > least(prev.at, now() - interval '10 minutes') group by j.queue)
    select q.name, (coalesce((prev.value->'done'->>q.name)::bigint, 0) + coalesce(f.tail, 0))::int done,
      (coalesce(f.recent, 0) * 6)::int "perHour"
    from job_queue q cross join prev left join finished f on f.queue = q.name`.execute(db);
  return rows;
}
