import { Kysely, SelectQueryBuilder, Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName } from 'src/enum.js';
import { selectionLineageSource } from 'src/queue/selection-lineage.js';
import { unfinishedRunItems } from 'src/queue/selection-state.js';
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
) {
  context?.signal.throwIfAborted();
  const claim = context?.claim;
  const attach = async (tx: Transaction<any>) => {
    // This short phase follows publication's catalogue -> job -> run lock order.
    await sql`insert into job_queue(name) values (${intent.queue}) on conflict do nothing`.execute(tx);
    if (claim) await sql`select name from job_queue order by name for no key update`.execute(tx);
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
      state = case when state = 'cancelled' then state else ${claim ? 'enumerating' : 'ready'} end
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
        // with capture, still without queue, producer or existing run row locks.
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
    ${after === null ? sql`` : sql`and "itemKey" > ${after}`} order by "itemKey" limit ${QUEUE_BATCH}`;

/** The producer job is locked by the caller. This check never reads its selected media rows. */
export async function assertSelectionsShared(tx: Executor, producerId: string) {
  const { rows } = await sql`select 1 from job_selection_run membership
    join job_selection snapshot on snapshot.id = membership."selectionId"
    where snapshot."producerId" = ${producerId}::uuid and snapshot."capturedAt" is not null
      and not membership."copyComplete" limit 1`.execute(tx);
  if (rows.length > 0) throw new SelectionSharingRequired(producerId);
}

/** Each call copies at most one page. Outcome mirroring and publication share the same short guard. */
export async function shareSelectionPage(db: Executor, filter: { producerId: string } | { queue: string }) {
  const copy = async (tx: Executor) => {
    await sql`select name from job_queue order by name for no key update`.execute(tx);
    const {
      rows: [membership],
    } = await sql<{
      runId: string;
      selectionId: string;
      sourceRunId: string;
      producerId: string | null;
      copyAfter: string | null;
      lineageAfter: string;
    }>`
      select m."runId", m."selectionId", s."runId" "sourceRunId", s."producerId", m."copyAfter", m."lineageAfter"
      from job_selection_run m join job_selection s on s.id = m."selectionId"
      where not m."copyComplete" and s."capturedAt" is not null
        and ${'producerId' in filter ? sql`s."producerId" = ${filter.producerId}::uuid` : sql`s.queue = ${filter.queue}`}
      order by m."selectionId", m."runId" limit 1 for update of m`.execute(tx);
    if (!membership) return false;
    const {
      rows: [page],
    } = await sql<{ after: string | null; size: number }>`with page as materialized (
      ${selectionCopySource(membership.sourceRunId, membership.selectionId, membership.copyAfter)}
    ), copied as (
      insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "jobId", state, "selectionId")
      select ${membership.runId}::uuid, "itemKey", "rootItemKey", stage, queue, selection, "jobId", state, "selectionId"
      from page on conflict do nothing returning 1
    ) select max("itemKey") "after", count(*)::int size from page where (select count(*) from copied) >= 0`.execute(tx);
    // A child's key may sort before the frozen-root cursor. Its separately sequenced origin is
    // appended under this same publication guard, including while root copying is incomplete.
    const remaining = QUEUE_BATCH - page.size;
    const history =
      remaining > 0
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
    const complete = !!history && history.size < remaining;
    await sql`update job_selection_run set "copyAfter" = coalesce(${page.after}, "copyAfter"),
      "lineageAfter" = coalesce(${history?.after ?? null}::bigint, "lineageAfter"), "copyComplete" = ${complete}
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
          and i.state in ('pending','waiting','active'))
        and not exists (select 1 from job_selection_run m join job_selection s on s.id = m."selectionId"
          where m."runId" = r.id and (not m."copyComplete" or s.state = 'enumerating'))`.execute(tx);
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
  await sql`update job_run r set "enumerationDone" = not exists (
      select 1 from job_selection_run m where m."runId" = r.id and not m."copyComplete") where r.id in
    (select "runId" from job_run_item where "jobId" = ${producerId}::uuid and "rootItemKey" is null)
    and not exists(select 1 from job_run_item i where i."runId" = r.id and i."rootItemKey" is null
      and i.state in ('pending','waiting','active'))`.execute(tx);
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
    };
    const rows: ManifestItem[] = [];
    let afterSelection: string | undefined;
    // Select a snapshot before reading its items. LIMIT then uses the pending source index,
    // instead of sorting every remaining item across a large manifest. Visits are bounded too.
    for (let visited = 0; visited < capacity && rows.length < capacity; visited++) {
      const {
        rows: [selection],
      } = await sql<{ id: string; runId: string }>`
        select s.id, s."runId" from job_selection s
        where s.queue = ${queue} and s.state = 'ready'
          ${afterSelection ? sql`and (s."createdAt", s.id) > (select "createdAt", id from job_selection where id = ${afterSelection}::uuid)` : sql``}
          and exists (select 1 from job_run_item i where i."selectionId" = s.id and i."runId" = s."runId"
            and i."jobId" is null and i.state = 'pending')
        order by s."createdAt", s.id limit 1`.execute(tx);
      if (!selection) break;
      const { rows: page } = await sql<ManifestItem>`
        select i.*, s."safeToRetry", s.sensitive, s."deadlineMs" from job_run_item i
        join job_selection s on s.id = i."selectionId"
        where i."selectionId" = ${selection.id}::uuid and i."runId" = ${selection.runId}::uuid
          and i."jobId" is null and i.state = 'pending'
        order by i."itemKey" limit ${capacity - rows.length} for update of i skip locked`.execute(tx);
      rows.push(...page);
      afterSelection = selection.id;
    }
    await enqueue(
      rows.map((row) => ({
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
      })),
      tx,
    );
    // Admission owns deduplication and links each source membership. Mirror that
    // linkage to shared producer runs, including an already-active execution.
    await sql`update job_run_item i set "jobId" = source."jobId", state = j.state
      from job_run_item source join job j on j.id = source."jobId"
      where (source."runId", source."itemKey", source.stage) in (
        select * from unnest(${rows.map((row) => row.runId)}::uuid[], ${rows.map((row) => row.itemKey)}::text[], ${rows.map((row) => row.stage)}::text[])
      ) and source.state != 'cancelled'
        and i."selectionId" = source."selectionId" and i."itemKey" = source."itemKey" and i.stage = source.stage
        and i.state != 'cancelled'`.execute(tx);
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
