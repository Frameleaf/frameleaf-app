import { Kysely, Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  QUEUE_BATCH,
  QUEUE_HIGH_WATER,
  QUEUE_LOW_WATER,
  QueueClaim,
  QueueIntent,
  QueueState,
} from 'src/queue/types.js';

type Executor = Kysely<any> | Transaction<any>;

/** All methods own short transactions. No connection escapes to a handler or an enumerator. */
export class SqlQueueStore {
  constructor(readonly db: Kysely<any>) {}

  async initialize(queues: string[], workerId?: string) {
    for (const name of queues) {
      await sql`insert into job_queue(name) values (${name}) on conflict do nothing`.execute(this.db);
    }
    if (workerId) {
      await sql`insert into job_worker(id) values (${workerId}::uuid)`.execute(this.db);
    }
  }

  async enqueue(intents: QueueIntent[], db: Executor = this.db) {
    for (let offset = 0; offset < intents.length; offset += QUEUE_BATCH) {
      const batch = intents.slice(offset, offset + QUEUE_BATCH);
      if (db.isTransaction) {
        await this.insertBatch(batch, db);
      } else {
        await db.transaction().execute((tx) => this.insertBatch(batch, tx));
      }
    }
  }

  private async insertBatch(intents: QueueIntent[], db: Executor) {
    // Same lock order as admission/completion, including multi-queue follow-ups.
    for (const queue of [...new Set(intents.map((intent) => intent.queue))].sort()) {
      await sql`insert into job_queue(name) values (${queue}) on conflict do nothing`.execute(db);
      await sql`select name from job_queue where name = ${queue} for update`.execute(db);
    }
    for (const intent of intents) {
      const key = intent.options?.deduplication?.id ?? intent.options?.jobId ?? null;
      if (key) {
        const {
          rows: [existing],
        } = await sql<{ id: string; state: QueueState }>`
          select id, state from job where queue = ${intent.queue} and "dedupKey" = ${key}
          and state in ('pending','waiting','active') for update
        `.execute(db);
        if (existing) {
          if (intent.options?.deduplication?.keepLastIfActive) {
            if (existing.state === 'active') {
              await sql`update job set "latestPending" = ${JSON.stringify(intent)}::jsonb where id = ${existing.id}::uuid`.execute(
                db,
              );
            } else {
              // Waiting deduplicated work always carries the most recent request.
              await sql`update job set data = ${JSON.stringify(intent.data)}::jsonb,
                "availableAt" = now() + ${intent.options.delay ?? 0} * interval '1 millisecond'
                where id = ${existing.id}::uuid`.execute(db);
            }
          }
          // Runs must never count a deduplicated selection as silently absent.
          if (intent.runId && intent.itemKey) {
            await this.insertRunItem(intent, db, existing.state);
            await sql`update job_run_item set "jobId" = ${existing.id}::uuid
              where "runId" = ${intent.runId}::uuid and "itemKey" = ${intent.itemKey} and stage = ${intent.name}`.execute(
              db,
            );
          }
          continue;
        }
      }
      if (intent.runId && intent.itemKey) {
        await this.insertRunItem(intent, db);
      }
      const id = randomUUID();
      await sql`insert into job(id, queue, name, data, "dedupKey", "externalId", "safeToRetry", sensitive,
        "deadlineMs", "availableAt", "runId", "itemKey", "parentId")
        values (${id}::uuid, ${intent.queue}, ${intent.name}, ${JSON.stringify(intent.data)}::jsonb,
        ${key}, ${intent.options?.jobId ?? null}, ${intent.safeToRetry}, ${intent.sensitive}, ${intent.deadlineMs},
        now() + ${intent.options?.delay ?? 0} * interval '1 millisecond', ${intent.runId ?? null}::uuid,
        ${intent.itemKey ?? null}, ${intent.parentId ?? null}::uuid)
        on conflict do nothing`.execute(db);
      if (intent.runId && intent.itemKey) {
        await sql`update job_run_item set "jobId" = (select id from job where "runId" = ${intent.runId}::uuid
          and "itemKey" = ${intent.itemKey} and name = ${intent.name})
          where "runId" = ${intent.runId}::uuid and "itemKey" = ${intent.itemKey} and stage = ${intent.name}`.execute(
          db,
        );
      }
    }
    // Notifications only reduce latency; the independent five-second scan remains authoritative.
    await sql`select pg_notify('frameleaf_jobs', '')`.execute(db);
  }

  private async insertRunItem(intent: QueueIntent, db: Executor, state: QueueState = 'pending') {
    await sql`insert into job_run_item("runId", "itemKey", stage, selection, state)
      values (${intent.runId}::uuid, ${intent.itemKey}, ${intent.name}, ${JSON.stringify(intent.sensitive ? {} : intent.data)}::jsonb, ${state})
      on conflict do nothing`.execute(db);
  }

  async createRun(kind: string, selection: Record<string, unknown>) {
    const id = randomUUID();
    await sql`insert into job_run(id, kind, selection) values (${id}::uuid, ${kind}, ${JSON.stringify(selection)}::jsonb)`.execute(
      this.db,
    );
    return id;
  }

  /** Enumeration uses keyset pages supplied by the producer, never a held SQL cursor. */
  async finishEnumeration(runId: string) {
    await this.db.transaction().execute(async (tx) => {
      await sql`update job_run set "enumerationDone" = true where id = ${runId}::uuid`.execute(tx);
      await this.settleRuns(tx);
    });
  }

  async claim(queue: string, workerId: string): Promise<QueueClaim[]> {
    return this.db.transaction().execute(async (tx) => {
      const {
        rows: [config],
      } = await sql<{ paused: boolean; concurrency: number }>`
        select paused, concurrency from job_queue where name = ${queue} for update skip locked
      `.execute(tx);
      if (!config || config.paused) {
        return [];
      }
      const {
        rows: [counts],
      } = await sql<{ active: number; ready: number }>`
        select count(*) filter (where state = 'active')::int active,
          count(*) filter (where state in ('waiting','active'))::int ready
        from job where queue = ${queue}
      `.execute(tx);
      if (counts.ready <= QUEUE_LOW_WATER) {
        // Keep the ready + active set bounded even for a 15,000-item selection.
        await sql`update job set state = 'waiting' where id in (
          select id from job j where queue = ${queue} and state = 'pending' and "availableAt" <= now()
            and ("parentId" is null or exists (select 1 from job p where p.id = j."parentId" and p.state = 'completed'))
          order by "createdAt", id limit ${Math.min(QUEUE_BATCH, QUEUE_HIGH_WATER - counts.ready)}
          for update skip locked
        )`.execute(tx);
      }
      const capacity = Math.min(QUEUE_BATCH, config.concurrency - counts.active);
      if (capacity <= 0) {
        return [];
      }
      const { rows } = await sql<QueueClaim>`
        update job set state = 'active', token = gen_random_uuid(), "workerId" = ${workerId}::uuid,
          attempt = attempt + 1, "startedAt" = now(), "progressAt" = now(), "progressUnits" = 0,
          "leaseExpiresAt" = now() + interval '60 seconds', "cancelRequestedAt" = null
        where id in (
          select id from job where queue = ${queue} and state = 'waiting' and "availableAt" <= now()
          order by "createdAt", id limit ${capacity} for update skip locked
        ) returning id, queue, name, data, token, "workerId", attempt, "runId", "itemKey", "deadlineMs", "startedAt"
      `.execute(tx);
      for (const claim of rows) {
        await sql`insert into job_attempt("jobId", attempt, token, "workerId")
          values (${claim.id}::uuid, ${claim.attempt}, ${claim.token}::uuid, ${workerId}::uuid)`.execute(tx);
        await this.syncItem(claim.id, tx);
      }
      return rows;
    });
  }

  async heartbeat(workerId: string, claims: Array<{ id: string; token: string }>) {
    await this.db.transaction().execute(async (tx) => {
      await sql`update job_worker set "heartbeatAt" = now() where id = ${workerId}::uuid`.execute(tx);
      // One bounded statement irrespective of active media concurrency.
      await sql`update job j set "leaseExpiresAt" = now() + interval '60 seconds'
        from jsonb_to_recordset(${JSON.stringify(claims)}::jsonb) as owned(id uuid, token uuid)
        where j.id = owned.id and j.token = owned.token and j.state = 'active'
        and j."workerId" = ${workerId}::uuid and j."leaseExpiresAt" > now()`.execute(tx);
    });
  }

  async progress(claim: QueueClaim, units: number) {
    if (!Number.isSafeInteger(units) || units < 0) {
      return;
    }
    await sql`update job set "progressAt" = now(), "progressUnits" = ${units}
      where id = ${claim.id}::uuid and token = ${claim.token}::uuid and state = 'active'
      and "leaseExpiresAt" > now() and "progressUnits" < ${units}`.execute(this.db);
  }

  /** Canonical adoption callback and follow-up intents share the token-fenced commit. No I/O here. */
  async complete(claim: QueueClaim, followups: QueueIntent[], adopt?: (tx: Transaction<any>) => Promise<void>) {
    return this.db.transaction().execute(async (tx) => {
      // Lock queue rows before job rows everywhere; this prevents completion/enqueue deadlocks.
      for (const queue of [...new Set([claim.queue, ...followups.map((item) => item.queue)])].sort()) {
        await sql`select name from job_queue where name = ${queue} for update`.execute(tx);
      }
      const {
        rows: [job],
      } = await sql<{ latestPending: QueueIntent | null }>`
        select "latestPending" from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid
        and state = 'active' and "leaseExpiresAt" > now() and "cancelRequestedAt" is null for update
      `.execute(tx);
      if (!job) {
        return false;
      }
      await adopt?.(tx);
      await sql`update job set state = 'completed', "finishedAt" = now(), token = null,
        "leaseExpiresAt" = null, "latestPending" = null,
        data = case when sensitive then '{}'::jsonb else data end
        where id = ${claim.id}::uuid`.execute(tx);
      await sql`update job_attempt set outcome = 'completed', "finishedAt" = now() where token = ${claim.token}::uuid`.execute(
        tx,
      );
      await this.syncItem(claim.id, tx);
      await this.enqueue([...followups, ...(job.latestPending ? [job.latestPending] : [])], tx);
      await this.settleRuns(tx);
      return true;
    });
  }

  async fail(claim: QueueClaim, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      await sql`select name from job_queue where name = ${claim.queue} for update`.execute(tx);
      const { rows } = await sql<{ id: string; state: QueueState }>`update job set
        state = case when not "safeToRetry" then 'needs_attention' when attempt < "retryBaseAttempt" + 2 then 'pending' else 'failed' end,
        "availableAt" = now() + interval '30 seconds', token = null, "leaseExpiresAt" = null,
        "finishedAt" = case when not "safeToRetry" or attempt >= "retryBaseAttempt" + 2 then now() else null end,
        error = case when sensitive then 'Job failed; sensitive details omitted' else ${reason.slice(0, 500)} end,
        data = case when sensitive then '{}'::jsonb else data end
        where id = ${claim.id}::uuid and token = ${claim.token}::uuid and state = 'active'
        returning id, state`.execute(tx);
      if (!rows.length) {
        return false;
      }
      await sql`update job_attempt set outcome = ${rows[0].state}, "finishedAt" = now(),
        error = (select error from job where id = ${claim.id}::uuid) where token = ${claim.token}::uuid`.execute(tx);
      await this.syncItem(claim.id, tx);
      await this.settleDependencies(tx);
      await this.settleRuns(tx);
      return true;
    });
  }

  /** Only the coordinator observes persisted deadlines; no handler event-loop timer is trusted. */
  async deadlines(workerId: string) {
    const { rows } = await sql<{ id: string; token: string; cancelRequestedAt: Date | null }>`
      update job set "cancelRequestedAt" = coalesce("cancelRequestedAt", now())
      where state = 'active' and "workerId" = ${workerId}::uuid and (
        "cancelRequestedAt" is not null or "leaseExpiresAt" <= now() or
        ("progressUnits" = 0 and "startedAt" + "deadlineMs" * interval '1 millisecond' <= now()) or
        ("progressUnits" > 0 and "progressAt" + interval '10 minutes' <= now())
      ) returning id, token, "cancelRequestedAt"
    `.execute(this.db);
    return rows;
  }

  async recoverExpired() {
    const { rows } = await sql<QueueClaim>`select id, queue, token from job
      where state = 'active' and "leaseExpiresAt" < now() order by "leaseExpiresAt" limit ${QUEUE_BATCH}`.execute(
      this.db,
    );
    for (const claim of rows) {
      await this.fail(claim, 'Worker lease expired');
      await sql`update media_operation set "claimExpiresAt" = now()
        where id = (select case when data->>'operationId' ~ '^[0-9a-fA-F-]{36}$'
          then (data->>'operationId')::uuid else null end from job where id = ${claim.id}::uuid)
        and "claimedBy" = 'job-queue' and "claimToken" is not null`.execute(this.db);
    }
    await sql`update job_worker set state = 'lost' where "heartbeatAt" < now() - interval '60 seconds'`.execute(
      this.db,
    );
  }

  private async syncItem(jobId: string, tx: Executor) {
    await sql`update job_run_item i set state = j.state from job j
      where j.id = ${jobId}::uuid and i."jobId" = j.id`.execute(tx);
  }

  private async settleDependencies(tx: Executor) {
    // Recursive closure settles every descendant, including branches never admitted to ready work.
    await sql`with recursive blocked as (
      select c.id from job c join job p on p.id = c."parentId"
      where c.state in ('pending','waiting') and p.state in ('failed','needs_attention','cancelled','blocked')
      union select c.id from job c join blocked b on c."parentId" = b.id where c.state in ('pending','waiting')
    ), changed as (
      update job set state = 'blocked', error = 'Dependency did not succeed', "finishedAt" = now()
      where id in (select id from blocked) returning id, "runId", "itemKey", name
    ) update job_run_item i set state = 'blocked' from changed c
      where i."jobId" = c.id`.execute(tx);
  }

  private async settleRuns(tx: Executor) {
    await sql`update job_run r set "finishedAt" = now()
      where "enumerationDone" and "finishedAt" is null and not exists (
        select 1 from job_run_item i where i."runId" = r.id and i.state not in
        ('completed','failed','needs_attention','cancelled','blocked'))`.execute(tx);
  }

  async setConcurrency(name: string, concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error('Queue concurrency must be a positive integer');
    }
    await sql`insert into job_queue(name, concurrency) values (${name}, ${concurrency})
      on conflict (name) do update set concurrency = excluded.concurrency`.execute(this.db);
  }

  async pause(name: string, paused: boolean) {
    await sql`insert into job_queue(name, paused) values (${name}, ${paused})
      on conflict (name) do update set paused = excluded.paused`.execute(this.db);
  }

  async isPaused(name: string) {
    const { rows } = await sql<{ paused: boolean }>`select paused from job_queue where name = ${name}`.execute(this.db);
    return rows[0]?.paused ?? false;
  }

  async counts(name: string) {
    const {
      rows: [row],
    } = await sql<{
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      waiting: number;
      paused: number;
    }>`select count(*) filter (where state = 'active')::int active,
      count(*) filter (where state = 'completed')::int completed,
      count(*) filter (where state in ('failed','needs_attention','blocked'))::int failed,
      count(*) filter (where state in ('pending','waiting') and "availableAt" > now())::int delayed,
      count(*) filter (where state in ('pending','waiting') and "availableAt" <= now() and not q.paused)::int waiting,
      count(*) filter (where state in ('pending','waiting') and "availableAt" <= now() and q.paused)::int paused
      from job j join job_queue q on q.name = j.queue where queue = ${name}`.execute(this.db);
    return row;
  }

  async hasDedup(queue: string, key: string) {
    const { rows } = await sql`select 1 from job where queue = ${queue} and "dedupKey" = ${key}
      and state in ('pending','waiting','active') limit 1`.execute(this.db);
    return rows.length > 0;
  }

  async listRuns(take: number, skip: number) {
    const { rows } = await sql<{
      id: string;
      kind: string;
      createdAt: Date;
      finishedAt: Date | null;
      enumerationDone: boolean;
      total: number;
      completed: number;
      failed: number;
      active: number;
      waiting: number;
      state: string;
    }>`select r.id, r.kind, r."createdAt", r."finishedAt", r."enumerationDone",
      count(i.*)::int total, count(i.*) filter (where i.state = 'completed')::int completed,
      count(i.*) filter (where i.state in ('failed','needs_attention','blocked','cancelled'))::int failed,
      count(i.*) filter (where i.state = 'active')::int active,
      count(i.*) filter (where i.state in ('pending','waiting'))::int waiting,
      case when bool_or(i.state = 'needs_attention') then 'needs_attention'
        when r."finishedAt" is not null and bool_or(i.state in ('failed','blocked','cancelled')) then 'failed'
        when r."finishedAt" is not null then 'completed'
        when not exists (select 1 from job_worker where state = 'running' and "heartbeatAt" > now() - interval '60 seconds') then 'unavailable'
        when bool_or(i.state in ('pending','waiting')) and not bool_or(i.state = 'active') then 'blocked'
        else 'running' end state
      from (select * from job_run order by "createdAt" desc, id desc limit ${take} offset ${skip}) r
      left join job_run_item i on i."runId" = r.id group by r.id, r.kind, r."createdAt", r."finishedAt", r."enumerationDone"
      order by r."createdAt" desc, r.id desc`.execute(this.db);
    return rows;
  }

  async clear(queue: string, states: QueueState[]) {
    // Keep run accounting and dependency history. Clearing hides payloads and cancels pending work.
    await this.db.transaction().execute(async (tx) => {
      await sql`select name from job_queue where name = ${queue} for update`.execute(tx);
      const { rows } = await sql<{ id: string }>`update job set state = 'cancelled', data = '{}'::jsonb,
        "latestPending" = null, "finishedAt" = now() where queue = ${queue} and state = any(${states}::text[])
        and state != 'active' returning id`.execute(tx);
      for (const { id } of rows) {
        await this.syncItem(id, tx);
      }
      await this.settleDependencies(tx);
      await this.settleRuns(tx);
    });
  }

  async retryFailed(queue: string) {
    let total = 0;
    for (;;) {
      const count = await this.db.transaction().execute(async (tx) => {
        await sql`select name from job_queue where name = ${queue} for update`.execute(tx);
        const { rows } = await sql<{ id: string; runId: string | null }>`update job j set state = 'pending',
          "availableAt" = now(), "finishedAt" = null, error = null, "retryBaseAttempt" = attempt
          where id in (
            select id from (select id, row_number() over (partition by coalesce("dedupKey", id::text) order by "createdAt", id) ordinal
              from job where queue = ${queue} and state = 'failed' and "safeToRetry") candidates
            where ordinal = 1 limit 1000
          ) and ("dedupKey" is null or not exists (select 1 from job d where d.queue = j.queue and d."dedupKey" = j."dedupKey"
            and d.state in ('pending','waiting','active'))) returning id, "runId"`.execute(tx);
        for (const row of rows) {
          await this.syncItem(row.id, tx);
          if (row.runId) {
            await sql`update job_run set "finishedAt" = null where id = ${row.runId}::uuid`.execute(tx);
          }
        }
        return rows.length;
      });
      total += count;
      if (count < 1000) {
        return total;
      }
    }
  }
}

/** Restore happens with all workers stopped. Ambiguous active effects are retained for human review. */
export async function resetQueueAfterRestore(db: Executor) {
  await sql`update job set state = 'needs_attention', token = null, "leaseExpiresAt" = null,
    "finishedAt" = now(), "latestPending" = null, error = 'Restore interrupted an active execution',
    data = case when sensitive then '{}'::jsonb else data end
    where state = 'active' or (not "safeToRetry" and state in ('pending','waiting'))`.execute(db);
  await sql`update job_attempt set outcome = 'restored_needs_attention', "finishedAt" = now()
    where "finishedAt" is null`.execute(db);
  await sql`update job_run_item i set state = j.state from job j where i."jobId" = j.id`.execute(db);
  await sql`update job_worker set state = 'lost'`.execute(db);
}
