import { Kysely, Transaction, sql } from 'kysely';
import { QUEUE_BATCH, QueueIntent } from 'src/queue/types.js';

type Executor = Kysely<any> | Transaction<any>;
export type LineageItemIdentity = { runId: string; itemKey: string; stage: string };

/** Retire one unexecuted request, not the active predecessor. Keep its old origin cancelled even
 * if the next request reuses a source tuple, and cancel only aliases the next request did not renew. */
export async function supersedeSelectionLineage(
  tx: Executor,
  source: { jobIds: string[] } | { items: LineageItemIdentity[] },
  next: QueueIntent,
) {
  if (('jobIds' in source ? source.jobIds : source.items).length === 0) return [];
  const selected =
    'jobIds' in source
      ? sql`i."jobId" = any(${source.jobIds}::uuid[])`
      : sql`i."jobId" is null and exists (
        select 1 from jsonb_to_recordset(${JSON.stringify(source.items)}::text::jsonb)
          as previous("runId" uuid, "itemKey" text, stage text)
        where (previous."runId", previous."itemKey", previous.stage) = (i."runId", i."itemKey", i.stage))`;
  const renewed = [{ runId: next.runId, itemKey: next.itemKey }, ...(next.memberships ?? [])];
  const { rows } = await sql<LineageItemIdentity & { rootItemKey: string | null }>`with source as materialized (
    select i."runId", i."itemKey", i.stage from job_run_item i
      where ${selected} and i.state in ('pending','waiting')
  ), retired as (
    update job_selection_lineage origin set superseded = true from source i
      where (origin."runId", origin."itemKey", origin.stage) = (i."runId", i."itemKey", i.stage)
      returning origin."selectionId", origin."itemKey", origin.stage
  ), identities as (
    select * from source union
    select m."runId", origin."itemKey", origin.stage from retired origin
      join job_selection_run m on m."selectionId" = origin."selectionId"
  ) update job_run_item shadow set state = 'cancelled', "jobId" = null,
      selection = case when shadow."libraryIntent"->>'sensitive' = 'true' then '{}'::jsonb else shadow.selection end,
      "libraryIntent" = case when shadow."libraryIntent"->>'sensitive' = 'true'
        then shadow."libraryIntent" - 'options' || jsonb_build_object('data', '{}'::jsonb) else shadow."libraryIntent" end
    from identities previous
    where (shadow."runId", shadow."itemKey", shadow.stage) = (previous."runId", previous."itemKey", previous.stage)
      and shadow.state in ('pending','waiting')
      and (shadow."jobId" is null or shadow."jobId" = any(${'jobIds' in source ? source.jobIds : []}::uuid[]))
      and not exists (select 1 from jsonb_to_recordset(${JSON.stringify(renewed)}::text::jsonb)
        as renewed("runId" uuid, "itemKey" text)
        where (renewed."runId", renewed."itemKey", ${next.name}) = (shadow."runId", shadow."itemKey", shadow.stage))
    returning shadow."runId", shadow."itemKey", shadow.stage, shadow."rootItemKey"`.execute(tx);
  return rows;
}

/** A late copy may precede a deferred child's execution assignment. Mirror its retained owner,
 * including terminal outcomes without a job, instead of relying on publication-time membership lists. */
export async function mirrorSelectionLineage(
  tx: Executor,
  source: { jobIds: string[] } | { items: LineageItemIdentity[] },
) {
  if (('jobIds' in source ? source.jobIds : source.items).length === 0) return [];
  const selected =
    'jobIds' in source
      ? sql`i."jobId" = any(${source.jobIds}::uuid[])`
      : sql`exists (select 1 from jsonb_to_recordset(${JSON.stringify(source.items)}::text::jsonb)
        as changed("runId" uuid, "itemKey" text, stage text)
        where (changed."runId", changed."itemKey", changed.stage) = (i."runId", i."itemKey", i.stage))`;
  const { rows } = await sql<LineageItemIdentity & { rootItemKey: string | null }>`update job_run_item shadow
    set "jobId" = i."jobId", state = i.state from job_run_item i
    join job_selection_lineage origin on (origin."runId", origin."itemKey", origin.stage) = (i."runId", i."itemKey", i.stage)
    join job_selection_run membership on membership."selectionId" = origin."selectionId"
    where ${selected} and not origin.superseded
      and (shadow."runId", shadow."itemKey", shadow.stage) = (membership."runId", origin."itemKey", origin.stage)
      -- Only an unresolved copy may acquire its owner's outcome. Linked jobs already sync directly;
      -- a deliberately detached terminal request must never inherit a replacement's execution.
      and shadow."jobId" is null and shadow.state in ('pending','waiting')
      and (shadow."jobId", shadow.state) is distinct from (i."jobId", i.state)
    returning shadow."runId", shadow."itemKey", shadow.stage, shadow."rootItemKey"`.execute(tx);
  return rows;
}

/** Publication owns the queue catalogue guard. Origins and their wake-up commit with the child jobs. */
export async function recordSelectionLineage(tx: Executor, parentId: string, children: QueueIntent[]) {
  const identities = children
    .filter((child) => child.runId && child.itemKey)
    .map((child) => ({ runId: child.runId, itemKey: child.itemKey, stage: child.name }));
  for (let offset = 0; offset < identities.length; offset += QUEUE_BATCH) {
    const page = identities.slice(offset, offset + QUEUE_BATCH);
    await sql`with origins as (
      select i."runId", i."rootItemKey", i."selectionId" from job_run_item i
        where i."jobId" = ${parentId}::uuid and i.state != 'cancelled' and i."selectionId" is not null
      union
      select i."runId", i."rootItemKey", l."selectionId" from job_run_item i
        join job_selection_lineage l on (l."runId", l."itemKey", l.stage) = (i."runId", i."itemKey", i.stage)
        where i."jobId" = ${parentId}::uuid and i.state != 'cancelled' and not l.superseded
    ), added as (
      insert into job_selection_lineage("selectionId", "runId", "itemKey", stage)
      select distinct on (o."selectionId", child."itemKey", child.stage)
        o."selectionId", child."runId", child."itemKey", child.stage
      from jsonb_to_recordset(${JSON.stringify(page)}::text::jsonb) as selected("runId" uuid, "itemKey" text, stage text)
      join job_run_item child on (child."runId", child."itemKey", child.stage) = (selected."runId", selected."itemKey", selected.stage)
      left join job_selection child_source on child_source.id = child."selectionId"
      join origins o on o."runId" = child."runId" and o."rootItemKey" is not distinct from child."rootItemKey"
      where child_source."sourceKind" is distinct from 'library-child'
      order by o."selectionId", child."itemKey", child.stage, child."runId"
      on conflict ("selectionId", "itemKey", stage) do nothing returning "selectionId"
    ), pending as (
      update job_selection_run m set "copyComplete" = false from job_selection s
      where m."selectionId" = s.id and m."runId" != s."runId"
        and s.id in (select "selectionId" from added) returning m."runId"
    ) update job_run set "enumerationDone" = false, "finishedAt" = null where id in (select "runId" from pending)`.execute(
      tx,
    );
  }
}

/** The sequence is assigned under publication's guard, so a cursor cannot pass an uncommitted descendant. */
export const selectionLineageSource = (selectionId: string, after: string, limit = QUEUE_BATCH) => sql`
  select l.id "lineageId", i."runId", i."itemKey", i."rootItemKey", i.stage, i.queue, i."selectionId",
    case when l.superseded then '{}'::jsonb else i.selection end selection,
    case when l.superseded then null::uuid else i."jobId" end "jobId",
    case when l.superseded then 'cancelled' else i.state end state
  from job_selection_lineage l join job_run_item i
    on (i."runId", i."itemKey", i.stage) = (l."runId", l."itemKey", l.stage)
  where l."selectionId" = ${selectionId}::uuid and l.id > ${after}::bigint and not l."libraryChildOrigin"
    and not exists (select 1 from job_selection s where s.id = i."selectionId" and s."sourceKind" = 'library-child')
  order by l.id limit ${limit}`;
