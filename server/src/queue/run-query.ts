import { Kysely, RawBuilder, sql } from 'kysely';
import { QueueName } from 'src/enum.js';
import {
  initialCanonicalOutcomeContext,
  initialSelectionEntitlementRows,
  libraryRunPending,
  selectionItemContext,
  selectionItemState,
} from 'src/queue/selection-state.js';

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
// OFFSET 0 retains one effective-state evaluation without a second full materialized ledger.
// The initial canonical tuple is its own entitlement/owner. Without either a detailed
// job or retained executor pointer, the complete state context reduces to item/header state.
// Frozen rows and admitted/shared owners keep the complete ownership/proof context.
const initialCanonicalWithoutExecution = sql<boolean>`snapshot."sourceKind"='library-initial'
  and i."runId"=snapshot."runId" and i."runId"=snapshot."libraryOperationId" and i."jobId" is null and i."libraryExecutionRunId" is null`;

// An initial alias with no sparse canonical exception has pending/null-owner state.
// Item-specific frozen proofs cannot grant an initial row: their source must be library-child.
const initialColdAliasWithoutExecution = sql<boolean>`snapshot."sourceKind"='library-initial'
  and i."runId"!=snapshot."runId" and i.state='pending' and i."jobId" is null
  and i."libraryExecutionRunId" is null and initial_canonical."itemKey" is null`;
const simpleInitialState = sql<boolean>`(${initialCanonicalWithoutExecution}) or (${initialColdAliasWithoutExecution})`;

const materializedInitialEntitlementContext = sql`left join initial_entitlements initial_entitlement
  on initial_entitlement."runId"=i."runId" and initial_entitlement."selectionId"=snapshot.id`;

// Classify simple initial rows after the scoped joins. Pushing that correlated predicate
// below them estimates one cold row and repeats queue/entitlement lookups for every root.
const stagesFor = (
  filter: RawBuilder<boolean>,
  runScope: RawBuilder<string>,
) => sql`with initial_entitlements as materialized (${initialSelectionEntitlementRows(runScope)})
  select "runId","rootItemKey",stage,state,"availableAt","dependencyReason","meaningfulAt",
  case
    when state = 'needs_attention' then 'needsAttention'
    when state not in ('pending','waiting') then state
    when paused then 'paused'
    when "dependencyReason" is not null then 'blocked'
    when "parentState" is not null and "parentState" != 'completed' then 'blocked'
    when attempt > "retryBaseAttempt" then 'retrying'
    when "availableAt" > now() then 'delayed'
    else 'waiting' end outcome
  from ((
  select i."runId", i."rootItemKey", i.stage, ${selectionItemState} state, j."availableAt", j.attempt, j."retryBaseAttempt", j."dependencyReason", q.paused,
  greatest(j."progressAt", j."startedAt", j."finishedAt") "meaningfulAt",
  p.state "parentState"
  ${selectionItemContext(runScope, materializedInitialEntitlementContext)}
  left join job_queue q on q.name = coalesce(j.queue, i.queue)
  left join lateral (select parent.state from job parent where j."parentId" is not null
    and parent.id = j."parentId" limit 1) p on true
  where ${filter} and not coalesce((${simpleInitialState}),false) offset 0
  ) union all (
  select "runId","rootItemKey",stage,state,"availableAt",attempt,"retryBaseAttempt","dependencyReason",paused,"meaningfulAt","parentState"
  from (
  select i."runId",i."rootItemKey",i.stage,
    case when i."runId"!=snapshot."libraryOperationId" and not coalesce(initial_entitlement.entitled,false) then 'cancelled'
      when i.state='pending' and snapshot.state in ('needs_attention','cancelled') then snapshot.state else i.state end state,
    null::timestamptz "availableAt",null::int attempt,null::int "retryBaseAttempt",null::text "dependencyReason",q.paused,
    null::timestamptz "meaningfulAt",null::text "parentState",(${simpleInitialState}) "simpleInitial"
  from job_run_item i join job_selection snapshot on snapshot.id=i."selectionId"
  ${initialCanonicalOutcomeContext}
  ${materializedInitialEntitlementContext}
  left join job_queue q on q.name=i.queue
  where ${filter} offset 0
  ) initial_candidates where "simpleInitial" offset 0
  )) effective`;

const counts = (alias: string) => sql`jsonb_build_object('total', count(*)::int,
  ${sql.join(RUN_OUTCOMES.map((key) => sql`${key}::text, count(*) filter (where ${sql.ref(`${alias}.outcome`)} = ${key})::int`))})`;

// Nonterminal stages take precedence: a failed thumbnail plus a live face stage is still active.
// A stored blocked stage is terminal prerequisite failure; a derived blocked pending stage is not.
// One scalar aggregate preserves this priority without nine aggregate states per root.
const selectedPriority = sql<number>`case
  when outcome='active' then 10
  when outcome='retrying' then 9
  when outcome='waiting' then 8
  when outcome='delayed' then 7
  when outcome='paused' then 6
  when outcome='blocked' and state in ('pending','waiting') then 5
  when outcome='needsAttention' then 4
  when outcome in ('failed','blocked') then 3
  when outcome='cancelled' then 2 else 1 end`;

const selectedOutcome = (priority: RawBuilder<number> = selectedPriority) => sql`case max(${priority})
  when 10 then 'active' when 9 then 'retrying' when 8 then 'waiting'
  when 7 then 'delayed' when 6 then 'paused' when 5 then 'blocked'
  when 4 then 'needsAttention' when 3 then 'failed' when 2 then 'cancelled'
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
  librarySourceAttention?: boolean;
  managerSetupPending?: boolean;
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
  librarySourceAttention?: boolean;
  managerSetupPending?: boolean;
}): RunReason[] => {
  const reasons: RunReason[] = [];
  if (!row.enumerationDone) {
    reasons.push('enumerating');
  }
  const setupPending = row.managerSetupPending && (!row.enumerationDone || row.unfinishedStages > 0);
  if (setupPending) reasons.push('first_setup_pending');
  if ((!row.enumerationDone || row.unfinishedStages > 0) && !row.workerAvailable && !setupPending) {
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
  if (row.librarySourceAttention || row.stageTotals.needsAttention > 0) {
    reasons.push('needs_attention');
  }
  if (row.stageTotals.failed > 0) {
    reasons.push('stage_failed');
  }
  return reasons;
};

export const runState = (
  row: Pick<
    Aggregate,
    | 'enumerationDone'
    | 'unfinishedStages'
    | 'workerAvailable'
    | 'stageTotals'
    | 'readyStages'
    | 'librarySourceAttention'
    | 'managerSetupPending'
  >,
): RunState => {
  const stages = row.stageTotals;
  if (row.librarySourceAttention && stages.active === 0) return 'needs_attention';
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
  if (row.managerSetupPending) return 'blocked';
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

export async function listRuns(db: Kysely<any>, take: number, skip: number, runId?: string): Promise<RunRead[]> {
  const { rows } = await sql<Aggregate>`with runs as (
      select r.id, r.kind, r."createdAt", r."finishedAt", (r."enumerationDone" and not (${libraryRunPending(sql<string>`r.id`)})) "enumerationDone",
        exists (select 1 from job_selection_run m join job_selection s on s.id = m."selectionId"
          where m."runId" = r.id and s."sourceKind" = 'library-initial' and s.state = 'needs_attention') "librarySourceAttention",
        coalesce(r.kind='immich-import-derived'
          and r.selection->'managerSetup'->>'installation' ~ '^[a-f0-9]{12}$'
          and nullif(r.selection->'managerSetup'->>'operationId','') is not null
          and r.selection->'managerSetup' ? 'startedAt'
          and r.selection->'managerSetup'->>'startedAt' is null,false) "managerSetupPending"
      from job_run r
      ${runId === undefined ? sql`` : sql`where r.id = ${runId}::uuid`}
      order by (r."finishedAt" is not null), r."createdAt" desc, r.id desc limit ${take} offset ${skip}
    ), stages as (${stagesFor(sql<boolean>`i."runId" in (select id from runs)`, sql<string>`select id from runs`)}), run_stages as (
      select s.* from stages s
    ), selected as (
      select "runId", "rootItemKey", ${selectedOutcome(sql<number>`priority`)} outcome
      -- Sort bytewise root identities and one priority integer to bound spill work.
      from (select * from (
        select "runId", "rootItemKey" collate "C" "rootItemKey", ${selectedPriority} priority from run_stages
        where "rootItemKey" is not null offset 0) ranked_roots
        order by "runId", "rootItemKey" collate "C" offset 0) ordered_roots
      group by "runId", "rootItemKey"
    ), item_counts as (
      select s."runId", ${counts('s')} totals from selected s group by s."runId"
    ), stage_counts as (
      select s."runId", ${counts('s')} totals,
        count(*) filter (where s.state in ('pending','waiting','active')) unfinished,
        bool_or(s.state = 'blocked') "dependencyFailed",
        array_remove(array[${sql.join([...DEPENDENCY_REASONS].sort().map((reason) => sql`case when bool_or(s.state in ('pending','waiting') and s."dependencyReason"=${reason}) then ${reason}::text end`))}],null) "dependencyReasons",
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
      coalesce(stage.ready > 0 and stage.active = 0 and not r."managerSetupPending" and
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
  const { rows } = await sql<RunItemRead>`with roots as materialized (
      select distinct "rootItemKey" from job_run_item where "runId" = ${runId}::uuid and "rootItemKey" is not null
      order by "rootItemKey" limit ${take} offset ${skip}
    ), stages as (${stagesFor(sql<boolean>`i."runId" = ${runId}::uuid and i."rootItemKey" in (select "rootItemKey" from roots)`, sql<string>`${runId}::uuid`)}), selected as (
    select s."rootItemKey", ${selectedOutcome()} outcome, ${counts('s')} "stageTotals",
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
    order by selected."rootItemKey"`.execute(db);
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
