import { Kysely, SelectQueryBuilder, Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  QUEUE_BATCH,
  QUEUE_HIGH_WATER,
  QUEUE_LOW_WATER,
  QueueClaim,
  QueueExecution,
  QueueIntent,
} from 'src/queue/types.js';

type Executor = Kysely<any> | Transaction<any>;

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

/** A snapshot is durable before admission; retry always resolves the same producer/stage identity. */
export async function freezeSelection(
  db: Kysely<any>,
  intent: QueueIntent,
  selection: SelectQueryBuilder<any, any, { id: string }>,
  context?: QueueExecution,
  submittedRunId?: string,
) {
  const result = await db.transaction().execute(async (tx) => {
    // Same catalogue -> job -> manifest lock order as accepted publication and admission.
    await sql`insert into job_queue(name) values (${intent.queue}) on conflict do nothing`.execute(tx);
    await sql`select name from job_queue order by name for update`.execute(tx);
    let runId = submittedRunId;
    let producerItemKey = context?.claim.itemKey;
    const claim = context?.claim;
    if (claim) {
      ({ runId, producerItemKey } = await attachProducerRun(tx, claim, submittedRunId));
    }
    if (!runId) {
      runId = randomUUID();
      await sql`insert into job_run(id, kind, selection) values (${runId}::uuid, ${intent.name}, '{}'::jsonb)`.execute(
        tx,
      );
    }
    await sql`select id from job_run where id = ${runId}::uuid for update`.execute(tx);
    const {
      rows: [existing],
    } = await sql<{ id: string }>`select id from job_selection
      where "runId" = ${runId}::uuid and stage = ${intent.name} for update`.execute(tx);
    if (!existing) {
      const selectionId = randomUUID();
      await sql`insert into job_selection(id, "runId", "producerId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state)
        values (${selectionId}::uuid, ${runId}::uuid, ${claim?.id ?? null}::uuid, ${intent.name}, ${intent.queue},
          ${intent.safeToRetry}, ${intent.sensitive}, ${intent.deadlineMs}, ${claim ? 'enumerating' : 'ready'})`.execute(
        tx,
      );
      await sql`insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "selectionId")
        select ${runId}::uuid, selected.id::text, coalesce(to_jsonb(selected)->>'rootItemKey', selected.id::text), ${intent.name}, ${intent.queue},
          ${JSON.stringify(intent.data)}::jsonb || coalesce(to_jsonb(selected)->'data', '{}'::jsonb) || jsonb_build_object('id', selected.id), ${selectionId}::uuid
        from (${selection}) selected on conflict do nothing`.execute(tx);
    }
    if (claim) {
      const { rows } = await sql`select id from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid
        and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null`.execute(tx);
      if (rows.length === 0) throw new Error('Selection producer lost its claim');
    }
    if (!claim && !submittedRunId) {
      await sql`update job_run set "enumerationDone" = true where id = ${runId}::uuid`.execute(tx);
    }
    return { runId, producerItemKey };
  });
  if (context) {
    // Reflect the persisted linkage in this attempt; recovery reads it directly from job.
    context.claim.runId = result.runId;
    context.claim.itemKey = result.producerItemKey ?? null;
    context.progress(++context.progressUnits);
  }
  return result.runId;
}

/** Called with the producer job locked, also covering runs attached after snapshot materialization. */
export async function shareSelections(tx: Executor, producerId: string) {
  await sql`insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "jobId", state, "selectionId")
    select membership."runId", source."itemKey", source."rootItemKey", source.stage, source.queue,
      source.selection, source."jobId", source.state, source."selectionId"
    from job_selection snapshot join job_run_item source on source."selectionId" = snapshot.id and source."runId" = snapshot."runId"
    join job_run_item membership on membership."jobId" = snapshot."producerId" and membership."rootItemKey" is null
    where snapshot."producerId" = ${producerId}::uuid and membership.state != 'cancelled'
    on conflict do nothing`.execute(tx);
}

export async function finishSelections(tx: Executor, producerId: string, succeeded: boolean) {
  await shareSelections(tx, producerId);
  await sql`update job_selection set state = ${succeeded ? 'ready' : 'needs_attention'}
    where "producerId" = ${producerId}::uuid`.execute(tx);
  if (!succeeded) {
    await sql`update job_run_item set state = 'needs_attention' where "jobId" is null and state = 'pending'
      and "selectionId" in (select id from job_selection where "producerId" = ${producerId}::uuid)`.execute(tx);
  }
  await sql`update job_run r set "enumerationDone" = true where r.id in
    (select "runId" from job_run_item where "jobId" = ${producerId}::uuid and "rootItemKey" is null)
    and not exists(select 1 from job_run_item i where i."runId" = r.id and i."rootItemKey" is null
      and i.state in ('pending','waiting','active'))`.execute(tx);
}

export async function resumeSelections(tx: Executor, producerId: string) {
  await sql`update job_selection set state = 'enumerating' where "producerId" = ${producerId}::uuid`.execute(tx);
  await sql`update job_run_item set state = 'pending' where "jobId" is null and state = 'needs_attention'
    and "selectionId" in (select id from job_selection where "producerId" = ${producerId}::uuid)`.execute(tx);
  await sql`update job_run set "finishedAt" = null, "enumerationDone" = false where id in
    (select "runId" from job_run_item where "jobId" = ${producerId}::uuid)
    and exists(select 1 from job_selection where "producerId" = ${producerId}::uuid)`.execute(tx);
}

/** One coordinator visit admits at most 250 executions and releases its connection immediately. */
export async function feedManifest(db: Kysely<any>, queue: string) {
  return db.transaction().execute(async (tx) => {
    const {
      rows: [config],
    } = await sql<{ paused: boolean; manifestFilling: boolean }>`select paused, "manifestFilling"
      from job_queue where name = ${queue} for update skip locked`.execute(tx);
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
    const { rows } = await sql<{ id: string }>`with selected as materialized (
      select i.*, s."safeToRetry", s.sensitive, s."deadlineMs" from job_run_item i
      join job_selection s on s.id = i."selectionId" and s."runId" = i."runId"
      where s.queue = ${queue} and s.state = 'ready' and i."jobId" is null and i.state = 'pending'
      order by s."createdAt", s.id, i."itemKey" limit ${capacity} for update of i skip locked
    ), added as (
      insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey", "rootItemKey")
      select gen_random_uuid(), queue, stage, selection, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey", "rootItemKey"
      from selected returning id, "runId", "itemKey", name
    ) update job_run_item i set "jobId" = a.id from added a, selected chosen
      where a."runId" = chosen."runId" and a."itemKey" = chosen."itemKey" and a.name = chosen.stage
        and i."selectionId" = chosen."selectionId" and i."itemKey" = chosen."itemKey" and i.stage = chosen.stage
      returning a.id`.execute(tx);
    // Multiple run memberships share one execution slot.
    const scheduled = new Set(rows.map(({ id }) => id)).size;
    await sql`update job_queue set "manifestFilling" = ${scheduled === capacity && counts.count + scheduled < QUEUE_HIGH_WATER}
      where name = ${queue}`.execute(tx);
    return scheduled;
  });
}
