import { Kysely, RawBuilder, SelectQueryBuilder, Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName } from 'src/enum.js';
import {
  attachLibraryParticipants,
  discoverLibraryChildOrigins,
  libraryManifestIntent,
  libraryProducerAttachmentPending,
  redactLibrarySourcePage,
} from 'src/queue/library-admission.js';
import { selectionLineageSource } from 'src/queue/selection-lineage.js';
import {
  libraryFeederEligible,
  libraryMembershipEntitled,
  libraryOwnerState,
  libraryRootEntitled,
  libraryRunPending,
  unfinishedRunItems,
} from 'src/queue/selection-state.js';
import {
  QUEUE_BATCH,
  QUEUE_HIGH_WATER,
  QUEUE_LOW_WATER,
  QueueClaim,
  QueueExecution,
  QueueIntent,
  QueueOptions,
} from 'src/queue/types.js';

type Executor = Kysely<any> | Transaction<any>;

/** Resolve selected-asset identity after the frozen row has supplied its ID. */
export function getManifestJobOptions(name: string, data: Record<string, unknown>): QueueOptions | undefined {
  if (name === JobName.SmartAlbumReevaluate) {
    return { deduplication: { id: `${name}:${data.id}:${data.kind ?? 'all'}` } };
  }
  return undefined;
}

/** Caller holds the queue catalogue lock; this is the single producer-to-run attachment protocol. */
export async function attachProducerRun(tx: Transaction<any>, claim: QueueClaim, submittedRunId?: string) {
  const {
    rows: [owner],
  } = await sql<{ runId: string | null; itemKey: string | null; name: string; queue: string }>`
        select "runId", "itemKey", name, queue from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid
        and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null for update`.execute(
    tx,
  );
  if (!owner) throw new Error('Selection producer lost its claim');
  let runId = owner.runId ?? submittedRunId;
  let producerItemKey = owner.itemKey;
  if (!runId) {
    runId = randomUUID();
    await sql`insert into job_run(id, kind, selection) values (${runId}::uuid, ${owner.name}, '{}'::jsonb)`.execute(tx);
  }
  if (!owner.runId) {
    const itemKey = `producer/${claim.id}`;
    producerItemKey = itemKey;
    await sql`insert into job_run_item("runId", "itemKey", stage, queue, selection, "jobId", state)
          values (${runId}::uuid, ${itemKey}, ${owner.name}, ${owner.queue}, '{}'::jsonb, ${claim.id}::uuid, 'active')
          on conflict do nothing`.execute(tx);
    await sql`update job set "runId" = ${runId}::uuid, "itemKey" = ${itemKey}
          where id = ${claim.id}::uuid`.execute(tx);
  }
  const { rows } = await sql`select id from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid
    and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null`.execute(tx);
  if (rows.length === 0) throw new Error('Selection producer lost its claim');
  return { runId, producerItemKey };
}

/** Attach briefly, then capture one immutable SQL snapshot without holding dispatch/publication locks. */
export async function freezeSelection(
  db: Kysely<any>,
  intent: QueueIntent,
  selection: SelectQueryBuilder<any, any, { id: string }>,
  context?: QueueExecution,
  submittedRunId?: string,
  readiness?: RawBuilder<'enumerating' | 'ready'>,
) {
  context?.signal.throwIfAborted();
  const claim = context?.claim;
  const attach = async (tx: Transaction<any>) => {
    // This short phase follows publication's catalogue -> job -> run lock order.
    await sql`insert into job_queue(name) values (${intent.queue}) on conflict do nothing`.execute(tx);
    if (claim) await sql`select name from job_queue order by name for no key update`.execute(tx);
    if (readiness && submittedRunId) {
      // Take the setup gate before inserting selection foreign keys or touching existing headers.
      await sql`select id from job_run where id = ${submittedRunId}::uuid for update`.execute(tx);
    }
    let runId = submittedRunId;
    let producerItemKey = context?.claim.itemKey;
    if (claim) {
      ({ runId, producerItemKey } = await attachProducerRun(tx, claim, submittedRunId));
    }
    if (!runId) {
      runId = randomUUID();
      await sql`insert into job_run(id, kind, selection) values (${runId}::uuid, ${intent.name}, '{}'::jsonb)`.execute(
        tx,
      );
    }
    const {
      rows: [existing],
    } = await sql<{ id: string }>`select id from job_selection
      where "runId" = ${runId}::uuid and stage = ${intent.name}`.execute(tx);
    let selectionId = existing?.id ?? randomUUID();
    if (!existing) {
      await sql`insert into job_selection(id, "runId", "producerId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state)
        values (${selectionId}::uuid, ${runId}::uuid, ${claim?.id ?? null}::uuid, ${intent.name}, ${intent.queue},
          ${intent.safeToRetry}, ${intent.sensitive}, ${intent.deadlineMs}, 'enumerating') on conflict do nothing`.execute(
        tx,
      );
      const {
        rows: [attached],
      } = await sql<{ id: string }>`select id from job_selection
        where "runId" = ${runId}::uuid and stage = ${intent.name}`.execute(tx);
      selectionId = attached.id;
    }
    await sql`insert into job_selection_run("runId", "selectionId", "copyComplete") values (${runId}::uuid, ${selectionId}::uuid, true)
      on conflict do nothing`.execute(tx);
    if (claim) await attachSelectionMemberships(tx, claim.id);
    return { runId, producerItemKey, selectionId };
  };
  const capture = async (tx: Transaction<any>, result: Awaited<ReturnType<typeof attach>>) => {
    if (readiness) {
      // Setup release uses this same run -> selection order. Read the committed gate only after
      // locking its run, so a concurrent release cannot be overwritten by an older capture view.
      await sql`select id from job_run where id = ${result.runId}::uuid for update`.execute(tx);
    }
    // Only competing captures of this identity wait. Never take a selection row lock before
    // the final producer fence: failure/publication holds the producer before the selection.
    await sql`select pg_advisory_xact_lock(hashtextextended('frameleaf-selection:' || ${result.selectionId}, 0))`.execute(
      tx,
    );
    const {
      rows: [snapshot],
    } = await sql<{ capturedAt: Date | null }>`select "capturedAt" from job_selection
      where id = ${result.selectionId}::uuid`.execute(tx);
    if (!snapshot.capturedAt) {
      context?.signal.throwIfAborted();
      await sql`insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "selectionId")
        select ${result.runId}::uuid, selected.id::text, coalesce(to_jsonb(selected)->>'rootItemKey', selected.id::text), ${intent.name}, ${intent.queue},
          ${JSON.stringify(intent.data)}::text::jsonb || coalesce(to_jsonb(selected)->'data', '{}'::jsonb) || jsonb_build_object('id', selected.id), ${result.selectionId}::uuid
        from (${selection}) selected on conflict do nothing`.execute(tx);
    }
    context?.signal.throwIfAborted();
    if (claim) {
      const { rows } = await sql`select id from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid
        and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null for no key update`.execute(
        tx,
      );
      if (rows.length === 0) throw new Error('Selection producer lost its claim');
    }
    if (!snapshot.capturedAt) {
      await sql`update job_selection_run set "copyComplete" = ("runId" = ${result.runId}::uuid), "copyAfter" = null
        where "selectionId" = ${result.selectionId}::uuid`.execute(tx);
    }
    // Rows and marker commit together, including zero rows. A crash can never turn a committed
    // empty or partial snapshot into permission to append IDs from a changed live selection.
    await sql`update job_selection set "capturedAt" = coalesce("capturedAt", clock_timestamp()),
      state = case when state = 'cancelled' or (${!!readiness} and state = 'needs_attention') then state
        else ${claim ? sql.lit('enumerating') : (readiness ?? sql.lit('ready'))} end
      where id = ${result.selectionId}::uuid`.execute(tx);
    if (claim) {
      // This run owns the source rows, so sharing them with itself requires no scan or copy.
      await sql`update job_run_item set "selectionVersion" = (select count(*) from job_selection
        where "producerId" = ${claim.id}::uuid and "capturedAt" is not null)
        where "jobId" = ${claim.id}::uuid and "rootItemKey" is null and "runId" = ${result.runId}::uuid`.execute(tx);
    }
    if (!claim && !submittedRunId) {
      await sql`update job_run set "enumerationDone" = true where id = ${result.runId}::uuid`.execute(tx);
    }
  };
  const result = claim
    ? await db.transaction().execute(attach)
    : await db.transaction().execute(async (tx) => {
        // A direct selection has no durable producer to retry it. Keep its new run/header atomic
        // with capture. A supplied setup gate additionally serializes on its existing run.
        const attached = await attach(tx);
        await capture(tx, attached);
        return attached;
      });
  if (context) {
    // Attachment survives interruption of the later capture transaction.
    context.claim.runId = result.runId;
    context.claim.itemKey = result.producerItemKey ?? null;
    await db.transaction().execute((tx) => capture(tx, result));
    // Eager preparation yields publication locks and its connection after every bounded page.
    // The final publication check still detects later attachments.
    await shareSelections(db, claim!.id);
  }
  if (context) {
    context.progress(++context.progressUnits);
  }
  return result.runId;
}

class SelectionSharingRequired extends Error {
  constructor(readonly producerId: string) {
    super('Producer snapshots require sharing before publication');
  }
}

export type QueuePublication = <T>(action: () => Promise<T>) => Promise<T>;

/** A newly attached run restarts only the short transaction, releasing local and SQL publication gates first. */
export async function withSelectionSharing<T>(
  db: Kysely<any>,
  work: (tx: Transaction<any>) => Promise<T>,
  publication: QueuePublication = (action) => action(),
): Promise<T> {
  for (;;) {
    try {
      return await publication(() => db.transaction().execute(work));
    } catch (error) {
      if (!(error instanceof SelectionSharingRequired)) throw error;
      await shareSelections(db, error.producerId);
    }
  }
}

/** Caller holds the producer's queue guard. Only headers are attached, never selected rows. */
export async function attachSelectionMemberships(tx: Executor, producerId: string) {
  await attachLibraryParticipants(tx, { producerId });
  await sql`with attached as (insert into job_selection_run("runId", "selectionId", "copyComplete")
    select membership."runId", snapshot.id, membership."runId" = snapshot."runId"
    from job_selection snapshot join job_run_item membership on membership."jobId" = snapshot."producerId"
      and membership."rootItemKey" is null
    where snapshot."producerId" = ${producerId}::uuid on conflict do nothing returning "runId")
    update job_run set "enumerationDone" = false, "finishedAt" = null where id in (select "runId" from attached)`.execute(
    tx,
  );
}

/** The immutable source identity uses a keyset, including after its execution outcomes become terminal. */
export const selectionCopySource = (runId: string, selectionId: string, after: string | null) => sql`
  select * from job_run_item where "selectionId" = ${selectionId}::uuid and "runId" = ${runId}::uuid
    ${after === null ? sql`` : sql`and "itemKey" > ${after}`}
    and not exists (select 1 from job_run_item unproven where unproven."selectionId" = ${selectionId}::uuid
      and unproven."runId" = ${runId}::uuid and unproven."libraryIntent" is not null and not unproven."libraryOriginComplete"
      and unproven."itemKey" <= job_run_item."itemKey")
    order by "itemKey" limit ${QUEUE_BATCH}`;

/** The producer job is locked by the caller. This check never reads its selected media rows. */
export async function assertSelectionsShared(tx: Executor, producerId: string) {
  const { rows } = await sql`select 1 from job_selection_run membership
    join job_selection snapshot on snapshot.id = membership."selectionId"
    where snapshot."producerId" = ${producerId}::uuid and snapshot."capturedAt" is not null
      and not membership."copyComplete" limit 1`.execute(tx);
  const { rows: libraryPending } = await sql`select 1 where ${libraryProducerAttachmentPending(producerId)}`.execute(
    tx,
  );
  if (rows.length > 0 || libraryPending.length > 0) throw new SelectionSharingRequired(producerId);
}

/** Each call copies at most one page. Outcome mirroring and publication share the same short guard. */
export async function shareSelectionPage(db: Executor, filter: { producerId: string } | { queue: string }) {
  const copy = async (tx: Executor) => {
    await sql`select name from job_queue order by name for no key update`.execute(tx);
    if ('queue' in filter && (await redactLibrarySourcePage(tx, filter.queue))) return true;
    if (await discoverLibraryChildOrigins(tx, filter)) return true;
    if (await attachLibraryParticipants(tx, filter)) return true;
    // Retire cancelled origin acknowledgements one mapping at a time, even while the source is
    // open. Their execution ownership stays canonical; no future child entitlement is created.
    const { rows: retired } = await sql<{ runId: string }>`with candidate as (
      select m."runId", m."selectionId", s."appendSequence" from job_selection_run m
        join job_selection s on s.id = m."selectionId"
      where s."sourceKind" != 'frozen' and not m."copyComplete"
        and not (${libraryMembershipEntitled(sql<string>`m."runId"`, sql<string>`s."libraryOperationId"`)})
        and ${'producerId' in filter ? sql`exists (select 1 from job_library_source_producer link where link."selectionId" = s."libraryOperationId" and link."producerId" = ${filter.producerId}::uuid)` : sql`s.queue = ${filter.queue}`}
      order by m."selectionId", m."runId" limit 1 for update of m
    ) update job_selection_run m set "copyComplete" = true, "libraryVersion" = c."appendSequence"
      from candidate c where m."runId" = c."runId" and m."selectionId" = c."selectionId" returning m."runId"`.execute(
      tx,
    );
    if (retired.length > 0) {
      await sql`update job_run r set "enumerationDone" = true where r.id = ${retired[0].runId}::uuid
        and not (${unfinishedRunItems(sql<string>`r.id`)})`.execute(tx);
      return true;
    }

    const {
      rows: [membership],
    } = await sql<{
      runId: string;
      selectionId: string;
      sourceRunId: string;
      producerId: string | null;
      copyAfter: string | null;
      lineageAfter: string;
      appendSequence: string;
      sourceKind: string;
    }>`
      select m."runId", m."selectionId", s."runId" "sourceRunId", s."producerId", m."copyAfter", m."lineageAfter", s."appendSequence", s."sourceKind"
      from job_selection_run m join job_selection s on s.id = m."selectionId"
      where (not m."copyComplete" or (m."runId" != s."runId" and m."libraryVersion" < s."appendSequence"))
        and (s."sourceKind" = 'frozen' or (${libraryMembershipEntitled(sql<string>`m."runId"`, sql<string>`s."libraryOperationId"`)}))
        and s."capturedAt" is not null and (s."sourceKind" = 'frozen' or s."sourceClosedAt" is not null)
        and ${
          'producerId' in filter
            ? sql`(s."producerId" = ${filter.producerId}::uuid or exists (select 1 from job_library_source_producer link where link."producerId" = ${filter.producerId}::uuid and link."selectionId" = s."libraryOperationId")
          or exists (select 1 from job_selection_lineage origin join job_run_item i on (i."runId",i."itemKey",i.stage)=(origin."runId",origin."itemKey",origin.stage)
            join job_selection original on original.id=origin."selectionId" where i."selectionId"=s.id and not origin.superseded
              and coalesce(original."libraryFrozenProducerId",original."producerId")=${filter.producerId}::uuid))`
            : sql`s.queue = ${filter.queue}`
        }
      order by m."selectionId", m."runId" limit 1 for update of m`.execute(tx);
    if (!membership) {
      // Linked library aliases read the canonical executor outcome. Settle their retained run
      // headers in ordinary bounded visits, rather than updating every alias on job completion.
      if ('queue' in filter) await settleLibraryRunPage(tx, filter.queue);
      return false;
    }
    const {
      rows: [page],
    } = await sql<{ after: string | null; size: number }>`with page as materialized (
      ${selectionCopySource(membership.sourceRunId, membership.selectionId, membership.copyAfter)}
    ), copied as (
      insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "jobId", state, "selectionId")
      select ${membership.runId}::uuid, "itemKey", "rootItemKey", stage, queue, selection, "jobId", state, "selectionId"
      from page where ${membership.sourceKind === 'frozen' ? sql`true` : libraryRootEntitled(sql<string>`${membership.runId}::uuid`, sql<string>`${membership.sourceRunId}::uuid`, sql<string>`page."rootItemKey"`, { selectionId: sql<string>`${membership.selectionId}::uuid`, itemKey: sql<string>`page."itemKey"`, stage: sql<string>`page.stage` })}
      on conflict do nothing returning 1
    ) select max("itemKey") "after", count(*)::int size from page where (select count(*) from copied) >= 0`.execute(tx);
    // A child's key may sort before the frozen-root cursor. Its separately sequenced origin is
    // appended under this same publication guard, including while root copying is incomplete.
    const remaining = QUEUE_BATCH - page.size;
    const history =
      remaining > 0 && membership.sourceKind === 'frozen'
        ? (
            await sql<{ after: string | null; size: number }>`with page as materialized (
      ${selectionLineageSource(membership.selectionId, membership.lineageAfter, remaining)}
    ), copied as (
      insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "jobId", state, "selectionId")
      select ${membership.runId}::uuid, "itemKey", "rootItemKey", stage, queue, selection, "jobId", state, "selectionId"
      from page on conflict do nothing returning 1
    ) select max("lineageId")::text "after", count(*)::int size from page where (select count(*) from copied) >= 0`.execute(
              tx,
            )
          ).rows[0]
        : undefined;
    const { rows: unproven } =
      await sql`select 1 from job_run_item where "selectionId" = ${membership.selectionId}::uuid
      and "runId" = ${membership.sourceRunId}::uuid and "libraryIntent" is not null and not "libraryOriginComplete" limit 1`.execute(
        tx,
      );
    const complete =
      membership.sourceKind === 'frozen'
        ? !!history && history.size < remaining
        : page.size < QUEUE_BATCH && unproven.length === 0;
    await sql`update job_selection_run set "copyAfter" = coalesce(${page.after}, "copyAfter"),
      "lineageAfter" = coalesce(${history?.after ?? null}::bigint, "lineageAfter"), "copyComplete" = ${complete},
      "libraryVersion" = case when ${complete} then ${membership.appendSequence}::bigint else "libraryVersion" end
      where "selectionId" = ${membership.selectionId}::uuid and "runId" = ${membership.runId}::uuid`.execute(tx);
    if (complete) {
      await sql`update job_run_item i set "selectionVersion" = (select count(*) from job_selection
        where "producerId" = ${membership.producerId}::uuid and "capturedAt" is not null)
        where i."runId" = ${membership.runId}::uuid and i."jobId" = ${membership.producerId}::uuid
          and i."rootItemKey" is null and not exists (
            select 1 from job_selection_run m join job_selection s on s.id = m."selectionId"
              where m."runId" = i."runId" and s."producerId" = i."jobId" and not m."copyComplete")`.execute(tx);
      await sql`update job_run r set "enumerationDone" = true where r.id = ${membership.runId}::uuid
        and not exists (select 1 from job_run_item i where i."runId" = r.id and i."rootItemKey" is null
          and i.state in ('pending','waiting','active')
          and not exists (select 1 from job_library_source_producer link join job j on j.id = link."producerId"
            where link."producerId" = i."jobId" and j.state not in ('pending','waiting','active')))
        and not exists (select 1 from job_selection_run m join job_selection s on s.id = m."selectionId"
          where m."runId" = r.id and (not m."copyComplete" or s.state = 'enumerating'))
        and not (${libraryRunPending(sql<string>`r.id`)})`.execute(tx);
      await sql`update job_run r set "finishedAt" = now() where r.id = ${membership.runId}::uuid
        and r."enumerationDone" and r."finishedAt" is null and not (${unfinishedRunItems(sql<string>`r.id`)})`.execute(
        tx,
      );
    }
    // One notification requests the next ordinary coordinator visit; there is no drain loop on its control client.
    await sql`select pg_notify('frameleaf_jobs', '')`.execute(tx);
    return true;
  };
  return db.isTransaction ? copy(db) : db.transaction().execute(copy);
}

/** One queue visit probes at most 250 associated run headers. A durable cursor revisits live
 * prefixes after a pass, so unfinished aliases cannot starve later completed participants.
 */
async function settleLibraryRunPage(tx: Executor, queue: string) {
  const key = `frameleaf-library-settle/${queue}`;
  await sql`with cursor as (
    select (value->>'after')::uuid after from system_metadata where key=${key}
  ), candidates as materialized (
    select distinct m."runId" from job_selection_run m join job_selection s on s.id=m."selectionId"
      where s.queue=${queue} and (s."sourceKind"!='frozen' or s."librarySharesExecution")
        and ((select after from cursor) is null or m."runId">(select after from cursor))
      order by m."runId" limit ${QUEUE_BATCH}
  ), settled as (
    update job_run r set "enumerationDone"=true,"finishedAt"=coalesce(r."finishedAt",now())
      where r.id in (select "runId" from candidates) and r."finishedAt" is null
        and not (${unfinishedRunItems(sql<string>`r.id`)}) returning id
  ) insert into system_metadata(key,value) select ${key},case when count(*)=${QUEUE_BATCH}
      then jsonb_build_object('after',max("runId"::text)) else '{}'::jsonb end from candidates
      where (select count(*) from settled)>=0
    on conflict(key) do update set value=excluded.value`.execute(tx);
}

/** Handler preparation may drain captured pages, yielding the SQL/publication guard after each page. */
export async function shareSelections(db: Executor, producerId: string) {
  while (await shareSelectionPage(db, { producerId })) {
    // Work and acquisition are bounded by the handler's existing execution signal.
  }
}

export async function finishSelections(tx: Executor, producerId: string, succeeded: boolean) {
  if (succeeded) {
    await assertSelectionsShared(tx, producerId);
    const { rows } = await sql`select 1 from job_selection where "producerId" = ${producerId}::uuid
      and "capturedAt" is null limit 1`.execute(tx);
    if (rows.length > 0) throw new Error('Producer selection capture is incomplete');
  }
  await sql`update job_selection set state = case when state = 'cancelled' then state else ${succeeded ? 'ready' : 'needs_attention'} end
    where "producerId" = ${producerId}::uuid`.execute(tx);
  // An uncaptured snapshot has no committed rows; the fenced terminal producer cannot append them later.
  if (!succeeded)
    await sql`update job_selection_run m set "copyComplete" = true from job_selection s
    where m."selectionId" = s.id and s."producerId" = ${producerId}::uuid and s."capturedAt" is null`.execute(tx);
  // Ordinary selected media cannot change enumeration. A bounded existence proof avoids
  // planning the recursive library predicate; eligible coordinators retain the full update.
  const { rows: coordinators } = await sql`select 1 from job_run_item i join job j on j.id = i."jobId"
    where i."jobId" = ${producerId}::uuid and i."rootItemKey" is null
      and (i."runId" = j."runId" or not exists (select 1 from job_library_source_producer link where link."producerId" = j.id))
    limit 1`.execute(tx);
  if (coordinators.length === 0) return;
  await sql`update job_run r set "enumerationDone" = not exists (
      select 1 from job_selection_run m where m."runId" = r.id and not m."copyComplete")
      and not (${libraryRunPending(sql<string>`r.id`)}) where r.id in
    (select i."runId" from job_run_item i join job j on j.id = i."jobId"
      where i."jobId" = ${producerId}::uuid and i."rootItemKey" is null
        and (i."runId" = j."runId" or not exists (select 1 from job_library_source_producer link where link."producerId" = j.id)))
    and not exists(select 1 from job_run_item i where i."runId" = r.id and i."rootItemKey" is null
      and i.state in ('pending','waiting','active')
          and not exists (select 1 from job_library_source_producer link join job j on j.id = link."producerId"
            where link."producerId" = i."jobId" and j.state not in ('pending','waiting','active')))`.execute(tx);
}

export async function resumeSelections(tx: Executor, producerId: string) {
  await sql`update job_selection set state = 'enumerating' where "producerId" = ${producerId}::uuid and state != 'cancelled'`.execute(
    tx,
  );
  await sql`update job_run set "finishedAt" = null, "enumerationDone" = false where id in
    (select "runId" from job_run_item where "jobId" = ${producerId}::uuid)
    and exists(select 1 from job_selection where "producerId" = ${producerId}::uuid)`.execute(tx);
}

/** One coordinator visit admits at most 250 executions and releases its connection immediately. */
export async function feedManifest(
  db: Kysely<any>,
  queue: string,
  enqueue: (intents: QueueIntent[], tx: Transaction<any>) => Promise<void>,
) {
  return db.transaction().execute(async (tx) => {
    const {
      rows: [config],
    } = await sql<{ paused: boolean; manifestFilling: boolean }>`select paused, "manifestFilling"
      from job_queue where name = ${queue} for no key update skip locked`.execute(tx);
    if (!config || config.paused) return 0;
    const {
      rows: [counts],
    } = await sql<{ count: number }>`select count(*)::int count from job
      where queue = ${queue} and state in ('pending','waiting','active')`.execute(tx);
    const filling = config.manifestFilling || counts.count <= QUEUE_LOW_WATER;
    const capacity = filling ? Math.min(QUEUE_BATCH, QUEUE_HIGH_WATER - counts.count) : 0;
    if (capacity <= 0) {
      await sql`update job_queue set "manifestFilling" = false where name = ${queue}`.execute(tx);
      return 0;
    }
    type ManifestItem = {
      runId: string;
      itemKey: string;
      rootItemKey: string | null;
      stage: string;
      queue: string;
      selection: Record<string, unknown>;
      selectionId: string;
      safeToRetry: boolean;
      sensitive: boolean;
      deadlineMs: number;
      libraryIntent: QueueIntent | null;
      libraryParentId: string | null;
      libraryExecutionRunId: string | null;
      libraryExecutionItemKey: string | null;
      executionRootItemKey: string | null;
    };
    const rows: ManifestItem[] = [];
    let afterSelection: string | undefined;
    // Select a snapshot before reading its items. LIMIT then uses the pending source index,
    // instead of sorting every remaining item across a large manifest. Visits are bounded too.
    for (let visited = 0; visited < capacity && rows.length < capacity; visited++) {
      const {
        rows: [selection],
      } = await sql<{ id: string; runId: string; sourceKind: string }>`
        select s.id, s."runId", s."sourceKind" from job_selection s
        where s.queue = ${queue} and s.state = 'ready'
          and (s."sourceKind" = 'frozen' or (s."sourceClosedAt" is not null and s."capturedAt" is not null))
          ${afterSelection ? sql`and (s."createdAt", s.id) > (select "createdAt", id from job_selection where id = ${afterSelection}::uuid)` : sql``}
          and ((s."sourceKind"='frozen' and exists (select 1 from job_run_item i where i."selectionId"=s.id and i."runId"=s."runId"
            and i."jobId" is null and i.state='pending'))
            or (s."sourceKind"!='frozen' and exists (select 1 from job_run_item i where i."selectionId"=s.id and i."runId"=s."runId"
              and i."jobId" is null and i.state='pending' and i."libraryIntent" is not null and i."libraryOriginComplete" and (${libraryFeederEligible('i')}))))
        order by s."createdAt", s.id limit 1`.execute(tx);
      if (!selection) break;
      const { rows: page } = await sql<ManifestItem>`
        select i.*, s."safeToRetry", s.sensitive, s."deadlineMs", owner."rootItemKey" "executionRootItemKey" from job_run_item i
        join job_selection s on s.id = i."selectionId"
        left join job_run_item owner on (owner."runId",owner."itemKey",owner.stage)=(i."libraryExecutionRunId",i."libraryExecutionItemKey",i.stage)
        where i."selectionId" = ${selection.id}::uuid and i."runId" = ${selection.runId}::uuid
          and i."jobId" is null and i.state = 'pending'
          ${selection.sourceKind === 'frozen' ? sql`` : sql`and i."libraryIntent" is not null and i."libraryOriginComplete" and (${libraryFeederEligible('i')})`}
        order by i."itemKey" limit ${capacity - rows.length} for update of i skip locked`.execute(tx);
      rows.push(...page);
      afterSelection = selection.id;
    }
    if (rows.length === 0) {
      if (config.manifestFilling) {
        await sql`update job_queue set "manifestFilling" = false where name = ${queue}`.execute(tx);
      }
      return 0;
    }
    await enqueue(
      rows
        .filter(
          (row) =>
            !row.libraryExecutionRunId ||
            (row.libraryExecutionRunId === row.runId && row.libraryExecutionItemKey === row.itemKey),
        )
        .map(
          (row) =>
            libraryManifestIntent(row) ?? {
              queue: row.queue,
              name: row.stage,
              data: row.selection,
              options: getManifestJobOptions(row.stage, row.selection),
              safeToRetry: row.safeToRetry,
              sensitive: row.sensitive,
              deadlineMs: row.deadlineMs,
              runId: row.runId,
              itemKey: row.itemKey,
              rootItemKey: row.rootItemKey,
            },
        ),
      tx,
    );
    // Shared physical ownership is a retained manifest tuple, not a synthetic handler dedup key.
    // Link/settle only this bounded canonical page; secondary sources never enqueue its owner again.
    await sql`update job_run_item i set "jobId"=owner."jobId",state=${libraryOwnerState('owner', 'owner_source', 'j')}
      from job_run_item owner left join job j on j.id=owner."jobId"
      left join job_selection owner_source on owner_source.id=owner."selectionId"
      where (i."runId",i."itemKey",i.stage) in (select * from unnest(${rows.map((row) => row.runId)}::uuid[],${rows.map((row) => row.itemKey)}::text[],${rows.map((row) => row.stage)}::text[]))
        and (owner."runId",owner."itemKey",owner.stage)=(coalesce(i."libraryExecutionRunId",i."runId"),coalesce(i."libraryExecutionItemKey",i."itemKey"),i.stage)
        and i.state!='cancelled'`.execute(tx);
    // Admission owns deduplication and links each source membership. Mirror that
    // linkage to shared producer runs, including an already-active execution.
    await sql`update job_run_item i set "jobId" = source."jobId", state = j.state
      from job_run_item source join job j on j.id = source."jobId"
      where (source."runId", source."itemKey", source.stage) in (
        select * from unnest(${rows.map((row) => row.runId)}::uuid[], ${rows.map((row) => row.itemKey)}::text[], ${rows.map((row) => row.stage)}::text[])
      ) and source.state != 'cancelled'
        and i."selectionId" = source."selectionId" and i."itemKey" = source."itemKey" and i.stage = source.stage
        and i.state != 'cancelled'
        and not exists (select 1 from job_selection s where s.id = i."selectionId"
          and s."sourceKind" != 'frozen' and i."runId" != s."runId")`.execute(tx);
    const {
      rows: [after],
    } = await sql<{ count: number }>`select count(*)::int count from job
      where queue = ${queue} and state in ('pending','waiting','active')`.execute(tx);
    // Deduplicated rows advance their manifests without consuming execution slots.
    const scheduled = after.count - counts.count;
    await sql`update job_queue set "manifestFilling" = ${rows.length === capacity && after.count < QUEUE_HIGH_WATER}
      where name = ${queue}`.execute(tx);
    return scheduled;
  });
}
