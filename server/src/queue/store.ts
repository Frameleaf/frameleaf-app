import { Kysely, Transaction, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { feedManifest, finishSelections, resumeSelections, shareSelections } from 'src/queue/manifest.js';
import { listRunItems, listRuns, observeQueueRun } from 'src/queue/run-query.js';
import {
  JobDependencyReason,
  QUEUE_BATCH,
  QUEUE_HIGH_WATER,
  QUEUE_LOW_WATER,
  QUEUE_TIMING,
  QueueClaim,
  QueueIntent,
  QueueState,
} from 'src/queue/types.js';

type Executor = Kysely<any> | Transaction<any>;

/**
 * All methods own short transactions. No connection escapes to a handler or an enumerator.
 * Bind serialized JSON as text before casting: postgres.js otherwise JSON-encodes it a second time.
 */
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
        } = await sql<{
          id: string;
          state: QueueState;
          latestPending: QueueIntent | null;
          ownsProducerState: boolean;
        }>`
          select j.id, j.state, j."latestPending",
            (j.data ? '_producerCheckpoints' or exists (
              select 1 from job_selection s where s."producerId" = j.id)) as "ownsProducerState"
          from job j where j.queue = ${intent.queue} and j."dedupKey" = ${key}
          and j.state in ('pending','waiting','active') for update of j
        `.execute(db);
        if (existing) {
          if (intent.options?.deduplication?.keepLastIfActive) {
            // A stopped producer may still own a durable snapshot/checkpoint. Rewriting it would
            // orphan its original run and retry state; let it settle before scheduling the latest.
            if (existing.state === 'active' || existing.ownsProducerState) {
              // Replaced requests did not execute; they cannot inherit the predecessor's success.
              const previous = existing.latestPending;
              let superseded: Array<{ runId: string; rootItemKey: string | null }> = [];
              if (
                previous?.runId &&
                previous.itemKey &&
                (previous.runId !== intent.runId || previous.itemKey !== intent.itemKey)
              ) {
                const { rows } = await sql<{ runId: string; rootItemKey: string | null }>`
                  update job_run_item set state = 'cancelled'
                  where "runId" = ${previous.runId}::uuid and "itemKey" = ${previous.itemKey} and stage = ${previous.name}
                  and "jobId" is null returning "runId", "rootItemKey"`.execute(db);
                superseded = rows;
              }
              if (intent.runId && intent.itemKey) {
                await this.insertRunItem(intent, db);
              }
              await sql`update job set "latestPending" = ${JSON.stringify(intent)}::text::jsonb where id = ${existing.id}::uuid`.execute(
                db,
              );
              await this.finishSupersededProducers(superseded, db);
              await this.settleRuns(
                db,
                superseded.map((item) => item.runId),
              );
              continue;
            }
            // Pending replacement transfers ownership to the newest run. Older requests
            // are cancelled explicitly instead of inheriting an output they never requested.
            const { rows: superseded } = await sql<{ runId: string; rootItemKey: string | null }>`
              update job_run_item set state = 'cancelled', "jobId" = null
                where "jobId" = ${existing.id}::uuid and not
                  ("runId" is not distinct from ${intent.runId ?? null}::uuid and "itemKey" is not distinct from ${intent.itemKey ?? null})
                returning "runId", "rootItemKey"`.execute(db);
            if (intent.runId && intent.itemKey) {
              await this.insertRunItem(intent, db);
            }
            await sql`update job set data = ${JSON.stringify(intent.data)}::text::jsonb,
                "safeToRetry" = ${intent.safeToRetry}, sensitive = ${intent.sensitive}, "deadlineMs" = ${intent.deadlineMs},
                "runId" = ${intent.runId ?? null}::uuid, "itemKey" = ${intent.itemKey ?? null}, "rootItemKey" = ${intent.rootItemKey ?? null},
                "availableAt" = now() + ${intent.options.delay ?? 0} * interval '1 millisecond'
                where id = ${existing.id}::uuid`.execute(db);
            await this.finishSupersededProducers(superseded, db);
            await this.settleRuns(
              db,
              superseded.map((item) => item.runId),
            );
          }
          // Runs must never count a deduplicated selection as silently absent.
          if (intent.runId && intent.itemKey) {
            await this.insertRunItem(intent, db, existing.state);
            await sql`update job_run_item set "jobId" = ${existing.id}::uuid
              where "runId" = ${intent.runId}::uuid and "itemKey" = ${intent.itemKey} and stage = ${intent.name}`.execute(
              db,
            );
          }
          await shareSelections(db, existing.id);
          continue;
        }
      }
      if (intent.runId && intent.itemKey) {
        await this.insertRunItem(intent, db);
      }
      const id = randomUUID();
      await sql`insert into job(id, queue, name, data, "dedupKey", "externalId", "safeToRetry", sensitive,
        "deadlineMs", "availableAt", "runId", "itemKey", "rootItemKey", "parentId")
        values (${id}::uuid, ${intent.queue}, ${intent.name}, ${JSON.stringify(intent.data)}::text::jsonb,
        ${key}, ${intent.options?.jobId ?? null}, ${intent.safeToRetry}, ${intent.sensitive}, ${intent.deadlineMs},
        now() + ${intent.options?.delay ?? 0} * interval '1 millisecond', ${intent.runId ?? null}::uuid,
        ${intent.itemKey ?? null}, ${intent.rootItemKey ?? null}, ${intent.parentId ?? null}::uuid)
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

  /** A superseded producer cannot enumerate later; only close its positively identified retained run. */
  private async finishSupersededProducers(
    memberships: Array<{ runId: string; rootItemKey: string | null }>,
    db: Executor,
  ) {
    const runIds = [...new Set(memberships.filter((item) => item.rootItemKey === null).map((item) => item.runId))];
    if (runIds.length === 0) return;
    await sql`update job_run r set "enumerationDone" = true
      where r.id = any(${runIds}::uuid[]) and not r."enumerationDone"
      and not exists (
        select 1 from job_run_item i where i."runId" = r.id and i."rootItemKey" is null
          and i.state not in ('completed','failed','needs_attention','cancelled','blocked'))
      and not exists (
        select 1 from job_selection s where s.state = 'enumerating' and
          (s."runId" = r.id or exists (
            select 1 from job_run_item i where i."runId" = r.id and i."selectionId" = s.id)))`.execute(db);
    // settleRuns separately requires every retained descendant stage to be terminal, including
    // manifest items not yet admitted to job. Never infer completion from the live job table.
  }

  private async insertRunItem(intent: QueueIntent, db: Executor, state: QueueState = 'pending') {
    await sql`insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, state)
      values (${intent.runId}::uuid, ${intent.itemKey}, ${intent.rootItemKey ?? null}, ${intent.name}, ${intent.queue}, ${JSON.stringify(intent.sensitive ? {} : intent.data)}::text::jsonb, ${state})
      on conflict do nothing`.execute(db);
  }

  async createRun(kind: string, selection: Record<string, unknown>) {
    const id = randomUUID();
    await sql`insert into job_run(id, kind, selection) values (${id}::uuid, ${kind}, ${JSON.stringify(selection)}::text::jsonb)`.execute(
      this.db,
    );
    return id;
  }

  /** Admit a prepared run and all initial intents inside one caller-owned, database-only transaction. */
  async admitRun(
    id: string,
    kind: string,
    selection: Record<string, unknown>,
    intents: QueueIntent[],
    tx: Transaction<any>,
  ) {
    // Lock every prepared destination before insertBatch can take any job/item locks.
    for (const queue of [...new Set(intents.map((intent) => intent.queue))].sort()) {
      await sql`insert into job_queue(name) values (${queue}) on conflict do nothing`.execute(tx);
      await sql`select name from job_queue where name = ${queue} for update`.execute(tx);
    }
    await sql`insert into job_run(id, kind, selection)
      values (${id}::uuid, ${kind}, ${JSON.stringify(selection)}::text::jsonb)`.execute(tx);
    await this.enqueue(intents, tx);
    await sql`update job_run set "enumerationDone" = true where id = ${id}::uuid and not exists (
      select 1 from job_run_item where "runId" = ${id}::uuid and "rootItemKey" is null
      and state in ('pending','waiting','active'))`.execute(tx);
    await this.settleRuns(tx, [id]);
  }

  /** Enumeration uses keyset pages supplied by the producer, never a held SQL cursor. */
  async finishEnumeration(runId: string) {
    await this.db.transaction().execute(async (tx) => {
      await sql`update job_run set "enumerationDone" = true where id = ${runId}::uuid`.execute(tx);
      await this.settleRuns(tx, [runId]);
    });
  }

  async feedManifest(queue: string) {
    return feedManifest(this.db, queue, (intents, tx) => this.enqueue(intents, tx));
  }

  async claim(queue: string, workerId: string, maxClaims = QUEUE_BATCH): Promise<QueueClaim[]> {
    if (!Number.isSafeInteger(maxClaims) || maxClaims <= 0) return [];
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
        from job where queue = ${queue} and state in ('waiting','active')
      `.execute(tx);
      if (counts.ready <= QUEUE_LOW_WATER) {
        // Keep the ready + active set bounded even for a 15,000-item selection.
        for (let slots = QUEUE_HIGH_WATER - counts.ready; slots > 0; slots -= QUEUE_BATCH) {
          await sql`update job set state = 'waiting' where id in (
          select id from job j where queue = ${queue} and state = 'pending' and "availableAt" <= now()
            and ("parentId" is null or exists (select 1 from job p where p.id = j."parentId" and p.state = 'completed'))
          order by "createdAt", id limit ${Math.min(QUEUE_BATCH, slots)}
          for update skip locked
        )`.execute(tx);
        }
      }
      const capacity = Math.min(QUEUE_BATCH, maxClaims, config.concurrency - counts.active);
      if (capacity <= 0) {
        return [];
      }
      const { rows } = await sql<QueueClaim>`
        update job set state = 'active', token = gen_random_uuid(), "workerId" = ${workerId}::uuid,
          attempt = attempt + 1, "startedAt" = now(), "progressAt" = now(), "progressUnits" = 0,
          "leaseExpiresAt" = now() + interval '60 seconds', "cancelRequestedAt" = null, "dependencyReason" = null
        where id in (
          select id from job where queue = ${queue} and state = 'waiting' and "availableAt" <= now()
          order by "createdAt", id limit ${capacity} for update skip locked
        ) returning id, queue, name, data, token, "workerId", attempt, "runId", "itemKey", "rootItemKey", "deadlineMs", "startedAt", "safeToRetry"
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
        from jsonb_to_recordset(${JSON.stringify(claims)}::text::jsonb) as owned(id uuid, token uuid)
        where j.id = owned.id and j.token = owned.token and j.state = 'active'
        and j."workerId" = ${workerId}::uuid and j."leaseExpiresAt" > clock_timestamp()`.execute(tx);
    });
  }

  async progress(claim: QueueClaim, units: number) {
    if (!Number.isSafeInteger(units) || units < 0) {
      return;
    }
    await sql`update job set "progressAt" = now(), "progressUnits" = ${units}
      where id = ${claim.id}::uuid and token = ${claim.token}::uuid and state = 'active'
      and "leaseExpiresAt" > clock_timestamp() and "progressUnits" < ${units}`.execute(this.db);
  }

  /** Canonical adoption callback and follow-up intents share the token-fenced commit. No I/O here. */
  async complete(claim: QueueClaim, followups: QueueIntent[], adopt?: (tx: Transaction<any>) => Promise<void>) {
    return this.db.transaction().execute(async (tx) => {
      // Publications may construct additional child intents after reading their accepted rows.
      // Lock the finite queue catalogue in one order before any job/asset rows, including those
      // destinations. Media work has already finished; only the short publication is serialized.
      await sql`select name from job_queue order by name for update`.execute(tx);
      const {
        rows: [job],
      } = await sql<{ latestPending: QueueIntent | null }>`
        select "latestPending" from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid
        and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null for update
      `.execute(tx);
      if (!job) {
        return false;
      }
      await adopt?.(tx);
      const { rows: accepted } =
        await sql`update job set state = 'completed', "finishedAt" = clock_timestamp(), token = null,
        "leaseExpiresAt" = null, "latestPending" = null, "dependencyReason" = null,
        data = case when sensitive then '{}'::jsonb else data end
        where id = ${claim.id}::uuid and token = ${claim.token}::uuid and "leaseExpiresAt" > clock_timestamp()
        and "cancelRequestedAt" is null returning id`.execute(tx);
      if (accepted.length === 0) {
        throw new Error('Publication lease expired before commit');
      }
      await sql`update job_attempt set outcome = 'completed', "finishedAt" = now() where token = ${claim.token}::uuid`.execute(
        tx,
      );
      const affectedRuns = await this.syncItem(claim.id, tx);
      const { rows: lineage } = await sql<{
        runId: string;
        itemKey: string;
        rootItemKey: string | null;
      }>`select "runId", "itemKey", "rootItemKey" from job_run_item
        where "jobId" = ${claim.id}::uuid and state != 'cancelled'`.execute(tx);
      const inherited = followups.flatMap((intent) => {
        if (lineage.length === 0 || (intent.runId && intent.runId !== claim.runId)) {
          return [intent];
        }
        return lineage.map((parent) => ({
          ...intent,
          runId: parent.runId,
          rootItemKey: parent.rootItemKey,
          itemKey:
            intent.itemKey === claim.itemKey
              ? parent.itemKey
              : (intent.itemKey ??
                String(
                  intent.data.id ??
                    intent.data.assetId ??
                    createHash('sha256').update(JSON.stringify(intent.data)).digest('hex'),
                )),
        }));
      });
      await this.enqueue(inherited, tx);
      const latest = await this.scheduleLatest(claim.id, job.latestPending, tx);
      await finishSelections(tx, claim.id, true);
      await this.settleRuns(tx, [...affectedRuns, ...latest.runIds]);
      return true;
    });
  }

  /** A dependency refusal is not an execution failure. Keep the item and audit, refund its retry credit. */
  async defer(claim: QueueClaim, reason: JobDependencyReason) {
    return this.db.transaction().execute(async (tx) => {
      await sql`select name from job_queue where name = ${claim.queue} for update`.execute(tx);
      const { rows } = await sql`update job set state = 'pending', token = null, "leaseExpiresAt" = null,
        "workerId" = null, "cancelRequestedAt" = null, "finishedAt" = null, error = null,
        "retryBaseAttempt" = "retryBaseAttempt" + 1, "dependencyReason" = ${reason},
        "availableAt" = clock_timestamp() + interval '30 seconds'
        where id = ${claim.id}::uuid and token = ${claim.token}::uuid and state = 'active'
          and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null returning id`.execute(tx);
      if (rows.length === 0) return false;
      await sql`update job_attempt set outcome = 'deferred', "finishedAt" = clock_timestamp(), error = ${reason}
        where token = ${claim.token}::uuid`.execute(tx);
      await this.syncItem(claim.id, tx);
      return true;
    });
  }

  async fail(
    claim: QueueClaim,
    reason: string,
    diagnostic?: (tx: Transaction<any>) => Promise<void>,
    options: { expiredRecovery?: boolean } = {},
  ) {
    return this.db.transaction().execute(async (tx) => {
      await sql`select name from job_queue where name = ${claim.queue} for update`.execute(tx);
      let unconfirmedStop = false;
      let operationId: string | null = null;
      if (options.expiredRecovery) {
        const {
          rows: [expired],
        } = await sql<{
          stopped: boolean;
          graceElapsed: boolean;
          operationId: string | null;
        }>`select data->>'operationId' "operationId",
          "leaseExpiresAt" <= clock_timestamp() - interval '30 seconds' "graceElapsed",
          (exists (select 1 from system_metadata m
            where m.key = 'frameleaf-attempt-evidence:' || j.token::text
              and m.value->>'jobId' = j.id::text and m.value ? 'stoppedAt')
          or exists (select 1 from system_metadata m
            where m.key = 'frameleaf-worker-stopped:' || j."workerId"::text
              and m.value->>'workerId' = j."workerId"::text and m.value ? 'stoppedAt')) stopped
          from job j where id = ${claim.id}::uuid and token = ${claim.token}::uuid
            and state = 'active' and "leaseExpiresAt" <= clock_timestamp() for update`.execute(tx);
        if (!expired) return false;
        operationId = expired.operationId;
        // Allow one sweep for the independent supervisor's bounded proof write. The expired
        // token already fences publication. A timestamp alone never permits another executor.
        if (!expired.stopped && !expired.graceElapsed) {
          await sql`update job set "cancelRequestedAt" = coalesce("cancelRequestedAt", clock_timestamp()),
            error = 'Waiting for confirmation that the expired executor has stopped'
            where id = ${claim.id}::uuid`.execute(tx);
          return false;
        }
        unconfirmedStop = !expired.stopped;
        if (unconfirmedStop) reason = 'Executor stop could not be confirmed; review the worker before retrying';
      }
      if (diagnostic) {
        const { rows } = await sql`select id from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid
          and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null for update`.execute(
          tx,
        );
        if (rows.length === 0) return false;
        await diagnostic(tx);
        const { rows: valid } =
          await sql`select id from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid
          and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null`.execute(tx);
        if (valid.length === 0) throw new Error('Diagnostic publication lost its claim');
      }
      const { rows } = await sql<{ id: string; state: QueueState; latestPending: QueueIntent | null }>`update job set
        state = case when ${unconfirmedStop} or not "safeToRetry" then 'needs_attention' when attempt < "retryBaseAttempt" + 2 then 'pending' else 'failed' end,
        "availableAt" = now() + interval '30 seconds', "dependencyReason" = null, token = null, "leaseExpiresAt" = null,
        "finishedAt" = case when ${unconfirmedStop} or not "safeToRetry" or attempt >= "retryBaseAttempt" + 2 then now() else null end,
        error = case when sensitive then 'Job failed; sensitive details omitted' else ${reason.slice(0, 500)} end,
        data = case when sensitive then '{}'::jsonb else data end
        where id = ${claim.id}::uuid and token = ${claim.token}::uuid and state = 'active'
        returning id, state, "latestPending"`.execute(tx);
      if (rows.length === 0) {
        return false;
      }
      await sql`update job_attempt set outcome = ${rows[0].state}, "finishedAt" = now(),
        error = (select error from job where id = ${claim.id}::uuid) where token = ${claim.token}::uuid`.execute(tx);
      if (operationId) {
        if (unconfirmedStop) {
          // The media-operation dispatcher must not acquire a second retry budget or replay
          // an executor whose stop is unknown after this queue claim is fenced.
          await sql`update media_operation set status = 'failed', "finishedAt" = now(),
            "claimToken" = null, "claimExpiresAt" = null, "claimedBy" = null,
            "errorCode" = 'executor_stop_unconfirmed', error = ${reason},
            result = coalesce(result, '{}'::jsonb) || '{"status":"needs_attention"}'::jsonb
            where id::text = ${operationId} and "claimedBy" = 'job-queue' and "claimToken" is not null`.execute(tx);
        } else {
          await sql`update media_operation set "claimExpiresAt" = now()
            where id::text = ${operationId} and "claimedBy" = 'job-queue' and "claimToken" is not null`.execute(tx);
        }
      }
      const affectedRuns = await this.syncItem(claim.id, tx);
      if (rows[0].state !== 'pending') {
        const terminalParents = [claim.id];
        await finishSelections(tx, claim.id, false);
        await sql`update job set "latestPending" = null where id = ${claim.id}::uuid`.execute(tx);
        const latest = rows[0].latestPending;
        if (unconfirmedStop && latest) {
          await sql`update job_run_item set state = 'needs_attention'
            where "jobId" is null and "runId" = ${latest.runId ?? null}::uuid
              and "itemKey" = ${latest.itemKey ?? null} and stage = ${latest.name}`.execute(tx);
          if (latest.runId) affectedRuns.push(latest.runId);
        } else {
          const scheduled = await this.scheduleLatest(claim.id, latest, tx, false);
          affectedRuns.push(...scheduled.runIds);
          terminalParents.push(...scheduled.terminalIds);
        }
        affectedRuns.push(...(await this.settleDependencies(tx, terminalParents)));
      }
      await this.settleRuns(tx, affectedRuns);
      return true;
    });
  }

  private async scheduleLatest(
    previousId: string,
    latest: QueueIntent | null,
    tx: Executor,
    predecessorSucceeded = true,
  ) {
    const affected = { runIds: latest?.runId ? [latest.runId] : [], terminalIds: [] as string[] };
    if (!latest) {
      return affected;
    }
    // A repeated item/stage in one run retains its ledger row and monotonic attempt audit.
    const { rows } = await sql`update job set state = 'pending', data = ${JSON.stringify(latest.data)}::text::jsonb,
      "rootItemKey" = ${latest.rootItemKey ?? null}, "safeToRetry" = ${latest.safeToRetry}, sensitive = ${latest.sensitive}, "deadlineMs" = ${latest.deadlineMs},
      "availableAt" = now() + ${latest.options?.delay ?? 0} * interval '1 millisecond',
      "retryBaseAttempt" = attempt, "finishedAt" = null, "cancelRequestedAt" = null, error = null,
      "workerId" = null, "latestPending" = null
      where id = ${previousId}::uuid and "runId" = ${latest.runId ?? null}::uuid
      and "itemKey" = ${latest.itemKey ?? null} and name = ${latest.name} returning id`.execute(tx);
    if (rows.length > 0) {
      affected.runIds.push(...(await this.syncItem(previousId, tx)));
    } else {
      // A fresh safe request is not a dependency on the predecessor's success.
      await this.enqueue([{ ...latest, parentId: latest.parentId === previousId ? undefined : latest.parentId }], tx);
    }
    if (!predecessorSucceeded && !latest.safeToRetry) {
      // An ambiguous external effect cannot be replayed via the latest-request back door.
      const key = latest.options?.deduplication?.id ?? latest.options?.jobId;
      const { rows: blocked } = await sql<{
        id: string;
      }>`update job set state = 'needs_attention', "finishedAt" = now(),
        error = 'Previous execution did not settle safely; review this request before rerunning',
        data = case when sensitive then '{}'::jsonb else data end
        where queue = ${latest.queue} and "dedupKey" = ${key ?? null} and state in ('pending','waiting') returning id`.execute(
        tx,
      );
      for (const item of blocked) {
        affected.runIds.push(...(await this.syncItem(item.id, tx)));
        affected.terminalIds.push(item.id);
      }
    }
    return affected;
  }

  /** Only the coordinator observes persisted deadlines; no handler event-loop timer is trusted. */
  async deadlines(workerId: string) {
    const { rows } = await sql<{ id: string; token: string; cancelRequestedAt: Date | null }>`
      update job set "cancelRequestedAt" = coalesce("cancelRequestedAt", now())
      where state = 'active' and "workerId" = ${workerId}::uuid and (
        "cancelRequestedAt" is not null or "leaseExpiresAt" <= now() or
        ("progressUnits" = 0 and "startedAt" + "deadlineMs" * interval '1 millisecond' <= now()) or
        ("progressUnits" > 0 and "progressAt" + ${QUEUE_TIMING.noProgressDeadline} * interval '1 millisecond' <= now())
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
      await this.fail(claim, 'Worker lease expired after confirmed executor stop', undefined, {
        expiredRecovery: true,
      });
    }
    await sql`update job_worker set state = 'lost' where "heartbeatAt" < now() - interval '60 seconds'`.execute(
      this.db,
    );
  }

  private async syncItem(jobId: string, tx: Executor) {
    const { rows } = await sql<{ runId: string }>`update job_run_item i set state = j.state from job j
      where j.id = ${jobId}::uuid and i."jobId" = j.id returning i."runId"`.execute(tx);
    return rows.map((item) => item.runId);
  }

  private async settleDependencies(tx: Executor, parentIds: string[]) {
    if (parentIds.length === 0) return [];
    // Walk outward from this transaction's terminal parents, never all retained dependencies.
    const { rows: blockedMemberships } = await sql<{ jobId: string; runId: string }>`with recursive blocked as (
      select c.id from job c join job p on p.id = c."parentId"
      where c."parentId" is not null and c."parentId" = any(${parentIds}::uuid[]) and c.state in ('pending','waiting')
        and p.state in ('failed','needs_attention','cancelled','blocked')
      union select c.id from job c join blocked b on c."parentId" = b.id
        where c."parentId" is not null and c.state in ('pending','waiting')
    ), changed as (
      update job set state = 'blocked', error = 'Dependency did not succeed', "finishedAt" = now()
      where id in (select id from blocked) returning id, "runId", "itemKey", name
    ) update job_run_item i set state = 'blocked' from changed c
      where i."jobId" = c.id returning i."jobId", i."runId"`.execute(tx);
    for (const jobId of new Set(blockedMemberships.map((item) => item.jobId))) {
      await finishSelections(tx, jobId, false);
    }
    return blockedMemberships.map((item) => item.runId);
  }

  private async settleRuns(tx: Executor, runIds: string[]) {
    if (runIds.length === 0) return;
    await sql`update job_run r set "finishedAt" = now()
      where r.id = any(${[...new Set(runIds)]}::uuid[]) and "enumerationDone" and "finishedAt" is null
      and not exists (select 1 from job_run_item i where i."runId" = r.id
        and i.state in ('pending','waiting','active'))`.execute(tx);
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

  /** A drained execution buffer is not a completed durable selection. Paused work still counts. */
  async hasUnfinishedWork(queue: string) {
    const {
      rows: [row],
    } = await sql<{ unfinished: boolean }>`select
      exists (select 1 from job where queue = ${queue} and state in ('pending','waiting','active'))
      or exists (select 1 from job_run_item where queue = ${queue} and "jobId" is null
        and state in ('pending','waiting','active'))
      or exists (select 1 from job_selection where queue = ${queue} and state = 'enumerating') unfinished`.execute(
      this.db,
    );
    return row.unfinished;
  }

  listRuns(take: number, skip: number) {
    return listRuns(this.db, take, skip);
  }

  listRunItems(runId: string, take: number, skip: number) {
    return listRunItems(this.db, runId, take, skip);
  }

  observeQueueRun(name: string) {
    return observeQueueRun(this.db, name);
  }

  async clear(queue: string, states: QueueState[]) {
    // Keep run accounting and dependency history. Clearing hides payloads and cancels pending work.
    await this.db.transaction().execute(async (tx) => {
      await sql`select name from job_queue where name = ${queue} for update`.execute(tx);
      const { rows: cancelledLatest } = await sql<{ runId: string; rootItemKey: string | null }>`
        update job_run_item i set state = 'cancelled' where i."jobId" is null and exists (
        select 1 from job j where j.queue = ${queue} and j.state = any(${states}::text[]) and j.state != 'active'
        and j."latestPending" ->> 'runId' = i."runId"::text and j."latestPending" ->> 'itemKey' = i."itemKey"
        and j."latestPending" ->> 'name' = i.stage) returning i."runId", i."rootItemKey"`.execute(tx);
      const affectedRuns = cancelledLatest.map((item) => item.runId);
      if (states.includes('pending') || states.includes('waiting')) {
        const { rows: cancelled } = await sql<{
          runId: string;
        }>`with cancelled as (
          update job_run_item set state = 'cancelled' where queue = ${queue}
            and "selectionId" is not null and "jobId" is null and state = 'pending' returning "runId"
        ) select distinct "runId" from cancelled`.execute(tx);
        affectedRuns.push(...cancelled.map((item) => item.runId));
      }
      const { rows } = await sql<{ id: string }>`update job set state = 'cancelled', data = '{}'::jsonb,
        "latestPending" = null, "finishedAt" = now() where queue = ${queue} and state = any(${states}::text[])
        and state != 'active' returning id`.execute(tx);
      for (const { id } of rows) {
        affectedRuns.push(...(await this.syncItem(id, tx)));
        await finishSelections(tx, id, false);
      }
      affectedRuns.push(
        ...(await this.settleDependencies(
          tx,
          rows.map((item) => item.id),
        )),
      );
      await this.finishSupersededProducers(cancelledLatest, tx);
      await this.settleRuns(tx, affectedRuns);
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
          const affectedRuns = await this.syncItem(row.id, tx);
          await resumeSelections(tx, row.id);
          if (affectedRuns.length > 0) {
            await sql`update job_run set "finishedAt" = null where id = any(${affectedRuns}::uuid[])`.execute(tx);
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

/** Restore runs with all workers stopped. Only audited repeatable work retains its existing retry budget.
 * Operation-owned jobs are never resumed here; the media-operation dispatcher owns their retry.
 */
export async function resetQueueAfterRestore(db: Executor) {
  await sql`update job_run_item i set state = 'needs_attention' where i."jobId" is null and exists (
    select 1 from job j where (j.state = 'active' or (not j."safeToRetry" and j.state in ('pending','waiting')))
    and j."latestPending" ->> 'runId' = i."runId"::text and j."latestPending" ->> 'itemKey' = i."itemKey"
    and j."latestPending" ->> 'name' = i.stage)`.execute(db);
  await sql`update job_attempt a set outcome = case when j."safeToRetry" and not (j.data ? 'operationId')
      and j.attempt < j."retryBaseAttempt" + 2 then 'restored_retry' else 'restored_needs_attention' end,
      "finishedAt" = now() from job j where a."jobId" = j.id and a."finishedAt" is null`.execute(db);
  await sql`update job set state = case when "safeToRetry" and not (data ? 'operationId')
        and attempt < "retryBaseAttempt" + 2 then 'pending' else 'needs_attention' end,
    token = null, "leaseExpiresAt" = null, "workerId" = null, "cancelRequestedAt" = null,
    "availableAt" = now() + interval '30 seconds', "latestPending" = null,
    "finishedAt" = case when "safeToRetry" and not (data ? 'operationId') and attempt < "retryBaseAttempt" + 2 then null else now() end,
    error = 'Restore revoked the previous execution claim',
    data = case when sensitive then '{}'::jsonb else data end
    where state = 'active' or ((not "safeToRetry" or data ? 'operationId') and state in ('pending','waiting'))`.execute(
    db,
  );
  await sql`update job_run_item i set state = j.state from job j where i."jobId" = j.id`.execute(db);
  const { rows: stoppedProducers } = await sql<{
    producerId: string;
  }>`select distinct s."producerId" from job_selection s
    join job j on j.id = s."producerId" where j.state in ('failed','needs_attention','cancelled','blocked')`.execute(
    db,
  );
  for (const { producerId } of stoppedProducers) await finishSelections(db, producerId, false);
  await sql`update job_selection set state = 'needs_attention' where not "safeToRetry"`.execute(db);
  await sql`update job_run_item set state = 'needs_attention' where "jobId" is null and state = 'pending'
    and "selectionId" in (select id from job_selection where state = 'needs_attention')`.execute(db);
  await sql`update job_run r set "finishedAt" = now() where "enumerationDone" and "finishedAt" is null
    and not exists(select 1 from job_run_item i where i."runId" = r.id
      and i.state in ('pending','waiting','active'))`.execute(db);
  await sql`update job_worker set state = 'lost'`.execute(db);
}
