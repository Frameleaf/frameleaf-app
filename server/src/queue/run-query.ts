import { Kysely, RawBuilder, sql } from 'kysely';

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
const DEPENDENCY_REASONS = [
  'workload-disabled',
  'destination-unavailable',
  'destination-configuration',
  'destination-consent',
  'destination-budget',
  'source-unavailable',
  'local-capacity',
] as const;
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
};
export type RunItemRead = {
  id: string;
  outcome: RunOutcome;
  stageTotals: RunCounts;
  lastProgressAt: Date | null;
  lastStage: string | null;
  reasons: RunReason[];
};

// Neither payloads nor free-text errors enter these reads. Stage names are operational job names.
// Bookkeeping (rootItemKey NULL) affects run settlement, but never selected-media item counts.
const stagesFor = (
  filter: RawBuilder<boolean>,
) => sql`select i."runId", i."rootItemKey", i.stage, i.state, j."availableAt", j.attempt, j."retryBaseAttempt", j."dependencyReason", q.paused,
  greatest(j."progressAt", j."startedAt", j."finishedAt") "meaningfulAt",
  case
    when i.state = 'needs_attention' then 'needsAttention'
    when i.state not in ('pending','waiting') then i.state
    when q.paused then 'paused'
    when j."dependencyReason" is not null then 'blocked'
    when p.id is not null and p.state != 'completed' then 'blocked'
    when j.attempt > j."retryBaseAttempt" then 'retrying'
    when j."availableAt" > now() then 'delayed'
    else 'waiting' end outcome
  from job_run_item i left join job j on j.id = i."jobId"
  left join job_queue q on q.name = coalesce(j.queue, i.queue) left join job p on p.id = j."parentId" where ${filter}`;

const counts = (alias: string) => sql`jsonb_build_object('total', count(*)::int,
  ${sql.join(RUN_OUTCOMES.map((key) => sql`${key}::text, count(*) filter (where ${sql.ref(`${alias}.outcome`)} = ${key})::int`))})`;

// Nonterminal stages take precedence: a failed thumbnail plus a live face stage is still active.
// A stored blocked stage is terminal prerequisite failure; a derived blocked pending stage is not.
const selectedOutcome = sql`case
  when bool_or(outcome = 'active') then 'active'
  when bool_or(outcome = 'retrying') then 'retrying'
  when bool_or(outcome = 'waiting') then 'waiting'
  when bool_or(outcome = 'delayed') then 'delayed'
  when bool_or(outcome = 'paused') then 'paused'
  when bool_or(outcome = 'blocked' and state in ('pending','waiting')) then 'blocked'
  when bool_or(outcome = 'needsAttention') then 'needsAttention'
  when bool_or(outcome in ('failed','blocked')) then 'failed'
  when bool_or(outcome = 'cancelled') then 'cancelled'
  else 'completed' end`;

const workerAvailable = sql<boolean>`exists (
  select 1 from job_worker where state = 'running' and "heartbeatAt" > now() - interval '60 seconds'
)`;

type Aggregate = Omit<RunRead, keyof RunCounts | 'state' | 'reasons' | 'noDispatchBacklog'> & {
  counts: RunCounts;
  readyStages: number;
  unfinishedStages: number;
  dependencyWaiting: boolean;
  dependencyUnavailable: boolean;
  dependencyReasons: RunReason[] | null;
  dependencyFailed: boolean;
  workerAvailable: boolean;
  noDispatchBacklog: boolean;
};

export const runReasons = (row: {
  stageTotals: RunCounts;
  dependencyWaiting: boolean;
  dependencyUnavailable: boolean;
  dependencyReasons: RunReason[] | null;
  dependencyFailed: boolean;
  workerAvailable: boolean;
  noDispatchBacklog: boolean;
  enumerationDone: boolean;
  unfinishedStages: number;
}): RunReason[] => {
  const reasons: RunReason[] = [];
  if (!row.enumerationDone) {
    reasons.push('enumerating');
  }
  if ((!row.enumerationDone || row.unfinishedStages > 0) && !row.workerAvailable) {
    reasons.push('worker_unavailable');
  }
  if (row.noDispatchBacklog) {
    reasons.push('no_dispatch_backlog');
  }
  if (row.dependencyUnavailable) {
    reasons.push('dependency_unavailable');
  }
  reasons.push(...(row.dependencyReasons ?? []));
  if (row.dependencyWaiting && !row.dependencyUnavailable) {
    reasons.push('dependency_wait');
  }
  if (row.dependencyFailed) {
    reasons.push('dependency_failed');
  }
  if (row.stageTotals.retrying > 0) {
    reasons.push('retry_backoff');
  }
  if (row.stageTotals.delayed > 0) {
    reasons.push('scheduled_delay');
  }
  if (row.stageTotals.paused > 0) {
    reasons.push('queue_paused');
  }
  if (row.stageTotals.needsAttention > 0) {
    reasons.push('needs_attention');
  }
  if (row.stageTotals.failed > 0) {
    reasons.push('stage_failed');
  }
  return reasons;
};

export const runState = (
  row: Pick<Aggregate, 'enumerationDone' | 'unfinishedStages' | 'workerAvailable' | 'stageTotals' | 'readyStages'>,
): RunState => {
  const stages = row.stageTotals;
  if (row.enumerationDone && row.unfinishedStages === 0) {
    if (stages.failed + stages.needsAttention + stages.blocked > 0) {
      return 'completed_with_errors';
    }
    if (stages.cancelled > 0) {
      return 'cancelled';
    }
    return 'completed';
  }
  if (stages.active > 0) {
    return 'running';
  }
  if (stages.paused > 0 && stages.waiting + stages.retrying + stages.delayed === 0) {
    return 'paused';
  }
  if (stages.delayed > 0 && stages.waiting + stages.retrying === 0) {
    return 'delayed';
  }
  if (stages.blocked > 0 && stages.waiting + stages.retrying === 0) {
    return 'blocked';
  }
  if (stages.retrying > 0 && row.readyStages === 0) {
    return 'retrying';
  }
  if (!row.workerAvailable) {
    return 'unavailable';
  }
  if (stages.retrying > 0) {
    return 'retrying';
  }
  if (stages.waiting > 0) {
    return 'waiting';
  }
  return 'running';
};

export async function listRuns(db: Kysely<any>, take: number, skip: number): Promise<RunRead[]> {
  const { rows } = await sql<Aggregate>`with runs as (
      select id, kind, "createdAt", "finishedAt", "enumerationDone" from job_run
      order by ("finishedAt" is not null), "createdAt" desc, id desc limit ${take} offset ${skip}
    ), stages as (${stagesFor(sql<boolean>`i."runId" in (select id from runs)`)}), run_stages as (
      select s.* from stages s join runs r on r.id = s."runId"
    ), selected as (
      select "runId", "rootItemKey", ${selectedOutcome} outcome
      from run_stages where "rootItemKey" is not null group by "runId", "rootItemKey"
    ), item_counts as (
      select s."runId", ${counts('s')} totals from selected s group by s."runId"
    ), stage_counts as (
      select s."runId", ${counts('s')} totals,
        count(*) filter (where s.state in ('pending','waiting','active')) unfinished,
        bool_or(s.state = 'blocked') "dependencyFailed",
        array_agg(distinct s."dependencyReason") filter (where s.state in ('pending','waiting')
          and s."dependencyReason" = any(${[...DEPENDENCY_REASONS]}::text[])) "dependencyReasons",
        bool_or(s."dependencyReason" is not null and s.state in ('pending','waiting')) "dependencyUnavailable",
        bool_or(s.outcome = 'blocked' and s.state in ('pending','waiting')) "dependencyWaiting",
        count(*) filter (where s.outcome in ('waiting','retrying') and coalesce(s."availableAt", now()) <= now()) ready,
        count(*) filter (where s.outcome = 'active') active
      from run_stages s group by s."runId"
    ), latest as (
      select distinct on ("runId") "runId", stage, "meaningfulAt" from run_stages
      where "meaningfulAt" is not null order by "runId", "meaningfulAt" desc, stage
    ) select r.*, coalesce(items.totals, ${JSON.stringify(Object.fromEntries(['total', ...RUN_OUTCOMES].map((k) => [k, 0])))}::text::jsonb) counts,
      coalesce(stage.totals, ${JSON.stringify(Object.fromEntries(['total', ...RUN_OUTCOMES].map((k) => [k, 0])))}::text::jsonb) "stageTotals",
      coalesce(stage.unfinished, 0)::int "unfinishedStages", coalesce(stage."dependencyWaiting", false) "dependencyWaiting",
      coalesce(stage.ready, 0)::int "readyStages",
      coalesce(stage."dependencyUnavailable", false) "dependencyUnavailable", stage."dependencyReasons",
      coalesce(stage."dependencyFailed", false) "dependencyFailed",
      latest."meaningfulAt" "lastProgressAt", latest.stage "lastStage", ${workerAvailable} "workerAvailable",
      coalesce(stage.ready > 0 and stage.active = 0 and
        coalesce(latest."meaningfulAt", r."createdAt") < now() - interval '2 minutes', false) "noDispatchBacklog"
    from runs r left join item_counts items on items."runId" = r.id
    left join stage_counts stage on stage."runId" = r.id left join latest on latest."runId" = r.id
    order by (r."finishedAt" is not null), r."createdAt" desc, r.id desc`.execute(db);
  return rows.map((raw) => {
    const row = raw;
    const state = runState(row);
    return {
      id: row.id,
      kind: row.kind,
      createdAt: row.createdAt,
      finishedAt: ['completed', 'completed_with_errors', 'cancelled'].includes(state) ? row.finishedAt : null,
      enumerationDone: row.enumerationDone,
      ...row.counts,
      stageTotals: row.stageTotals,
      state,
      lastProgressAt: row.lastProgressAt,
      lastStage: row.lastStage,
      reasons: runReasons(row),
      noDispatchBacklog: row.noDispatchBacklog,
    };
  });
}

export async function listRunItems(
  db: Kysely<any>,
  runId: string,
  take: number,
  skip: number,
): Promise<RunItemRead[] | undefined> {
  const { rows: exists } = await sql`select 1 from job_run where id = ${runId}::uuid`.execute(db);
  if (exists.length === 0) {
    return;
  }
  const { rows } =
    await sql<RunItemRead>`with stages as (${stagesFor(sql<boolean>`i."runId" = ${runId}::uuid`)}), selected as (
    select s."rootItemKey", ${selectedOutcome} outcome, ${counts('s')} "stageTotals",
      max(s."meaningfulAt") "lastProgressAt", bool_or(s.state = 'blocked') "dependencyFailed",
      array_agg(distinct s."dependencyReason") filter (where s.state in ('pending','waiting') and s."dependencyReason" = any(${[...DEPENDENCY_REASONS]}::text[])) "dependencyReasons",
      bool_or(s."dependencyReason" is not null and s.state in ('pending','waiting')) "dependencyUnavailable",
      bool_or(s.outcome = 'blocked' and s.state in ('pending','waiting')) "dependencyWaiting",
      count(*) filter (where s.state in ('pending','waiting','active')) unfinished
    from stages s where s."runId" = ${runId}::uuid and s."rootItemKey" is not null group by s."rootItemKey"
  ) select md5(${runId} || ':' || selected."rootItemKey") id, outcome, "stageTotals", "lastProgressAt", latest.stage "lastStage",
    array_remove(array[
      case when "dependencyFailed" then 'dependency_failed' end,
      case when "dependencyUnavailable" then 'dependency_unavailable'
        when outcome = 'blocked' and unfinished > 0 then 'dependency_wait' end,
      case when outcome = 'retrying' then 'retry_backoff' end,
      case when outcome = 'delayed' then 'scheduled_delay' end,
      case when outcome = 'paused' then 'queue_paused' end,
      case when ("stageTotals" ->> 'needsAttention')::int > 0 then 'needs_attention' end,
      case when ("stageTotals" ->> 'failed')::int > 0 then 'stage_failed' end
    ], null) || coalesce("dependencyReasons", array[]::text[]) reasons
    from selected left join lateral (select stage from stages s where s."runId" = ${runId}::uuid
      and s."rootItemKey" = selected."rootItemKey" and s."meaningfulAt" is not null
      order by s."meaningfulAt" desc, stage limit 1) latest on true
    order by selected."rootItemKey" limit ${take} offset ${skip}`.execute(db);
  return rows;
}

export async function observeQueueRun(db: Kysely<any>, name: string) {
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
  }>`with current_jobs as (
      select j.*, q.paused, p.state "parentState" from job j join job_queue q on q.name = j.queue
      left join job_run r on r.id = j."runId" left join job p on p.id = j."parentId"
      where j.queue = ${name} and (r."finishedAt" is null and (j."runId" is not null or j.state in ('pending','waiting','active')))
    ) select count(*) filter (where state = 'active')::int active,
      count(*) filter (where state in ('pending','waiting'))::int waiting,
      count(*) filter (where state in ('completed','failed','needs_attention','blocked','cancelled'))::int processed,
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
