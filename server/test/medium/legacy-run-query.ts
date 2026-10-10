import { Kysely, RawBuilder, sql } from 'kysely';
import { RUN_OUTCOMES, RunCounts, RunRead, RunReason, runReasons, runState } from 'src/queue/run-query.js';
import {
  initialCanonicalOutcomeContext,
  initialSelectionEntitlementRows,
  libraryRunPending,
  selectionItemContext,
  selectionItemState,
} from 'src/queue/selection-state.js';

/**
 * The run summary read as it was before cold initial rows were collapsed: one effective row for
 * every ledger row, then a sort of every root. Kept only as the reference the equivalence spec
 * compares `listRuns` against; nothing in the server calls it.
 */
const DEPENDENCY_REASONS = [
  'workload-disabled',
  'destination-unavailable',
  'destination-configuration',
  'destination-consent',
  'destination-budget',
  'source-unavailable',
  'local-capacity',
] as const;
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

export async function legacyListRuns(db: Kysely<any>, take: number, skip: number, runId?: string): Promise<RunRead[]> {
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
