import { type Kysely, type RawBuilder, type Transaction, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { JobName, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { attachProducerRun } from 'src/queue/manifest.js';
import { libraryCanonicalState, libraryMembershipEntitled } from 'src/queue/selection-state.js';
import { QUEUE_BATCH, type QueueExecution, type QueueIntent } from 'src/queue/types.js';
import { canonicalJson } from 'src/utils/object.js';

export type LibrarySourceIdentity = { operationId: string; libraryId: string };
/** An operation is its own run. A deduplicated drain wake is never selected-media identity. */
export const libraryRunId = (operationId: string) => operationId;

export const librarySourceKey = (intent: QueueIntent) => {
  if (!intent.rootItemKey) throw new Error('Library processing intent requires actual media identity');
  const declared = [
    intent.rootItemKey,
    intent.name,
    intent.queue,
    intent.data,
    intent.options ?? null,
    intent.safeToRetry,
    intent.sensitive,
    intent.deadlineMs,
  ];
  // Match persisted JSON semantics (including dates), then canonicalize object key order.
  return createHash('sha256')
    .update(canonicalJson(JSON.parse(JSON.stringify(declared))))
    .digest('hex');
};

/** Catalogue -> queue claim -> domain claim; the caller's domain callback takes the latter. */
export async function withLibraryQueueFence<T>(
  db: Kysely<any>,
  context: QueueExecution | undefined,
  work: (tx: Transaction<any>) => Promise<T>,
): Promise<T> {
  context?.signal.throwIfAborted();
  return db.transaction().execute(async (tx) => {
    await sql`select name from job_queue order by name for no key update`.execute(tx);
    const fence = async (lock: boolean) => {
      context?.signal.throwIfAborted();
      if (!context) return;
      const { rows } = await sql`select id from job where id = ${context.claim.id}::uuid
        and token = ${context.claim.token}::uuid and state = 'active' and "leaseExpiresAt" > clock_timestamp()
        and "cancelRequestedAt" is null ${lock ? sql`for update` : sql``}`.execute(tx);
      if (rows.length === 0) throw new Error('Library scan queue claim is no longer active');
      context.signal.throwIfAborted();
    };
    await fence(true);
    const value = await work(tx);
    await fence(false);
    return value;
  });
}

/** Small setup only. Domain sources never attach their lifetime to the current producer job. */
export async function ensureLibrarySource(
  tx: Transaction<any>,
  identity: LibrarySourceIdentity,
  intent: QueueIntent,
  context?: QueueExecution,
) {
  if (intent.name !== JobName.SidecarCheck) throw new Error('Library initial stage must discover its sidecar');
  const { rows } = await sql`select id from media_operation where id = ${identity.operationId}::uuid
    and kind = ${MediaOperationKind.LibraryScan} and snapshot->>'libraryId' = ${identity.libraryId}
    and status not in ('completed','failed','cancelled') for update`.execute(tx);
  if (rows.length === 0) throw new Error('Library source operation is no longer active');
  await sql`insert into job_run(id, kind, selection) values (${identity.operationId}::uuid, ${MediaOperationKind.LibraryScan},
    ${JSON.stringify({ libraryId: identity.libraryId })}::text::jsonb) on conflict do nothing`.execute(tx);
  await sql`insert into job_selection(id, "runId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state,
    "sourceKind", "libraryOperationId") values (${identity.operationId}::uuid, ${identity.operationId}::uuid,
    ${intent.name}, ${intent.queue}, ${intent.safeToRetry}, ${intent.sensitive}, ${intent.deadlineMs}, 'enumerating',
    'library-initial', ${identity.operationId}::uuid) on conflict ("runId", stage) do nothing`.execute(tx);
  await sql`insert into job_selection_run("runId", "selectionId", "copyComplete")
    values (${identity.operationId}::uuid, ${identity.operationId}::uuid, true) on conflict do nothing`.execute(tx);
  if (context) {
    // This establishes the origin before QueueAll completion, without changing the drain's run.
    await attachProducerRun(tx, context.claim);
    await sql`insert into job_library_source_producer("selectionId", "producerId")
      values (${identity.operationId}::uuid, ${context.claim.id}::uuid) on conflict do nothing`.execute(tx);
    await attachLibraryParticipants(tx, { producerId: context.claim.id });
  }
}

/** Domain headers have no producer owner. This metadata bridge discovers origin requests and
 * child-header participants in pages, including requests arriving after a producer completed.
 * Caller owns the catalogue guard; LIMIT bounds every inserted mapping and reopened run.
 */
export async function attachLibraryParticipants(
  tx: Kysely<any> | Transaction<any>,
  filter: { producerId: string } | { queue: string },
) {
  const { rows } = await sql<{ runId: string }>`with candidates as materialized (
    select membership."runId", initial.id "selectionId", membership."itemKey" "producerItemKey",
      membership.stage "producerStage", link."producerId" from job_library_source_producer link
    join job_selection initial on initial.id = link."selectionId"
    join job_run_item membership on coalesce(membership."libraryProducerId", membership."jobId") = link."producerId" and membership."rootItemKey" is null
      and membership.state != 'cancelled'
    where ${'producerId' in filter ? sql`link."producerId" = ${filter.producerId}::uuid` : sql`initial.queue = ${filter.queue}`}
      and not exists (select 1 from job_selection_run m where m."runId" = membership."runId" and m."selectionId" = initial.id)
    union all
    select origin."runId", child.id, null::text, null::text, null::uuid from job_selection child
      join job_selection_run origin on origin."selectionId" = child."libraryOperationId"
    where child."sourceKind" = 'library-child'
      and (${libraryMembershipEntitled(sql<string>`origin."runId"`, sql<string>`child."libraryOperationId"`)})
      and ${'producerId' in filter ? sql`exists (select 1 from job_library_source_producer link where link."selectionId" = child."libraryOperationId" and link."producerId" = ${filter.producerId}::uuid)` : sql`child.queue = ${filter.queue}`}
      and not exists (select 1 from job_selection_run m where m."runId" = origin."runId" and m."selectionId" = child.id)
    union all
    select membership."runId", child.id, request."itemKey", request.stage,
      coalesce(original."libraryFrozenProducerId", original."producerId") from job_selection_lineage origin
      join job_run_item item on (item."runId", item."itemKey", item.stage) = (origin."runId", origin."itemKey", origin.stage)
      join job_selection child on child.id = item."selectionId" and child."sourceKind" = 'library-child'
      join job_selection original on original.id = origin."selectionId" and original."sourceKind" = 'frozen'
      join job_selection_run membership on membership."selectionId" = origin."selectionId"
      left join lateral (select "itemKey", stage from job_run_item request where request."runId" = membership."runId"
        and request."rootItemKey" is null and request.state != 'cancelled'
        and coalesce(request."libraryProducerId", request."jobId") = coalesce(original."libraryFrozenProducerId", original."producerId") limit 1) request on true
    where not origin.superseded and item."libraryOriginComplete"
      and ${'producerId' in filter ? sql`exists (select 1 from job_selection initial where initial.id = origin."selectionId" and initial."producerId" = ${filter.producerId}::uuid)` : sql`child.queue = ${filter.queue}`}
      and (${libraryMembershipEntitled(sql<string>`membership."runId"`, sql<string>`child."libraryOperationId"`)})
      and not exists (select 1 from job_selection_run m where m."runId" = membership."runId" and m."selectionId" = child.id)
    limit ${QUEUE_BATCH}
  ), marked as (
    update job_run_item request set "libraryProducerId" = c."producerId" from candidates c
      where request."runId" = c."runId" and request."itemKey" = c."producerItemKey" and request.stage = c."producerStage"
      returning 1
  ), attached as (
    insert into job_selection_run("runId", "selectionId", "copyComplete")
    select c."runId", c."selectionId", c."runId" = s."runId" from candidates c
      join job_selection s on s.id = c."selectionId" where (select count(*) from marked) >= 0
      on conflict do nothing returning "runId"
  ) update job_run set "enumerationDone" = false, "finishedAt" = null
    where id in (select "runId" from attached) returning id "runId"`.execute(tx);
  return rows.length > 0;
}

/** A cancelled/detached origin request cannot acquire new sources through a completed producer. */
export const libraryProducerAttachmentPending = (producerId: string) => sql<boolean>`exists (
  select 1 from job_library_source_producer link join job_run_item i on coalesce(i."libraryProducerId", i."jobId") = link."producerId"
    and i."rootItemKey" is null and i.state != 'cancelled'
  where link."producerId" = ${producerId}::uuid and not exists (
    select 1 from job_selection_run m where m."selectionId" = link."selectionId" and m."runId" = i."runId"))`;

/** No hot execution rows. Each accepted page appends durable source membership in the same transaction. */
export async function appendLibraryInitialSources(tx: Transaction<any>, operationId: string, intents: QueueIntent[]) {
  if (intents.length > QUEUE_BATCH) throw new Error('Library source acceptance is limited to 250 intents');
  const {
    rows: [source],
  } = await sql<{ queue: string; appendSequence: string }>`select queue, "appendSequence"
    from job_selection where id = ${operationId}::uuid and "libraryOperationId" = ${operationId}::uuid
    and "sourceKind" = 'library-initial' and state = 'enumerating' and "capturedAt" is null
    and "sourceClosedAt" is null for update`.execute(tx);
  if (!source) throw new Error('Library initial source is not open');
  for (const intent of intents) {
    if (intent.name !== JobName.SidecarCheck || intent.queue !== source.queue)
      throw new Error('Library initial intent changed stage');
  }
  await appendSourcePage(
    tx,
    operationId,
    operationId,
    source.appendSequence,
    intents.map((intent) => ({ ...intent, parentId: undefined })),
  );
  // No participant copy can run while capturedAt is null; closure makes the complete immutable set visible.
}

/** Caller holds the source row and catalogue guard. All retained JS/SQL parameters are one <=250 page. */
type SharedLibraryExecutions = Map<string, { runId: string; itemKey: string; rootItemKey: string | null }>;

/** Scoped to one accepted physical parent publication; this is execution ownership, not handler deduplication. */
const physicalLibraryIntentKey = (intent: QueueIntent) =>
  canonicalJson(
    JSON.parse(
      JSON.stringify([
        intent.name,
        intent.queue,
        intent.data,
        intent.options ?? null,
        intent.safeToRetry,
        intent.sensitive,
        intent.deadlineMs,
      ]),
    ),
  );

async function appendSourcePage(
  tx: Transaction<any>,
  selectionId: string,
  operationId: string,
  after: string,
  intents: QueueIntent[],
  executionOwners?: SharedLibraryExecutions,
) {
  if (intents.length > QUEUE_BATCH) throw new Error('Library append is limited to 250 intents');
  if (intents.length === 0) return;
  const prepared = new Map(intents.map((intent) => [librarySourceKey(intent), intent]));
  const { rows: existing } = await sql<{
    key: string;
    runId: string;
    itemKey: string;
    rootItemKey: string | null;
    libraryExecutionRunId: string | null;
    libraryExecutionItemKey: string | null;
  }>`select "librarySourceKey" key,"runId","itemKey","rootItemKey","libraryExecutionRunId","libraryExecutionItemKey" from job_run_item
    where "selectionId" = ${selectionId}::uuid and "runId" = ${operationId}::uuid
      and "librarySourceKey" = any(${prepared.keys().toArray()}::text[])`.execute(tx);
  for (const row of existing) {
    const intent = prepared.get(row.key)!;
    executionOwners?.set(physicalLibraryIntentKey(intent), {
      runId: row.libraryExecutionRunId ?? row.runId,
      itemKey: row.libraryExecutionItemKey ?? row.itemKey,
      rootItemKey: row.rootItemKey,
    });
    prepared.delete(row.key);
  }
  let sequence = BigInt(after);
  const page = [...prepared].map(([key, intent]) => {
    const itemKey = `library/${selectionId}/${(++sequence).toString().padStart(20, '0')}`;
    const physicalKey = physicalLibraryIntentKey(intent);
    const owner = executionOwners?.get(physicalKey) ?? {
      runId: operationId,
      itemKey,
      rootItemKey: intent.rootItemKey ?? null,
    };
    executionOwners?.set(physicalKey, owner);
    return {
      key,
      itemKey,
      executionRunId: selectionId === operationId ? null : owner.runId,
      executionItemKey: selectionId === operationId ? null : owner.itemKey,
      rootItemKey: intent.rootItemKey,
      stage: intent.name,
      queue: intent.queue,
      selection: intent.sensitive ? {} : intent.data,
      parentId: intent.parentId ?? null,
      originComplete: selectionId === operationId,
      intent: { ...intent, runId: operationId, itemKey },
    };
  });
  if (page.length > 0) {
    await sql`insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "selectionId",
      "librarySourceKey", "libraryIntent", "libraryParentId", "libraryOriginComplete", "libraryExecutionRunId", "libraryExecutionItemKey")
      select ${operationId}::uuid, p."itemKey", p."rootItemKey", p.stage, p.queue, p.selection, ${selectionId}::uuid,
        p.key, p.intent, p."parentId", p."originComplete", p."executionRunId", p."executionItemKey" from jsonb_to_recordset(${JSON.stringify(page)}::text::jsonb)
        as p(key text, "itemKey" text, "rootItemKey" text, stage text, queue text, selection jsonb, intent jsonb, "parentId" uuid, "originComplete" boolean, "executionRunId" uuid, "executionItemKey" text)`.execute(
      tx,
    );
    await sql`update job_selection set "appendSequence" = ${sequence.toString()}::bigint where id = ${selectionId}::uuid`.execute(
      tx,
    );
    // Version lag is visible immediately to reads and settlement. A bounded copier acknowledges
    // the new tail; publication never invalidates or materializes every participant.
  }
}

/** Called only after actual enumeration, under the same queue/domain fences as its final checkpoint. */
export async function closeLibrarySource(tx: Transaction<any>, operationId: string) {
  const { rows } = await sql`update job_selection set "sourceClosedAt" = clock_timestamp(),
    "capturedAt" = clock_timestamp(), state = 'ready' where id = ${operationId}::uuid
    and "sourceKind" = 'library-initial' and state = 'enumerating' and "sourceClosedAt" is null returning id`.execute(
    tx,
  );
  if (rows.length !== 1) throw new Error('Library source cannot close twice or before successful enumeration');
  await sql`update job_run set "enumerationDone" = true where id = ${operationId}::uuid`.execute(tx);
  await sql`select pg_notify('frameleaf_jobs', '')`.execute(tx);
}

/** Failure does not freeze or make partial enumeration runnable. Its durable rows need explicit attention. */
export async function markLibrarySourceOutcome(tx: Transaction<any>, operationId: string) {
  await sql`update job_selection s set state = 'needs_attention' from media_operation o
    where s."libraryOperationId" = o.id and o.id = ${operationId}::uuid and o.kind = ${MediaOperationKind.LibraryScan}
      and o.status in (${MediaOperationStatus.Failed}, ${MediaOperationStatus.Cancelled})
      and s."sourceKind" = 'library-initial' and s.state = 'enumerating' and s."sourceClosedAt" is null`.execute(tx);
  await sql`select pg_notify('frameleaf_jobs', '')`.execute(tx);
}

/** Bounded terminal repair for operations failed by domain recovery or cancellation before a worker owns them. */
export async function settleTerminalLibrarySources(tx: Transaction<any>) {
  const { rows } = await sql`with terminal as (
    select s.id from job_selection s join media_operation o on o.id = s."libraryOperationId"
    where s."sourceKind" = 'library-initial' and s.state = 'enumerating' and s."sourceClosedAt" is null
      and o.kind = ${MediaOperationKind.LibraryScan} and o.status in ('failed','cancelled')
    order by s.id limit ${QUEUE_BATCH} for update of s, o skip locked
  ) update job_selection set state = 'needs_attention' where id in (select id from terminal) returning id`.execute(tx);
  if (rows.length > 0) await sql`select pg_notify('frameleaf_jobs', '')`.execute(tx);
  return rows.length;
}

/** Future completion hook: caller has accepted the parent token under the catalogue lock.
 * Only the canonical library operation owns this child source. Alias mappings must be attached
 * by the accepted bounded lineage protocol before any participant can acknowledge completion.
 */
export async function appendLibraryChildSources(
  tx: Transaction<any>,
  parent: { operationId: string; jobId: string; rootItemKey: string },
  intents: QueueIntent[],
  executionOwners?: SharedLibraryExecutions,
) {
  if (intents.length > QUEUE_BATCH) throw new Error('Library child acceptance is limited to 250 intents');
  const { rows } = await sql`select j.id from job_run_item i join job_selection s on s.id=i."selectionId"
    join job_run_item owner on (owner."runId",owner."itemKey",owner.stage)=(coalesce(i."libraryExecutionRunId",i."runId"),coalesce(i."libraryExecutionItemKey",i."itemKey"),i.stage)
    join job j on j.id=owner."jobId"
    where j.id = ${parent.jobId}::uuid and j.state = 'completed' and i."runId" = ${parent.operationId}::uuid
      and i."rootItemKey" = ${parent.rootItemKey} and i.state != 'cancelled'
      and s."libraryOperationId" = ${parent.operationId}::uuid and s."sourceClosedAt" is not null
      and s.state = 'ready' limit 1`.execute(tx);
  if (rows.length !== 1) throw new Error('Library child has no accepted parent membership');
  const groups = new Map<string, QueueIntent[]>();
  for (const intent of intents) {
    if (!Object.values(JobName).includes(intent.name as JobName))
      throw new Error('Library child requires a registered stage name');
    if (intent.runId && intent.runId !== parent.operationId)
      throw new Error('Library child cannot change operation identity');
    if (intent.rootItemKey && intent.rootItemKey !== parent.rootItemKey)
      throw new Error('Library child cannot change media identity');
    const group = groups.get(intent.name) ?? [];
    group.push({ ...intent, runId: parent.operationId, rootItemKey: parent.rootItemKey, parentId: parent.jobId });
    groups.set(intent.name, group);
  }
  const sourceIds: string[] = [];
  for (const [name, group] of groups) {
    const intent = group[0];
    if (group.some((entry) => entry.queue !== intent.queue))
      throw new Error('Library child changed queue within one stage');
    // Initial media selection is already frozen. Each child publication freezes its own bounded
    // intent page; this explicit child ledger can append versions while generic captures cannot.
    // sourceClosedAt/capturedAt mark its accepted first page, not a permanent end-of-child-work.
    // New tail pages advance a version; stale participant acknowledgements cannot settle a run.
    // Namespaced source stage avoids the (run,stage) frozen-source key and initial Sidecar stage.
    const stage = `library-child/${name}`;
    await sql`insert into job_selection(id, "runId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state,
      "sourceKind", "libraryOperationId", "capturedAt", "sourceClosedAt")
      values (${randomUUID()}::uuid, ${parent.operationId}::uuid, ${stage}, ${intent.queue}, ${intent.safeToRetry},
        ${intent.sensitive}, ${intent.deadlineMs}, 'ready', 'library-child', ${parent.operationId}::uuid,
        clock_timestamp(), clock_timestamp()) on conflict ("runId", stage) do nothing`.execute(tx);
    const {
      rows: [source],
    } = await sql<{ id: string; queue: string; appendSequence: string }>`select id, queue, "appendSequence"
      from job_selection where "runId" = ${parent.operationId}::uuid and stage = ${stage}
      and "sourceKind" = 'library-child' and state = 'ready' and "sourceClosedAt" is not null for update`.execute(tx);
    if (!source || source.queue !== intent.queue)
      throw new Error('Library child source is no longer accepting this queue');
    await sql`insert into job_selection_run("runId", "selectionId", "copyComplete")
      values (${parent.operationId}::uuid, ${source.id}::uuid, true) on conflict do nothing`.execute(tx);
    // Restore classification is conservative across all accepted rows, including operation-owned
    // intents. A safe first row cannot make a later unsafe cold row replayable after restore.
    await sql`update job_selection set "safeToRetry"="safeToRetry" and ${group.every((entry) => entry.safeToRetry && !('operationId' in entry.data))}
      where id=${source.id}::uuid`.execute(tx);
    await appendSourcePage(tx, source.id, parent.operationId, source.appendSequence, group, executionOwners);
    sourceIds.push(source.id);
  }
  if (sourceIds.length > 0) {
    await sql`update job_run set "finishedAt" = null where id = ${parent.operationId}::uuid`.execute(tx);
    await sql`select pg_notify('frameleaf_jobs', '')`.execute(tx);
  }
  return sourceIds;
}

/** Explicit child discovery owns these origin proofs; generic initial descendant copying skips
 * library-child rows. Select source identities, never participant arrays. A source's immutable
 * selected roots constrain every later copied child, including after handler payload pruning.
 */
export const libraryChildOrigins = (parentId: RawBuilder<string>, root: RawBuilder<string>) => sql`
  select original.id from job_run_item parent join job_selection original on original.id = parent."selectionId"
    where (parent."jobId" = ${parentId} or (parent."libraryExecutionRunId",parent."libraryExecutionItemKey",parent.stage) in (
      select owner."runId",owner."itemKey",owner.stage from job_run_item owner join job_selection source on source.id=owner."selectionId"
        where owner."jobId"=${parentId} and owner."libraryIntent" is not null and owner."runId"=source."runId" and source."sourceKind"!='frozen' limit ${QUEUE_BATCH + 1}))
      and parent."rootItemKey" = ${root} and parent.state != 'cancelled'
      and parent."runId" = original."runId" and original."sourceKind" = 'frozen'
  union
  select original.id from job_run_item parent join job_selection_lineage origin
    on (origin."runId", origin."itemKey", origin.stage) = (parent."runId", parent."itemKey", parent.stage)
    join job_selection original on original.id = origin."selectionId"
    where (parent."jobId" = ${parentId} or (parent."libraryExecutionRunId",parent."libraryExecutionItemKey",parent.stage) in (
      select owner."runId",owner."itemKey",owner.stage from job_run_item owner join job_selection source on source.id=owner."selectionId"
        where owner."jobId"=${parentId} and owner."libraryIntent" is not null and owner."runId"=source."runId" and source."sourceKind"!='frozen' limit ${QUEUE_BATCH + 1}))
      and parent."rootItemKey" = ${root} and parent.state != 'cancelled'
      and original."sourceKind" = 'frozen' and not origin.superseded`;

/** One visit records <=250 origin proofs from <=250 canonical child rows. The bounded prefix
 * remains unfeedable and unacknowledged until its proofs are complete; late alias attachment
 * uses the same retained source identity and never grants whole-operation membership.
 */
export async function discoverLibraryChildOrigins(
  tx: Kysely<any> | Transaction<any>,
  filter: { producerId: string } | { queue: string },
) {
  const { rows: selections } = await sql<{ id: string; runId: string }>`select s.id, s."runId" from job_selection s
    where s."sourceKind" = 'library-child'
      and ${
        'producerId' in filter
          ? sql`(exists (select 1 from job_library_source_producer link where link."selectionId" = s."libraryOperationId" and link."producerId" = ${filter.producerId}::uuid)
        or exists (select 1 from job_selection_lineage origin join job_run_item i on (i."runId",i."itemKey",i.stage)=(origin."runId",origin."itemKey",origin.stage)
          join job_selection original on original.id=origin."selectionId" where i."selectionId"=s.id and not origin.superseded
            and coalesce(original."libraryFrozenProducerId",original."producerId")=${filter.producerId}::uuid))`
          : sql`s.queue = ${filter.queue}`
      }
      and exists (select 1 from job_run_item i where i."selectionId" = s.id and i."runId" = s."runId"
        and i."libraryIntent" is not null and not i."libraryOriginComplete")
    order by s.id limit 1`.execute(tx);
  if (selections.length === 0) return false;
  const source = selections[0];
  const { rows } = await sql`with children as materialized (
    select "runId", "itemKey", stage, "rootItemKey", "libraryParentId", "libraryOriginAfter" from job_run_item
      where "selectionId" = ${source.id}::uuid and "runId" = ${source.runId}::uuid and not "libraryOriginComplete"
      order by "itemKey" limit ${QUEUE_BATCH} for update
  ), origins as materialized (
    select c."itemKey", c.stage, eligible.id from children c cross join lateral (
      select id from (${libraryChildOrigins(sql<string>`c."libraryParentId"`, sql<string>`c."rootItemKey"`)}) proven
      where c."libraryOriginAfter" is null or id > c."libraryOriginAfter" order by id limit ${QUEUE_BATCH + 1}
    ) eligible
  ), page as materialized (
    select * from origins order by "itemKey", id limit ${QUEUE_BATCH}
  ), archived as (
    update job_selection s set "libraryFrozenProducerId" = coalesce(s."libraryFrozenProducerId", s."producerId")
      where s.id in (select id from page) returning id
  ), recorded as (
    insert into job_selection_lineage("selectionId", "runId", "itemKey", stage, "libraryChildOrigin")
      select id, ${source.runId}::uuid, "itemKey", stage, true from page where (select count(*) from archived) >= 0 on conflict do nothing returning 1
  ), after as (
    select "itemKey", max(id::text)::uuid id from page group by "itemKey"
  ) update job_run_item i set "libraryOriginAfter" = coalesce(a.id, i."libraryOriginAfter"),
      "libraryOriginComplete" = not exists (select 1 from origins o where o."itemKey" = i."itemKey" and (coalesce(a.id, i."libraryOriginAfter") is null or o.id > coalesce(a.id, i."libraryOriginAfter")))
    from children c left join after a on a."itemKey" = c."itemKey"
    where (i."runId", i."itemKey", i.stage) = (c."runId", c."itemKey", c.stage)
      and (select count(*) from recorded) >= 0 returning i."itemKey"`.execute(tx);
  if (rows.length > 0) await sql`select pg_notify('frameleaf_jobs', '')`.execute(tx);
  return rows.length > 0;
}

/** Library parents publish one canonical page; aliases are discovered by header copying. */
export async function publishLibraryFollowups(tx: Transaction<any>, jobId: string, intents: QueueIntent[]) {
  const { rows: parents } = await sql<{ operationId: string; rootItemKey: string }>`with owners as materialized (
    select "runId","itemKey",stage from job_run_item where "jobId"=${jobId}::uuid and "libraryIntent" is not null limit ${QUEUE_BATCH + 1}
  ), memberships as (
    select "selectionId","rootItemKey",state from job_run_item where "jobId"=${jobId}::uuid and "libraryIntent" is not null
    union
    select i."selectionId",i."rootItemKey",i.state from owners owner join job_run_item i
      on (i."libraryExecutionRunId",i."libraryExecutionItemKey",i.stage)=(owner."runId",owner."itemKey",owner.stage)
      where i."libraryIntent" is not null
  ) select distinct s."libraryOperationId" "operationId",i."rootItemKey" from memberships i join job_selection s on s.id=i."selectionId"
    where i.state!='cancelled' and s."sourceKind" in ('library-initial','library-child')
      and s.state='ready' and s."sourceClosedAt" is not null
    order by s."libraryOperationId",i."rootItemKey" limit ${QUEUE_BATCH + 1}`.execute(tx);
  if (parents.length === 0) {
    // A stopped library source cannot turn its inherited followups into ordinary direct jobs.
    // Recognition is independent of descendant eligibility and uses one retained physical row.
    const { rows } = await sql`select 1 from job_run_item i join job_selection s on s.id=i."selectionId"
      where i."jobId"=${jobId}::uuid and i."libraryIntent" is not null
        and s."sourceKind" in ('library-initial','library-child') limit 1`.execute(tx);
    return rows.length > 0;
  }
  if (intents.length === 0) return true;

  if (parents.length * intents.length > QUEUE_BATCH)
    throw new Error('Library parent publication exceeds one bounded intent page');
  const executionOwners: SharedLibraryExecutions = new Map();
  for (const parent of parents) {
    await appendLibraryChildSources(
      tx,
      { ...parent, jobId },
      intents.map((intent) => ({
        ...intent,
        runId: parent.operationId,
        rootItemKey: parent.rootItemKey,
        memberships: undefined,
      })),
      executionOwners,
    );
  }
  return true;
}

/** Sensitive execution payloads live only until their retained owner reaches a terminal state.
 * Source identity remains available for deduplication; late copies receive the redacted value.
 */
export async function redactLibraryPayloads(
  tx: Kysely<any> | Transaction<any>,
  jobId: string | string[],
  terminalOnly = true,
) {
  const jobIds = Array.isArray(jobId) ? jobId : [jobId];
  await sql`update job_run_item i set selection = '{}'::jsonb,
    "libraryIntent" = i."libraryIntent" - 'options' || jsonb_build_object('data', '{}'::jsonb)
    from job j where j.id = any(${jobIds}::uuid[]) and j.sensitive and i."jobId" = j.id
      and i."libraryIntent" is not null and (${!terminalOnly} or j.state not in ('pending','waiting','active'))`.execute(
    tx,
  );
}

/** Feeder hook: preserve the declared per-item options, pins, deadline and retry classification. */
export function libraryManifestIntent(row: {
  libraryIntent: QueueIntent | null;
  libraryParentId: string | null;
  runId: string;
  itemKey: string;
  rootItemKey: string | null;
  libraryExecutionRunId?: string | null;
  libraryExecutionItemKey?: string | null;
  executionRootItemKey?: string | null;
}): QueueIntent | undefined {
  return row.libraryIntent
    ? {
        ...row.libraryIntent,
        runId: row.libraryExecutionRunId ?? row.runId,
        itemKey: row.libraryExecutionItemKey ?? row.itemKey,
        rootItemKey: row.libraryExecutionRunId ? (row.executionRootItemKey ?? row.rootItemKey) : row.rootItemKey,
        parentId: row.libraryParentId ?? undefined,
      }
    : undefined;
}

/** The indexed dirty candidate page precedes all owner eligibility probes. Its monotonic
 * ceiling is fixed for one pass; later arrivals cannot postpone revisiting an earlier owner.
 */
export const libraryRedactionCandidates = (
  queue: string | undefined,
  after: RawBuilder<unknown>,
  through: RawBuilder<unknown>,
) => sql`
  select i."runId",i."itemKey",i.stage,i."libraryCleanupId" from job_run_item i
    where i."jobId" is null and i."libraryIntent"->>'sensitive'='true'
      and (i."libraryIntent" ? 'options' or i."libraryIntent"->'data' != '{}'::jsonb)
      ${queue === undefined ? sql`` : sql`and i.queue=${queue}`}
      and i."libraryCleanupId">${after} and i."libraryCleanupId"<=${through}
    order by i."libraryCleanupId" limit ${QUEUE_BATCH}`;

/** Header cancellation is immediate. One ordinary queue visit advances at most 250 dirty
 * identities even if every owner is still live. Only that locked page is tested/redacted.
 */
export const libraryRedactionPage = (queue?: string) => {
  const key = queue === undefined ? 'frameleaf-library-redact-all' : `frameleaf-library-redact/${queue}`;
  return sql<{ redacted: number; visited: number }>`with cursor as materialized (
    select coalesce((select (value->>'after')::bigint from system_metadata where key=${key}),0) after,
      (select (value->>'through')::bigint from system_metadata where key=${key}) through
  ), boundary as materialized (
    select coalesce(cursor.through,(select i."libraryCleanupId" from job_run_item i
      where i."jobId" is null and i."libraryIntent"->>'sensitive'='true'
        and (i."libraryIntent" ? 'options' or i."libraryIntent"->'data' != '{}'::jsonb)
      ${queue === undefined ? sql`` : sql`and i.queue=${queue}`}
      order by i."libraryCleanupId" desc limit 1),0) through from cursor
  ), candidates as materialized (
    ${libraryRedactionCandidates(queue, sql`(select after from cursor)`, sql`(select through from boundary)`)}
  ), locked as materialized (
    select i.* from candidates c cross join lateral (select owner.* from job_run_item owner
      where (owner."runId",owner."itemKey",owner.stage)=(c."runId",c."itemKey",c.stage) limit 1 for update of owner) i
  ), eligible as materialized (
    select i."runId",i."itemKey",i.stage from locked i left join job_selection s on s.id=i."selectionId"
      where i."jobId" is null and i."libraryIntent"->>'sensitive'='true'
        and (i."libraryIntent" ? 'options' or i."libraryIntent"->'data' != '{}'::jsonb)
        and (s.state in ('cancelled','needs_attention') or i.state not in ('pending','waiting','active')
          or (i."libraryExecutionRunId" is not null and (i."libraryExecutionRunId",i."libraryExecutionItemKey")!=(i."runId",i."itemKey")
            and (${libraryCanonicalState('i')}) not in ('pending','waiting','active')))
  ), redacted as (
    update job_run_item i set selection='{}'::jsonb,
      "libraryIntent"=i."libraryIntent" - 'options' || jsonb_build_object('data','{}'::jsonb)
      from eligible p where (i."runId",i."itemKey",i.stage)=(p."runId",p."itemKey",p.stage) returning 1
  ), advanced as (
    insert into system_metadata(key,value) select ${key},case when count(*)=${QUEUE_BATCH}
        and max("libraryCleanupId")<(select through from boundary)
      then jsonb_build_object('after',max("libraryCleanupId")::text,'through',(select through from boundary)::text)
      else '{}'::jsonb end from candidates
      on conflict(key) do update set value=excluded.value returning 1
  ) select (select count(*)::int from redacted) redacted,count(*)::int visited from candidates
    where (select count(*) from advanced)>=0`;
};

/** Advance the privacy cursor without treating a no-redaction visit as queue progress. */
export async function redactLibrarySourcePage(tx: Kysely<any> | Transaction<any>, queue?: string) {
  const { rows } = await libraryRedactionPage(queue).execute(tx);
  if (rows[0].redacted > 0) await sql`select pg_notify('frameleaf_jobs','')`.execute(tx);
  return rows[0].redacted > 0;
}
