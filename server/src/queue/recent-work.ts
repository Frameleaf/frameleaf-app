import { Kysely, sql } from 'kysely';
import { JobName, MediaOperationKind, QueueName, SystemMetadataKey } from 'src/enum.js';
import { NIGHTLY_RUN_KINDS, RUN_FAILURE_CAUSES, type RunFailureCause } from 'src/queue/run-failure-cause.js';
import {
  type FailureRoot,
  type FailureScope,
  type Header,
  RUN_OUTCOMES,
  type RunAggregate,
  type RunCounts,
  type RunEarlier,
  type RunFailureCauseCount,
  type RunOutcome,
  type RunRead,
  type RunState,
  STATE_TOP,
  SUMMARIZED,
  SUPERSEDING_RUNS,
  add,
  aggregateRun,
  causeCounts,
  failureRoots,
  fromSummary,
  groupRoots,
  holdsOf,
  namesHeldAs,
  needsLook,
  readSurroundings,
  runCountsPhotos,
  toRead,
  zero,
} from 'src/queue/run-query.js';

/**
 * FL-1430: Recent work (`foldNightly`). Each scheduled night's runs are one card, the newest night's, with the nights
 * before it; a finished run with no work at all is left out; work still going comes first (newest started first),
 * then finished work by when it finished; a photo a newer run with a card of its own left over again at the same step
 * is counted on that card only; a folder scan names its library, and one refused for its folder says so.
 *
 * Cost: one pass over `job_run` per request (one row per piece of work; ordering all of it by finish time needs the
 * pass whatever the folding, as Activity's list does), then index reads by run id for the runs on the page.
 */

/** How many earlier nights a folded card lists, and counts its streak back through. */
export const EARLIER_RUNS = 6;
/** Above this many of a night's photo tasks its photos are added up per run, not counted once each. */
const DISTINCT_PHOTOS_LIMIT = 200_000;

/** The refusals that say a scan's folder is empty or can't be reached (`LibraryScanRefusal`). */
const SOURCE_REFUSALS = ['library_source_empty', 'library_source_unavailable'];

/** A run `r` with a folder scan's operation `o` (same id) and library `l` (by primary keys). */
const RUN_SOURCE = sql`job_run r
  left join media_operation o on r.kind = ${MediaOperationKind.LibraryScan} and o.id = r.id
  left join library l on r.kind = ${MediaOperationKind.LibraryScan} and l."deletedAt" is null
    and l.id = case when pg_input_is_valid(r.selection->>'libraryId', 'uuid') then (r.selection->>'libraryId')::uuid end`;
const HEADER_COLUMNS = sql`r.id, r.kind, r."createdAt", r."finishedAt", r."enumerationDone", r.selection->'holds' holds,
  r.summary, ${SUMMARIZED} summarized, l.name "libraryName",
  coalesce(o.status = 'failed' and o."errorCode" = any(${SOURCE_REFUSALS}::text[]), false) refused`;
/** A run that may have left something over: still open, not summed up, or its summary says something failed. */
const FAILING = sql<boolean>`(r."finishedAt" is null or not ${SUMMARIZED}
  or coalesce((r.summary->'stageTotals'->>'failed')::int, 0)
    + coalesce((r.summary->'stageTotals'->>'needsAttention')::int, 0) > 0)`;

/**
 * The kinds a night opens runs of: the overnight run itself, the nightly reprocessing of unfinished photos
 * (`reconcileUnfinished`, one run per step) and missing thumbnails. With automatic folder scans, they are what a run
 * from before nights were marked is folded by, when it was opened inside one of the nights the schedule recorded.
 */
const NIGHT_KINDS = [
  JobName.OvernightSequence,
  JobName.AssetExtractMetadata,
  JobName.AssetGenerateThumbnails,
  JobName.AssetEncodeVideo,
  JobName.SmartSearch,
  JobName.AssetDetectFaces,
  JobName.Ocr,
  JobName.AssetGenerateThumbnailsQueueAll,
];

/**
 * Every run's header with its night (`night`), from one pass over `job_run`. The nights the schedule recorded (its last
 * `OVERNIGHT_NIGHTS_KEPT` and the one going) that no run is marked with are nights from before runs carried theirs.
 * A marked run: its scheduled night (a Run now night stays apart), unless it was opened after that night finished as
 * the schedule recorded it (a producer the night queued, retried days later); the night still going has no end yet.
 * An unmarked one: the recorded night it was opened in, for a night's kind or an automatic folder scan; else an
 * overnight run is a night of its own (FL-1349).
 */
const KEYED = sql`marked as materialized (select distinct r.selection->'night'->>'startedAt' key from job_run r
    where jsonb_typeof(r.selection->'night') = 'object'),
  recorded as materialized (select n->>'startedAt' key, (n->>'startedAt')::timestamptz s,
      coalesce((n->>'finishedAt')::timestamptz, 'infinity') f
    from system_metadata m cross join lateral jsonb_array_elements(
      case when jsonb_typeof(m.value->'nights') = 'array' then m.value->'nights' else '[]' end
      || case when jsonb_typeof(m.value->'run') = 'object' then jsonb_build_array(m.value->'run') else '[]' end) n
    where m.key = ${SystemMetadataKey.OvernightSequence} and n->>'manual' = 'false'),
  nights as materialized (select * from recorded w where not exists (select 1 from marked k where k.key = w.key)),
  keyed as materialized (select ${HEADER_COLUMNS}, ${FAILING} failing, case when jsonb_typeof(r.selection->'night') = 'object'
      then case when r.selection->'night'->>'manual' = 'false' and not exists (select 1 from recorded w
          where w.key = r.selection->'night'->>'startedAt' and r."createdAt" > w.f)
        then r.selection->'night'->>'startedAt' end
    else coalesce(
      (select w.key from nights w where r."createdAt" between w.s and w.f
        and (r.kind = any(${NIGHT_KINDS}::text[])
          or (r.kind = ${MediaOperationKind.LibraryScan} and o.snapshot->>'trigger' = 'automatic'))
        order by w.s desc limit 1),
      case when r.kind = any(${NIGHTLY_RUN_KINDS}::text[]) then 'run:' || r.id::text end) end night
    from ${RUN_SOURCE}),
  groups as (select night, min("createdAt") "createdAt",
      case when bool_and("finishedAt" is not null) then max("finishedAt") end "finishedAt",
      (array_agg(id order by "createdAt", id))[1] id
    from keyed where night is not null group by night),
  ranked as (select night, row_number() over (order by "createdAt" desc, night desc)::int n from groups)`;

/**
 * A run `k` with a card of its own (unfolded, or of the newest night) that may have left something over: what may
 * take an older card's photos over. The card and its sheet both take the nearest `SUPERSEDING_RUNS` of them.
 */
const VISIBLE_FAILING = sql`(k.failing and (k.night is null or k.night = (select night from ranked where n = 1)))`;

/** A finished run with no task at all. A refused scan is not empty: it says why. */
const EMPTY = sql`(k.summarized and coalesce((k.summary->'stageTotals'->>'total')::int, 1) = 0 and not k.refused)`;

type KeyedHeader = Header & { night: string | null; failing: boolean };
type ListRow = KeyedHeader & { role: 'entry' | 'member' | 'superseder'; pos: number | null; group: number | null };
type NightGroup = { key: string; runs: KeyedHeader[] };

/** The newer runs with a card of their own that may take a scope's photos over: the nearest `SUPERSEDING_RUNS`. */
const superseders = (candidates: KeyedHeader[], runs: KeyedHeader[]): FailureScope['supersede'] => {
  const ids = new Set(runs.map(({ id }) => id));
  const oldest = Math.min(...runs.map(({ createdAt }) => createdAt.getTime()));
  return candidates
    .filter((run) => !ids.has(run.id) && run.createdAt.getTime() > oldest)
    .slice(0, SUPERSEDING_RUNS)
    .map(({ id, createdAt }) => ({ id, createdAt }));
};

export async function listRecentWork(db: Kysely<any>, take: number, skip: number): Promise<RunRead[]> {
  const { rows } = await sql<ListRow>`with ${KEYED},
    entries as (
      select k.id, null::text night, k."createdAt", k."finishedAt" from keyed k where k.night is null and not ${EMPTY}
      union all
      select g.id, g.night, g."createdAt", g."finishedAt" from groups g join ranked r on r.night = g.night where r.n = 1),
    page as (select e.*, row_number() over (order by e."finishedAt" is not null,
        case when e."finishedAt" is null then e."createdAt" end desc, e."finishedAt" desc, e.id desc)::int pos
      from entries e),
    paged as materialized (select * from page where pos > ${skip} and pos <= ${skip + take}),
    scopes as (select p.id, p.night, coalesce((select min(k."createdAt") from keyed k where k.night = p.night),
      p."createdAt") at from paged p)
    select k.*, 'entry' role, p.pos, null::int "group" from paged p join keyed k on k.id = p.id where p.night is null
    union all
    select k.*, 'member' role, case when r.n = 1 then (select pos from paged where night is not null) end pos, r.n "group"
      from keyed k join ranked r on r.night = k.night
      where r.n <= ${EARLIER_RUNS + 1} and exists (select 1 from paged where night is not null)
    union all
    select distinct on (c.id) c.*, 'superseder' role, null pos, null "group" from scopes s cross join lateral (
      select k.* from keyed k where ${VISIBLE_FAILING} and k."createdAt" > s.at
        and (case when s.night is null then k.id <> s.id else k.night is distinct from s.night end)
      order by k."createdAt", k.id limit ${SUPERSEDING_RUNS}) c`.execute(db);
  const entries = rows.filter((row) => row.role === 'entry');
  const members = rows.filter((row) => row.role === 'member');
  const candidates = rows
    .filter((row) => row.role === 'superseder')
    .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const groups: NightGroup[] = [];
  for (const row of members.toSorted(
    (a, b) => a.group! - b.group! || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  )) {
    const last = groups.at(-1);
    if (last?.key === row.night) last.runs.push(row);
    else groups.push({ key: row.night!, runs: [row] });
  }
  const nightPos = members.find((row) => row.pos !== null)?.pos ?? null;
  const order = [...entries.map((row) => ({ pos: row.pos!, row })), ...(nightPos === null ? [] : [{ pos: nightPos }])];
  order.sort((a, b) => a.pos - b.pos);
  if (order.length === 0) return [];
  const around = await readSurroundings(db);
  const runs: RunRead[] = [];
  for (const entry of order) {
    if ('row' in entry && entry.row) {
      runs.push(await toRead(db, entry.row, around, { live: { supersede: superseders(candidates, [entry.row]) } }));
    } else {
      runs.push(await nightCard(db, groups, around, candidates));
    }
  }
  return runs;
}

/**
 * FL-1430: whose left-over photos a Recent work card counts: a folded night's runs together, or the run alone; the
 * same scope its card reads (`listRecentWork`). Undefined for an unknown run.
 */
export async function recentWorkScope(
  db: Kysely<any>,
  runId: string,
): Promise<{ scope: FailureScope; runs: KeyedHeader[] } | undefined> {
  const { rows } = await sql<KeyedHeader & { role: 'member' | 'superseder' }>`with ${KEYED},
    target as (select night from keyed where id = ${runId}::uuid),
    members as materialized (select * from keyed k
      where k.id = ${runId}::uuid or (k.night is not null and k.night = (select night from target)))
    select k.*, 'member' role from members k
    union all
    (select k.*, 'superseder' role from keyed k
      where ${VISIBLE_FAILING} and k.id not in (select id from members)
        and k."createdAt" > (select min("createdAt") from members)
      order by k."createdAt", k.id limit ${SUPERSEDING_RUNS})`.execute(db);
  const runs = rows.filter((row) => row.role === 'member');
  if (runs.every(({ id }) => id !== runId)) return;
  const scopeRuns: FailureScope['runs'] = [];
  for (const run of runs) {
    const countsPhotos = await runCountsPhotos(db, run.id);
    if (countsPhotos !== undefined) scopeRuns.push({ id: run.id, countsPhotos, settled: !run.summarized });
  }
  const candidates = rows
    .filter((row) => row.role === 'superseder')
    .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return { scope: { runs: scopeRuns, supersede: superseders(candidates, runs) }, runs };
}

const SETTLED_STATES = new Set<RunState>(['completed', 'completed_with_errors', 'cancelled', 'needs_attention']);
/** A folded night's state: anything still going wins over finished, the most pressing first. */
const NIGHT_STATES: RunState[] = [
  'running',
  'retrying',
  'waiting',
  'delayed',
  'blocked',
  'paused',
  'unavailable',
  'needs_attention',
  'completed_with_errors',
  'cancelled',
  'completed',
];
/** What a photo still to do can be besides simply waiting (`aggregateRun`'s live outcomes). */
const LIVE_OUTCOMES = ['retrying', 'delayed', 'paused', 'blocked'] as const;
const TOP_OUTCOMES: Record<number, RunOutcome> = {
  10: 'active',
  8: 'waiting',
  4: 'needsAttention',
  3: 'failed',
  2: 'cancelled',
  1: 'completed',
};
const sumCounts = (counts: RunCounts[]) => {
  const sum = zero();
  for (const one of counts) for (const key of ['total', ...RUN_OUTCOMES] as const) sum[key] += one[key];
  return sum;
};
const union = <T>(lists: T[][]) => [...new Set(lists.flat())];
const byName = (a: string, b: string) => a.localeCompare(b);

/** The causes a night's runs stored when they finished, added up: its history is pruned. */
const storedCauses = (runs: Header[]) => {
  const counts = new Map<RunFailureCause, number>();
  for (const run of runs) {
    for (const { cause, count } of (run.summarized && run.summary?.failureCauses) || []) {
      counts.set(cause, (counts.get(cause) ?? 0) + count);
    }
  }
  return RUN_FAILURE_CAUSES.flatMap((cause) => (counts.get(cause) ? [{ cause, count: counts.get(cause)! }] : []));
};

/**
 * A night's photos counted once each over its runs that count photos (one photo through metadata, thumbnails and a
 * scan is one photo), each by its most pressing task, from the progress index; added up per run when one run counts
 * photos or there are more than `DISTINCT_PHOTOS_LIMIT` of the night's photo tasks.
 */
async function nightPhotos(
  db: Kysely<any>,
  reads: RunRead[],
  runs: Header[],
): Promise<{ counts: RunCounts; countedOnce: boolean }> {
  const photoRuns = reads.filter((read) => read.countsPhotos);
  // parked stages are left out, as each run's own count leaves them out (`aggregateRun`)
  const parked = [...new Set(runs.flatMap((run) => namesHeldAs(holdsOf(run.holds), 'parked')))];
  const tasks = photoRuns.reduce((sum, read) => sum + read.stageTotals.total, 0);
  if (photoRuns.length < 2) return { counts: sumCounts(photoRuns), countedOnce: true };
  // too many to count once, or the night's tasks are pruned: its tasks, said as tasks
  const summed = { counts: sumCounts(photoRuns.map((read) => read.stageTotals)), countedOnce: false };
  if (tasks > DISTINCT_PHOTOS_LIMIT) return summed;
  const { rows } = await sql<{ top: number; n: number }>`select top, count(*)::int n from (
      select ${STATE_TOP} top from job where "runId" = any(${photoRuns.map(({ id }) => id)}::uuid[])
        and "rootItemKey" is not null and not (state in ('pending','waiting') and name = any(${parked}::text[]))
      group by "rootItemKey") photos group by top`.execute(db);
  if (rows.length === 0) return summed;
  const counts = zero();
  for (const { top, n } of rows) add(counts, TOP_OUTCOMES[top] ?? 'completed', n);
  // the photos still to do are what each run's own reading says they are (`aggregateRun`: a retry's wait, a paused
  // or closed step, a deferral): when no run has photos simply waiting, they are moved to those outcomes
  const own = sumCounts(photoRuns);
  if (own.waiting === 0 && counts.waiting > 0) {
    let left = counts.waiting;
    counts.waiting = 0;
    for (const outcome of LIVE_OUTCOMES) {
      const moved = Math.min(left, own[outcome]);
      counts[outcome] += moved;
      left -= moved;
    }
    counts[LIVE_OUTCOMES.find((outcome) => own[outcome] > 0) ?? 'waiting'] += left;
  }
  return { counts, countedOnce: true };
}

/**
 * The card for the newest night: its runs' work added up (photos, once each, when any run counts photos; else
 * tasks), one state, the left-over photos by cause over all its runs at once, the earlier nights and the streak. Its
 * id is the night's first run, which stays the same while the night opens more.
 */
async function nightCard(
  db: Kysely<any>,
  groups: NightGroup[],
  around: Awaited<ReturnType<typeof readSurroundings>>,
  candidates: KeyedHeader[],
): Promise<RunRead> {
  const [night, ...earlier] = groups;
  const reads: RunRead[] = [];
  for (const run of night.runs) reads.push(await toRead(db, run, around, { live: { supersede: [] }, causes: false }));
  const photoRuns = reads.filter((read) => read.countsPhotos);
  const { counts, countedOnce } =
    photoRuns.length > 0 ? await nightPhotos(db, reads, night.runs) : { counts: sumCounts(reads), countedOnce: true };
  const state = NIGHT_STATES.find((candidate) => reads.some((read) => read.state === candidate)) ?? 'completed';
  const settled = SETTLED_STATES.has(state);
  const latest = reads
    .filter((read) => read.lastProgressAt)
    .toSorted((a, b) => b.lastProgressAt!.getTime() - a.lastProgressAt!.getTime())[0];
  const scope: FailureScope = {
    runs: night.runs.map((run, index) => ({
      id: run.id,
      countsPhotos: reads[index].countsPhotos,
      settled: !run.summarized,
    })),
    supersede: superseders(candidates, night.runs),
  };
  const failing = reads.some((read) => read.stageTotals.failed + read.stageTotals.needsAttention > 0);
  let failureCauses: RunFailureCauseCount[] | undefined;
  let roots: FailureRoot[] = [];
  if (failing) {
    roots = await failureRoots(db, scope);
    failureCauses = roots.length === 0 ? storedCauses(night.runs) : causeCounts(groupRoots(roots));
  }
  const finishedAt = settled
    ? (reads
        .map((read) => read.finishedAt)
        .filter((at): at is Date => at !== null)
        .toSorted((a, b) => b.getTime() - a.getTime())[0] ?? null)
    : null;
  const streakRoots = roots.filter((root) => root.rooted && needsLook(root)).map(({ root }) => root);
  const { earlierRuns, streak } = await earlierNights(db, earlier, streakRoots, around);
  const first = night.runs.toSorted(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  )[0];
  return {
    ...counts,
    id: first.id,
    kind: JobName.OvernightSequence,
    createdAt: first.createdAt,
    finishedAt,
    enumerationDone: reads.every((read) => read.enumerationDone),
    stageTotals: sumCounts(reads.map((read) => read.stageTotals)),
    state,
    lastProgressAt: latest?.lastProgressAt ?? null,
    lastStage: latest?.lastStage ?? null,
    reasons: union(reads.map((read) => read.reasons)),
    noDispatchBacklog: reads.some((read) => read.noDispatchBacklog),
    held: reads.reduce((sum, read) => sum + read.held, 0),
    canRelease: reads.some((read) => read.canRelease),
    countsPhotos: photoRuns.length > 0,
    // FL-1430: false when the night's photos couldn't be counted once each: its numbers are then tasks
    ...(photoRuns.length > 0 && { countedOnce }),
    failedQueues: union(reads.map((read) => read.failedQueues)).toSorted(byName),
    ...(failureCauses && {
      failureCauses,
      leftOver: failureCauses.reduce((sum, { count }) => sum + count, 0),
    }),
    nightly: true,
    pausedQueues: union(reads.map((read) => read.pausedQueues)).toSorted(byName),
    ...(reads.some((read) => read.unreachableLibraries?.length) && {
      unreachableLibraries: union(reads.map((read) => read.unreachableLibraries ?? [])).slice(0, 3),
    }),
    earlierRuns,
    ...(streak && { leftOverStreak: streak }),
  };
}

/** The nights before a folded card's, and on how many nights in a row its left-over photos (`roots`) were left over. */
async function earlierNights(
  db: Kysely<any>,
  earlier: NightGroup[],
  roots: string[],
  around: Awaited<ReturnType<typeof readSurroundings>>,
) {
  const earlierRuns: RunEarlier[] = [];
  for (const night of earlier) {
    const aggregates: RunAggregate[] = [];
    for (const run of night.runs) {
      aggregates.push(
        run.summarized && run.summary ? fromSummary(run.summary) : await aggregateRun(db, run, around, false, true),
      );
    }
    const photos = aggregates.filter((aggregate) => aggregate.countsPhotos);
    const counted = photos.length > 0 ? photos : aggregates;
    const first = night.runs.toSorted(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    )[0];
    earlierRuns.push({
      id: first.id,
      createdAt: first.createdAt,
      finishedAt: night.runs.every((run) => run.summarized)
        ? night.runs.map((run) => run.finishedAt!).toSorted((a, b) => b.getTime() - a.getTime())[0]
        : null,
      total: counted.reduce((sum, aggregate) => sum + aggregate.counts.total, 0),
      leftOver: counted.reduce(
        (sum, aggregate) =>
          sum +
          (aggregate.failureCauses
            ? aggregate.failureCauses.reduce((all, { count }) => all + count, 0)
            : aggregate.counts.failed + aggregate.counts.needsAttention),
        0,
      ),
    });
  }
  // N: this night's left-over photos, stopped ones aside; K: back from this night while each earlier one left all N.
  let nights = 1;
  if (roots.length > 0) {
    for (const night of earlier) {
      const {
        rows: [probe],
      } = await sql<{ all: boolean }>`select not exists (select 1 from unnest(${roots}::text[]) r(root)
          where not exists (select 1 from job j where j."runId" = any(${night.runs.map(({ id }) => id)}::uuid[])
            and j."rootItemKey" = r.root and j.state in ('failed','needs_attention'))) "all"`.execute(db);
      if (!probe.all) break;
      nights++;
    }
  }
  // the probe reached the last night it may read and that one matched too: there may be more
  const capped = earlier.length === EARLIER_RUNS && nights === EARLIER_RUNS + 1;
  return { earlierRuns, streak: roots.length > 0 ? { photos: roots.length, nights, capped } : undefined };
}

/** FL-1430: Library care's file checks for missing and damaged files, as one piece of work. */
export type RecentFileCheck = {
  running: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  checked: number;
  total: number;
  /** files found damaged / missing (once finished) */
  damaged: number;
  missing: number;
  /** a finished check that failed or was cancelled: it didn't finish its work */
  failed: boolean;
};
/** How long a finished file check stays in Recent work. */
const FILE_CHECK_SHOWN = '12 hours';

/**
 * A running check `h` with work still live: its durable Library care operation (whose snapshot names the check) not
 * yet ended, or a queued step of it in the Library care queue. A check left running by a restart has neither and
 * isn't shown, however long a real check takes (counts are written only at the end, so there is no heartbeat).
 */
const CHECK_LIVE = sql`(exists (select 1 from media_operation o where o.kind = ${MediaOperationKind.MediaHealth}
    and o.status not in ('completed','failed','cancelled')
    and h.id::text in (o.snapshot->>'runId', o.snapshot->>'missingRunId', o.snapshot->>'corruptRunId'))
  or exists (select 1 from job j where j.queue = ${QueueName.MediaHealth} and j.state in ('pending','waiting','active')
    and j.data->>'runId' = h.id::text))`;

/**
 * FL-1430: Library care's file check, as one piece of work. A check is one row per account and kind (missing,
 * corrupt) that read the same files, so per account the larger of its kinds' counts is its files, and accounts add up.
 * While any check's work is live, those running checks are the card. Else, per account, its latest pass (its kinds
 * started within a minute) that ended in the last `FILE_CHECK_SHOWN` and looked at files or didn't finish; a later
 * pass that checked nothing new (all zeros) doesn't hide it. Only when an account has nothing but such passes is its
 * latest one shown (adding 0). `asset_health_run` is small: a few rows a night.
 * ponytail: a running check writes its counts only when it ends, so while it runs `total` is usually 0.
 */
export async function recentFileCheck(db: Kysely<any>): Promise<RecentFileCheck | undefined> {
  const {
    rows: [row],
  } = await sql<RecentFileCheck & { n: number }>`with live as (
      select * from asset_health_run h where h.category in ('missing','corrupt') and h.status = 'running' and ${CHECK_LIVE}
    ), done as (
      select * from asset_health_run where category in ('missing','corrupt') and status <> 'running'
        and "finishedAt" > now() - ${FILE_CHECK_SHOWN}::interval and not exists (select 1 from live)
    ), anchor as (
      select distinct on ("ownerId") "ownerId", "startedAt" from done
      order by "ownerId", ("totalAssets" > 0 or status in ('failed','cancelled')) desc, "startedAt" desc
    ), picked as (
      select * from live
      union all
      select d.* from done d join anchor a on a."ownerId" is not distinct from d."ownerId"
        and d."startedAt" between a."startedAt" - interval '1 minute' and a."startedAt" + interval '1 minute'
    ), owners as (
      select bool_or(status = 'running') running, min("startedAt") "startedAt", max("finishedAt") "finishedAt",
        max("checkedAssets") checked, max("totalAssets") total,
        coalesce(sum("foundAssets") filter (where category = 'corrupt'), 0) damaged,
        coalesce(sum("foundAssets") filter (where category = 'missing'), 0) missing,
        bool_or(status in ('failed','cancelled')) failed
      from picked group by "ownerId"
    ) select count(*)::int n, bool_or(running) running, min("startedAt") "startedAt",
      case when bool_or(running) then null else max("finishedAt") end "finishedAt",
      coalesce(sum(checked), 0)::int checked, coalesce(sum(total), 0)::int total,
      coalesce(sum(damaged), 0)::int damaged, coalesce(sum(missing), 0)::int missing,
      coalesce(bool_or(failed), false) failed from owners`.execute(db);
  if (!row || row.n === 0) return;
  const { n: _, ...check } = row;
  return check;
}
