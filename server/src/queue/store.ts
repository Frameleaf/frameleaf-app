import { Kysely, type QueryExecutorProvider, type RawBuilder, type SelectQueryBuilder, Transaction, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { validate as isUuid } from 'uuid';
import type { RunFailureCause } from 'src/queue/run-failure-cause.js';
import type { DB } from 'src/schema/index.js';
import { JobName, MediaOperationKind, QueueName } from 'src/enum.js';
import { costReusedRead } from 'src/queue/coalesced-task.js';
import { QUEUE_CHANNEL } from 'src/queue/notifications.js';
import {
  clearProcessingFailure,
  isProcessingFailureStep,
  processingFailureSteps,
  processingIsSetAside,
  queuedProcessingIsSetAside,
  recordProcessingFailure,
} from 'src/queue/processing-failure.js';
import {
  getRun,
  listRunItems,
  listRuns,
  observeQueueRun,
  reportedQueueJobs,
  rewriteFailureCauses,
  runFailureRoots,
} from 'src/queue/run-query.js';
import {
  JobDependencyReason,
  QUEUE_BATCH,
  QUEUE_TIMING,
  QueueClaim,
  QueueExecution,
  QueueIntent,
  QueueState,
  RunHolds,
} from 'src/queue/types.js';
import { canonicalJson } from 'src/utils/object.js';

type Executor = Kysely<DB>;

// An unclaimed row no longer carries its token. Retained attempts, not its state, prove it stopped.
const stoppedJobAttempts = sql`((j.attempt = 0 or exists (
  select 1 from job_attempt a where a."jobId" = j.id and a.attempt = j.attempt))
  and not exists (select 1 from job_attempt a where a."jobId" = j.id
    and (a.outcome is distinct from 'completed' or a."finishedAt" is null)
    and not exists (select 1 from system_metadata m where m.key = 'frameleaf-attempt-evidence:' || a.token::text
      and m.value->>'jobId' = j.id::text and m.value ? 'stoppedAt')
    and not exists (select 1 from system_metadata m where m.key = 'frameleaf-worker-stopped:' || a."workerId"::text
      and m.value->>'workerId' = a."workerId"::text and m.value ? 'stoppedAt')))`;

/**
 * Local or destination capacity frees up within seconds. Any other dependency (machine learning off or unreachable,
 * consent, budget, a missing preview) can stay down for hours, so its jobs wait longer on each claim
 * (30s, 1m, 2m, 4m, 8m, then every 10m) instead of re-running every 30 seconds forever.
 */
const deferralDelay = (reason: JobDependencyReason) =>
  reason === 'local-capacity' || reason === 'destination-capacity'
    ? sql`interval '30 seconds'`
    : reason === 'locked-key-unavailable'
      ? // FL-721: an hour per wait (LOCKED_DEFERRAL_DELAY_MS); a key load wakes it sooner (`wakeDeferred`)
        sql`interval '1 hour'`
      : sql`least(interval '30 seconds' * power(2, least(attempt - 1, 5)), interval '10 minutes')`;

/**
 * The `availableAt` of a job started by hand (Start now, Run on one item). Nothing else is available
 * from the epoch: queued work is available from when it was queued, or later when delayed.
 */
const STARTED_BY_HAND = sql`'epoch'::timestamptz`;
/** FL-1265: a held job (setup, a setup pause, a parked stage) waits with this `availableAt`; claims never reach it. */
const HELD = sql`'infinity'::timestamptz`;
const LIVE = sql`('pending','waiting','active')`;
/** Coalesces queue wakes; long enough for the caller's transaction to commit first. */
const WAKE_DELAY_MS = 50;
/**
 * FL-1272: later steps of an item a queue has already started. Each finished first step adds one, so the
 * queue's waiting total stays flat while work progresses; `counts` reports them apart as `followUp`.
 */
const FOLLOW_UP_STEPS: Partial<Record<string, string[]>> = {
  [QueueName.MetadataExtraction]: [JobName.AssetMetadataPostprocess],
};
/** Pages of the coordinator's hold reconciliation, one statement each. */
const HOLD_PAGE = 2000;

/** Whether the run holds this stage: its jobs are inserted or retried held. */
const stageHeld = (runId: RawBuilder<unknown>, name: RawBuilder<unknown>) =>
  sql<boolean>`exists (select 1 from job_run r where r.id = ${runId} and r.selection->'holds' ? ${name})`;
const availability = (runId: RawBuilder<unknown>, name: RawBuilder<unknown>, delayMs: number = 0) =>
  sql`case when ${stageHeld(runId, name)} then ${HELD} else now() + ${delayMs} * interval '1 millisecond' end`;
const intentAvailability = (intent: QueueIntent) =>
  availability(sql`${intent.runId ?? null}::uuid`, sql`${intent.name}::text`, intent.options?.delay ?? 0);

type WakeState = { timer?: NodeJS.Timeout; inFlight: boolean; again: boolean };
/** One wake state per database pool: stores built per call on the same pool share it. */
const wakeStates = new WeakMap<Kysely<DB>, WakeState>();

/**
 * Tells the claim loops new work may be ready. Never inside a caller's transaction: PostgreSQL serializes every
 * NOTIFY commit on one cluster-wide lock, so a job write that notified could fail its COMMIT on lock_timeout and
 * roll back. Instead at most one notification per pool per WAKE_DELAY_MS goes out on its own pooled connection,
 * after the caller's commit in practice, and a stalled one holds a single connection: wakes asked for meanwhile
 * collapse into one follow-up. A lost wake only costs latency; the five-second scan stays authoritative.
 */
const wakeClaimLoops = (db: Kysely<DB>) => {
  let state = wakeStates.get(db);
  if (!state) {
    state = { inFlight: false, again: false };
    wakeStates.set(db, state);
  }
  if (state.timer) {
    return;
  }
  if (state.inFlight) {
    state.again = true;
    return;
  }
  const current = state;
  current.timer = setTimeout(() => {
    current.timer = undefined;
    current.inFlight = true;
    void sql`select pg_notify(${QUEUE_CHANNEL}, '')`
      .execute(db)
      .catch(() => {})
      .finally(() => {
        current.inFlight = false;
        if (current.again) {
          current.again = false;
          wakeClaimLoops(db);
        }
      });
  }, WAKE_DELAY_MS);
  current.timer.unref();
};

/**
 * All methods own short transactions. No connection escapes to a handler or an enumerator.
 * Bind serialized JSON as text before casting: postgres.js otherwise JSON-encodes it a second time.
 */
export class SqlQueueStore {
  constructor(readonly db: Kysely<DB>) {}

  private wake() {
    wakeClaimLoops(this.db);
  }

  async initialize(queues: string[], workerId?: string) {
    // Preserve the Manager discriminator before recovery can lose the detailed marker.
    await sql`update job_run set selection=selection || '{"managerSetupRequired":true}'::jsonb
      where kind in ('immich-import-derived','library-import-derived')
        and selection ? 'managerSetup' and not selection ? 'managerSetupRequired'`.execute(this.db);
    for (const name of queues) {
      await sql`insert into job_queue(name) values (${name}) on conflict do nothing`.execute(this.db);
    }
    if (workerId) {
      await sql`insert into job_worker(id) values (${workerId}::uuid)`.execute(this.db);
    }
  }

  /**
   * Inserts only; no queue row is locked (FL-1265). Returns how many intents this call took on: new or re-armed jobs,
   * and latest requests recorded on or moved into a live job (those belong to the intent's run). `liveRunId` is
   * a run kept open by the caller's own live job (its claim, or a run this transaction creates).
   */
  async enqueue(intents: QueueIntent[], db: Executor = this.db, liveRunId?: string | null): Promise<number> {
    let inserted = 0;
    for (let offset = 0; offset < intents.length; offset += QUEUE_BATCH) {
      const batch = intents.slice(offset, offset + QUEUE_BATCH);
      inserted += db.isTransaction
        ? await this.insertBatch(batch, db, liveRunId)
        : await db.transaction().execute((tx) => this.insertBatch(batch, tx, liveRunId));
    }
    return inserted;
  }

  private async insertBatch(intents: QueueIntent[], db: Executor, liveRunId?: string | null) {
    const queues = [...new Set(intents.map((intent) => intent.queue))].sort();
    await sql`insert into job_queue(name) select unnest(${queues}::text[]) on conflict do nothing`.execute(db);
    const runIds = [...new Set(intents.flatMap((intent) => (intent.runId ? [intent.runId] : [])))].sort();
    const reopened = runIds.filter((runId) => runId !== liveRunId);
    if (reopened.length > 0) {
      // New work reopens a finished run. Unconditional, so the row lock also orders this with `finishRuns`;
      // the caller's own live run cannot finish under it and is left unlocked.
      await sql`update job_run set "finishedAt" = null where id = any(${reopened}::uuid[])`.execute(db);
    }
    if (runIds.length > 0) {
      // A run's holds are read under its row, so a concurrent `setRunHolds` cannot be overwritten by an older view.
      await sql`select id from job_run where id = any(${runIds}::uuid[]) and selection ? 'holds' order by id for share`.execute(
        db,
      );
    }
    let inserted = 0;
    for (const intent of intents) {
      const { id } = intent.data;
      if (isProcessingFailureStep(intent.name) && typeof id === 'string' && isUuid(id)) {
        const {
          rows: [check],
        } = await sql<{ setAside: boolean }>`select ${processingIsSetAside(
          sql`${id}::uuid`,
          sql`${intent.name}`,
          sql`${intent.data.includeSetAside === true}::boolean`,
        )} as "setAside"`.execute(db);
        if (check.setAside) continue;
      }
      const key = intent.options?.deduplication?.id ?? intent.options?.jobId ?? null;
      if (key) {
        const {
          rows: [existing],
        } = await sql<{
          id: string;
          name: string;
          data: Record<string, unknown>;
          state: QueueState;
          ownsProducerState: boolean;
        }>`select j.id, j.name, j.data, j.state,
            (j.data ? '_producerCheckpoints' or j.data ? '_selectionCursor') "ownsProducerState"
          from job j where j.queue = ${intent.queue} and j."dedupKey" = ${key}
          and j.state in ${LIVE} for update of j`.execute(db);
        if (existing) {
          if (intent.options?.deduplication?.keepLastIfActive) {
            // A pending seal covers every later publication for this asset; it keeps its original request.
            const sharedSealing =
              intent.name === JobName.LockedSeal &&
              existing.name === intent.name &&
              typeof intent.data.id === 'string' &&
              existing.data.id === intent.data.id &&
              !existing.ownsProducerState;
            if (existing.state === 'active' || existing.ownsProducerState) {
              // A running job, or a producer that may own a checkpoint, settles first; the latest request runs after it.
              await sql`update job set "latestPending" = ${JSON.stringify(intent)}::text::jsonb where id = ${existing.id}::uuid`.execute(
                db,
              );
              inserted++;
            } else if (!sharedSealing) {
              await sql`update job set data = ${JSON.stringify(intent.data)}::text::jsonb,
                "safeToRetry" = ${intent.safeToRetry}, sensitive = ${intent.sensitive}, "deadlineMs" = ${intent.deadlineMs},
                "runId" = ${intent.runId ?? null}::uuid, "itemKey" = ${intent.itemKey ?? null}, "rootItemKey" = ${intent.rootItemKey ?? null},
                "availableAt" = ${intentAvailability(intent)}
                where id = ${existing.id}::uuid`.execute(db);
              inserted++;
            }
          }
          continue;
        }
      }
      const { rows } =
        await sql`insert into job(id, queue, name, data, "dedupKey", "externalId", "safeToRetry", sensitive,
        "deadlineMs", "availableAt", "runId", "itemKey", "rootItemKey", "parentId")
        values (${randomUUID()}::uuid, ${intent.queue}, ${intent.name}, ${JSON.stringify(intent.data)}::text::jsonb,
        ${key}, ${intent.options?.jobId ?? null}, ${intent.safeToRetry}, ${intent.sensitive}, ${intent.deadlineMs},
        ${intentAvailability(intent)}, ${intent.runId ?? null}::uuid,
        ${intent.itemKey ?? null}, ${intent.rootItemKey ?? null}, ${intent.parentId ?? null}::uuid)
        on conflict do nothing returning id`.execute(db);
      if (rows.length > 0 || (intent.runId && intent.itemKey && (await this.rearmRunStage(intent, key, db)))) {
        inserted++;
      }
    }
    // Notifications only reduce latency; the independent five-second scan remains authoritative.
    this.wake();
    return inserted;
  }

  /**
   * The run already holds a job row for this item/stage (`job_run_stage`). A finished row is new work
   * again when it was cancelled, or when the same parent asks for it again (that parent was re-run):
   * reuse the row like `retryFailed`, so the request is not silently dropped. A different job asking
   * for the same finished stage still coalesces onto the old row, so a pipeline cannot loop.
   */
  private async rearmRunStage(intent: QueueIntent, key: string | null, db: Executor) {
    const { rows } = await sql`update job set state = 'pending', data = ${JSON.stringify(intent.data)}::text::jsonb,
      "dedupKey" = ${key}, "externalId" = ${intent.options?.jobId ?? null}, "safeToRetry" = ${intent.safeToRetry},
      sensitive = ${intent.sensitive}, "deadlineMs" = ${intent.deadlineMs}, "rootItemKey" = ${intent.rootItemKey ?? null},
      "parentId" = ${intent.parentId ?? null}::uuid, "availableAt" = ${intentAvailability(intent)},
      "retryBaseAttempt" = attempt, "finishedAt" = null, error = null, "cancelRequestedAt" = null, "cancelReason" = null,
      "workerId" = null, "latestPending" = null, "dependencyReason" = null
      where "runId" = ${intent.runId}::uuid and "itemKey" = ${intent.itemKey} and name = ${intent.name}
        and state in ('completed','failed','needs_attention','cancelled','blocked')
        -- A request without a parent (a direct enqueue) never matches (null = null is unknown): it re-arms
        -- only a cancelled row. Nothing ties it to one requester, so it coalesces like a loop would.
        and (state = 'cancelled' or "parentId" = ${intent.parentId ?? null}::uuid)
      returning id`.execute(db);
    return rows.length > 0;
  }

  /** A bare run header; its enumeration is open until `finishEnumeration`. */
  async createRun(kind: string, selection: Record<string, unknown>) {
    const id = randomUUID();
    await sql`insert into job_run(id, kind, selection) values (${id}::uuid, ${kind}, ${JSON.stringify(selection)}::text::jsonb)`.execute(
      this.db,
    );
    return id;
  }

  /**
   * Admit a run and its initial intents inside one caller-owned transaction. When every intent coalesced into work
   * already queued, the new run is dropped and the run doing that work is returned instead.
   */
  async admitRun(
    id: string,
    kind: string,
    selection: Record<string, unknown>,
    intents: QueueIntent[],
    tx: Transaction<DB>,
  ): Promise<{ runId: string; inserted: number }> {
    await sql`insert into job_run(id, kind, selection, "enumerationDone")
      values (${id}::uuid, ${kind}, ${JSON.stringify(selection)}::text::jsonb, true)`.execute(tx);
    const inserted = await this.enqueue(intents, tx, id);
    if (inserted > 0 || intents.length === 0) return { runId: id, inserted };
    const [first] = intents;
    const key = first.options?.deduplication?.id ?? first.options?.jobId ?? null;
    const {
      rows: [live],
    } = await sql<{ runId: string | null }>`select "runId" from job where queue = ${first.queue}
      and "dedupKey" = ${key} and state in ${LIVE} limit 1`.execute(tx);
    if (!live?.runId) return { runId: id, inserted };
    await sql`delete from job_run r where r.id = ${id}::uuid
      and not exists (select 1 from job where "runId" = r.id)`.execute(tx);
    return { runId: live.runId, inserted };
  }

  /**
   * One keyset page of a selection, inserted as jobs of `intent.runId` (FL-1265: no manifest). `last` is the page's
   * last selected id, or null once the selection is exhausted. Identical requests coalesce into live jobs.
   */
  async insertSelectionPage(
    intent: QueueIntent,
    selection: SelectQueryBuilder<any, any, { id: string }>,
    after: string | null,
    limit: number,
    tx: Transaction<DB>,
  ): Promise<{ inserted: number; last: string | null }> {
    if (!intent.runId) throw new Error('A selection page belongs to a run');
    await sql`insert into job_queue(name) values (${intent.queue}) on conflict do nothing`.execute(tx);
    await sql`select id from job_run where id = ${intent.runId}::uuid and selection ? 'holds' for share`.execute(tx);
    const kind = typeof intent.data.kind === 'string' ? intent.data.kind : 'all';
    // Same item identity as `JobRepository.intent` gives one queued item.
    const itemKey =
      intent.name === JobName.SmartAlbumReevaluate
        ? sql<string>`s.id::text || ${`/${intent.name}:`}::text || s.id::text || ${`:${kind}`}::text`
        : intent.name === JobName.FacialRecognition && intent.data.deferred
          ? sql<string>`s.id::text || '/deferred'`
          : sql<string>`s.id::text`;
    const dedupKey =
      intent.name === JobName.SmartAlbumReevaluate
        ? sql<string>`${`${intent.name}:`}::text || s.id::text || ${`:${kind}`}::text`
        : // A row's own data (a pet run's id) is part of the request: a restarted run must not coalesce into the old one.
          sql<string>`${`sel:${intent.name}:`}::text || ${itemKey} || ${`:${createHash('sha1').update(canonicalJson(intent.data)).digest('hex')}`}::text
            || coalesce(':' || md5((s."row"->'data')::text), '')`;
    const {
      rows: [page],
    } = await sql<{ selected: number; inserted: number; last: string | null }>`with page as materialized (
        select s.id, to_jsonb(s) "row" from (${selection}) s ${after === null ? sql`` : sql`where s.id > ${after}`}
        order by s.id limit ${limit}
      ), inserted as (
        insert into job(id, queue, name, data, "dedupKey", "safeToRetry", sensitive, "deadlineMs", "availableAt",
          "runId", "itemKey", "rootItemKey")
        select gen_random_uuid(), ${intent.queue}, ${intent.name},
          ${JSON.stringify(intent.data)}::text::jsonb || coalesce(s."row"->'data', '{}'::jsonb) || jsonb_build_object('id', s.id),
          ${dedupKey}, ${intent.safeToRetry}, ${intent.sensitive}, ${intent.deadlineMs},
          ${availability(sql`${intent.runId}::uuid`, sql`${intent.name}::text`)}, ${intent.runId}::uuid, ${itemKey},
          coalesce(s."row"->>'rootItemKey', s.id::text)
        from page s
        ${
          isProcessingFailureStep(intent.name)
            ? sql`where not ${processingIsSetAside(
                sql`case when pg_input_is_valid(s.id::text, 'uuid') then s.id::text::uuid end`,
                sql`${intent.name}`,
                sql`${intent.data.includeSetAside === true}::boolean`,
              )}`
            : sql``
        }
        order by s.id
        on conflict do nothing returning 1
      ) select (select count(*) from page)::int selected, (select count(*) from inserted)::int inserted,
        (select id::text from page order by id desc limit 1) last`.execute(tx);
    if (page.inserted > 0) {
      await sql`update job_run set "finishedAt" = null where id = ${intent.runId}::uuid`.execute(tx);
      this.wake();
    }
    return { inserted: page.inserted, last: page.selected < limit ? null : page.last };
  }

  /** A run finishes once its enumeration is done and no live job remains (`finishRuns`). */
  async finishEnumeration(runId: string, db: Executor = this.db) {
    await sql`update job_run set "enumerationDone" = true where id = ${runId}::uuid`.execute(db);
  }

  /**
   * FL-1265 claim: one short transaction per queue. No hold predicate: held jobs wait at `availableAt = 'infinity'`,
   * the end of the claim index, and are never read.
   */
  async claim(queue: string, workerId: string, maxClaims = QUEUE_BATCH): Promise<QueueClaim[]> {
    if (!Number.isSafeInteger(maxClaims) || maxClaims <= 0) return [];
    // The partial index keeps this empty probe independent of the remaining media backlog.
    const { rows: cancelled } = await sql<{ id: string }>`select id from job where queue = ${queue}
      and state in ('pending','waiting') and "cancelRequestedAt" is not null
      and "cancelReason" is distinct from 'deadline' order by "createdAt", id limit ${QUEUE_BATCH}`.execute(this.db);
    for (const { id } of cancelled) {
      await this.fail({ id, queue, token: null }, 'Job cancellation requested', undefined, {
        queuedCancellation: true,
      });
    }
    return this.db.transaction().execute(async (tx) => {
      const {
        rows: [config],
      } = await sql<{ paused: boolean; concurrency: number; closed: boolean }>`
        select paused, concurrency, coalesce("closedUntil" > now(), false) closed from job_queue
        where name = ${queue} for no key update skip locked`.execute(tx);
      if (!config) {
        return [];
      }
      // Started by hand (Start now, Run on one item): claimed first, even while the task is paused, closed or full.
      const byHand = await this.claimPending(tx, queue, workerId, Math.min(QUEUE_BATCH, maxClaims), true);
      if (config.paused || config.closed || byHand.length >= maxClaims) {
        return byHand;
      }
      const {
        rows: [{ active }],
      } = await sql<{ active: number }>`select count(*)::int active from job
        where queue = ${queue} and state = 'active'`.execute(tx);
      // The ones started by hand already count as active.
      const capacity = Math.min(QUEUE_BATCH - byHand.length, maxClaims - byHand.length, config.concurrency - active);
      if (capacity <= 0) {
        return byHand;
      }
      return [...byHand, ...(await this.claimPending(tx, queue, workerId, capacity, false))];
    });
  }

  /**
   * Claims up to `limit` jobs of one queue in claim order; `byHand` takes only the ones started by hand
   * (`startNow`). The page is made active and audited before any claim reaches an executor.
   */
  private async claimPending(
    tx: Transaction<DB>,
    queue: string,
    workerId: string,
    limit: number,
    byHand: boolean,
  ): Promise<QueueClaim[]> {
    if (limit <= 0) {
      return [];
    }
    const { rows: picked } = await sql<QueueClaim & { state: string }>`
      with candidates as materialized (
        select j.id, (${queuedProcessingIsSetAside}) as "setAside" from job j
        where queue = ${queue} and state in ('pending','waiting')
          and ${byHand ? sql`"availableAt" = ${STARTED_BY_HAND}` : sql`"availableAt" <= now()`}
          and ("cancelRequestedAt" is null or "cancelReason" = 'deadline')
          and ("parentId" is null or exists (select 1 from job p where p.id = j."parentId" and p.state = 'completed'))
        order by "availableAt", "createdAt", id limit ${limit} for update skip locked
      )
      update job j set state = case when c."setAside" then 'blocked' else 'active' end,
        token = case when not c."setAside" then gen_random_uuid() end,
        "workerId" = case when not c."setAside" then ${workerId}::uuid end,
        attempt = case when c."setAside" then attempt else attempt + 1 end,
        "startedAt" = case when c."setAside" then j."startedAt" else now() end,
        "progressAt" = now(), "progressUnits" = 0,
        "finishedAt" = case when c."setAside" then now() end,
        error = case when c."setAside" then 'Processing set aside' end,
        "leaseExpiresAt" = case when not c."setAside" then now() + interval '60 seconds' end,
        "cancelRequestedAt" = null, "cancelReason" = null, "dependencyReason" = null
      from candidates c where j.id = c.id
      returning j.id, queue, name, data, token, "workerId", attempt, "runId", "itemKey",
        "rootItemKey", "deadlineMs", "startedAt", "safeToRetry", state
    `.execute(tx);
    await this.settleDependencies(
      tx,
      picked.filter(({ state }) => state === 'blocked').map(({ id }) => id),
    );
    const rows = picked.filter(({ state }) => state === 'active').map(({ state: _, ...claim }) => claim);
    if (rows.length > 0) {
      await sql`insert into job_attempt("jobId", attempt, token, "workerId")
          select id, attempt, token, "workerId" from job where id = any(${rows.map((claim) => claim.id)}::uuid[])`.execute(
        tx,
      );
    }
    return rows;
  }

  /**
   * Start now (approved design, 2026-11-04): one pending job goes straight to the front and is claimed at the next
   * pass, even while its task is paused, closed or running as many as it may. Its dependencies and holds still
   * apply. False when the job is not waiting to run in this queue.
   */
  async startNow(queue: string, jobId: string): Promise<boolean> {
    const { rows } = await sql<{ id: string }>`update job j set "availableAt" = ${STARTED_BY_HAND}
      where id = ${jobId}::uuid and queue = ${queue} and state in ('pending','waiting') and "availableAt" <> ${HELD}
        and ("cancelRequestedAt" is null or "cancelReason" = 'deadline')
        and ("parentId" is null or exists (select 1 from job p where p.id = j."parentId" and p.state = 'completed'))
      returning id`.execute(this.db);
    if (rows.length > 0) {
      this.wake();
    }
    this.forgetRunReads();
    return rows.length > 0;
  }

  async heartbeat(workerId: string, claims: Array<{ id: string; token: string }>) {
    await this.db.transaction().execute(async (tx) => {
      await sql`update job_worker set "heartbeatAt" = now() where id = ${workerId}::uuid`.execute(tx);
      // A publication fence must not delay other leases; retry its locked claim on the next heartbeat.
      await sql`with renewable as materialized (
        select j.id from job j
        join jsonb_to_recordset(${JSON.stringify(claims)}::text::jsonb) as owned(id uuid, token uuid)
          on j.id = owned.id and j.token = owned.token
        where j.state = 'active' and j."workerId" = ${workerId}::uuid
          and j."leaseExpiresAt" > clock_timestamp()
        for no key update of j skip locked
      ) update job j set "leaseExpiresAt" = now() + interval '60 seconds'
        from renewable where j.id = renewable.id and j."leaseExpiresAt" > clock_timestamp()`.execute(tx);
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

  /**
   * Adoption callback and follow-up intents share the token-fenced commit. No I/O here. FL-1265: it locks only its own
   * job row, then domain rows; completions run side by side (the caller retries a lost deadlock).
   */
  async complete(claim: QueueClaim, followups: QueueIntent[], adopt?: (tx: Transaction<DB>) => Promise<void>) {
    return this.db.transaction().execute(async (tx) => {
      const {
        rows: [job],
      } = await sql<{ latestPending: QueueIntent | null }>`
        select "latestPending" from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid
        and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null for update`.execute(
        tx,
      );
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
      await clearProcessingFailure(tx, claim.name, claim.data.id);
      await this.enqueueFollowups(claim, followups, tx);
      await this.scheduleLatest(claim.id, job.latestPending, tx);
      return true;
    });
  }

  /** A follow-up without a run of its own joins the claim's run and root (`JobRepository.intent` already does). */
  async enqueueFollowups(
    claim: Pick<QueueClaim, 'id' | 'runId' | 'itemKey' | 'rootItemKey'>,
    followups: QueueIntent[],
    tx: Executor,
  ) {
    const inherited = followups.map((intent) =>
      intent.runId || !claim.runId
        ? intent
        : {
            ...intent,
            runId: claim.runId,
            rootItemKey: intent.rootItemKey ?? claim.rootItemKey ?? null,
            itemKey:
              intent.itemKey ??
              String(
                intent.data.id ??
                  intent.data.assetId ??
                  createHash('sha256').update(JSON.stringify(intent.data)).digest('hex'),
              ),
          },
    );
    await this.enqueue(inherited, tx, claim.runId);
  }

  /**
   * FL-721: runs these deferred jobs now instead of at the end of their wait, when they still wait for
   * the reason they were deferred for (a key that has just been loaded). Returns how many it woke.
   */
  async wakeDeferred(ids: string[], reason: JobDependencyReason) {
    if (ids.length === 0) return 0;
    const { rows } = await sql`update job set "availableAt" = now()
      where id = any(${ids}::uuid[]) and state = 'pending' and "dependencyReason" = ${reason}
        and "availableAt" > now() and "availableAt" <> ${HELD} returning id`.execute(this.db);
    // claim loops run them now, not at their next scan
    if (rows.length > 0) this.wake();
    return rows.length;
  }

  /** A dependency refusal is not an execution failure. Keep the item and audit, refund its retry credit. */
  async defer(claim: QueueClaim, reason: JobDependencyReason) {
    return this.db.transaction().execute(async (tx) => {
      const { rows } = await sql`update job set state = 'pending', token = null, "leaseExpiresAt" = null,
        "workerId" = null, "cancelRequestedAt" = null, "cancelReason" = null, "finishedAt" = null, error = null,
        "retryBaseAttempt" = "retryBaseAttempt" + 1, "dependencyReason" = ${reason},
        "availableAt" = clock_timestamp() + ${deferralDelay(reason)}
        where id = ${claim.id}::uuid and token = ${claim.token}::uuid and state = 'active'
          and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null returning id`.execute(tx);
      if (rows.length === 0) return false;
      await sql`update job_attempt set outcome = 'deferred', "finishedAt" = clock_timestamp(), error = ${reason}
        where token = ${claim.token}::uuid`.execute(tx);
      return true;
    });
  }

  async fail(
    claim: Pick<QueueClaim, 'id' | 'queue'> & { token: string | null },
    reason: string,
    diagnostic?: (tx: Transaction<DB>) => Promise<void>,
    options: {
      expiredRecovery?: boolean;
      stopRequestedOnly?: boolean;
      queuedCancellation?: boolean;
      interrupted?: boolean;
      settlements?: QueueExecution['failureSettlements'];
    } = {},
  ) {
    return this.db.transaction().execute(async (tx) => {
      const owned = options.queuedCancellation
        ? sql`queue = ${claim.queue} and state in ('pending','waiting') and token is null and "cancelRequestedAt" is not null
              and "cancelReason" is distinct from 'deadline'`
        : sql`token = ${claim.token}::uuid and state = 'active'
              and (${!options.expiredRecovery} or "leaseExpiresAt" <= clock_timestamp())`;
      // Unknown/legacy causes are explicit requests: ambiguity must never authorize a replay.
      const {
        rows: [job],
      } = await sql<{
        stopped: boolean;
        graceElapsed: boolean;
        stopRequested: boolean;
        cancelled: boolean;
        safeToRetry: boolean;
        retryAvailable: boolean;
        operationId: string | null;
        name: string;
        assetId: string | null;
        includeSetAside: boolean;
      }>`select j.name, j.data->>'id' as "assetId",
          coalesce(j.data->'includeSetAside' = 'true'::jsonb, false) as "includeSetAside", data->>'operationId' "operationId", "safeToRetry", attempt < "retryBaseAttempt" + 2 "retryAvailable",
          "leaseExpiresAt" <= clock_timestamp() - interval '30 seconds' "graceElapsed",
          "cancelRequestedAt" is not null "stopRequested",
          ("cancelRequestedAt" is not null and "cancelReason" is distinct from 'deadline') cancelled,
          ${
            options.queuedCancellation
              ? stoppedJobAttempts
              : sql`(exists (select 1 from system_metadata m
            where m.key = 'frameleaf-attempt-evidence:' || j.token::text
              and m.value->>'jobId' = j.id::text and m.value ? 'stoppedAt')
          or exists (select 1 from system_metadata m
            where m.key = 'frameleaf-worker-stopped:' || j."workerId"::text
              and m.value->>'workerId' = j."workerId"::text and m.value ? 'stoppedAt'))`
          } stopped
          from job j where id = ${claim.id}::uuid and ${owned} for update`.execute(tx);
      if (!job || (options.stopRequestedOnly && !job.stopRequested)) return false;
      // A domain retry may not outlive an unconfirmed executor. Leave this claim to recovery
      // when the handler's bounded proof write failed; terminal queue state alone is not proof.
      if (options.settlements?.length && !job.stopped) return false;
      let unconfirmedStop = false;
      if (options.expiredRecovery || job.stopRequested) {
        // Allow one sweep after expiry for the supervisor's bounded proof write. Cancellation
        // and expiry already fence publication; neither alone permits another executor.
        if (!job.stopped && !job.graceElapsed && !options.queuedCancellation) {
          await sql`update job set "cancelRequestedAt" = coalesce("cancelRequestedAt", clock_timestamp()),
            "cancelReason" = case when "cancelRequestedAt" is null then 'deadline' else "cancelReason" end,
            error = 'Waiting for confirmation that the executor has stopped'
            where id = ${claim.id}::uuid`.execute(tx);
          return false;
        }
        unconfirmedStop = !job.stopped;
      }
      // Audited repeatable work (thumbnails, ML, metadata) publishes only under its claim token, which this
      // update revokes, so a second run is safe even if the old executor never confirmed its stop (e.g. the
      // container was replaced mid-job). It keeps its normal retry budget. Cancelled, operation-owned and
      // unclassified work still waits for a person: its effects may not be repeatable.
      const unconfirmedAttention = unconfirmedStop && (job.cancelled || !job.safeToRetry || !!job.operationId);
      if (unconfirmedAttention) {
        reason = 'Executor stop could not be confirmed; review the worker before retrying';
      } else if (unconfirmedStop) {
        // Same budget as the state chosen below: another attempt is scheduled, or the job fails and waits for retry.
        reason = job.retryAvailable
          ? 'Interrupted before it finished (for example by a restart); it is retried automatically'
          : 'Interrupted before it finished (for example by a restart) and out of automatic retries; retry failed jobs to run it again';
      }
      const operationId =
        options.expiredRecovery || (options.queuedCancellation && unconfirmedStop) ? job.operationId : null;
      if (job.cancelled && !unconfirmedStop) reason = 'Job cancellation requested';
      if (diagnostic && !job.stopRequested) {
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
      const setAside =
        !job.cancelled &&
        !options.interrupted &&
        (await recordProcessingFailure(
          tx,
          job,
          reason,
          options.expiredRecovery ? 'crashed' : job.stopRequested ? 'timed-out' : undefined,
        ));
      const { rows } = await sql<{ id: string; state: QueueState; latestPending: QueueIntent | null }>`update job set
        state = case when ${unconfirmedAttention} then 'needs_attention' when ${job.cancelled} then 'cancelled'
          when not "safeToRetry" then 'needs_attention' when ${setAside} then 'failed' when attempt < "retryBaseAttempt" + 2 then 'pending' else 'failed' end,
        "availableAt" = now() + interval '30 seconds', "dependencyReason" = null, token = null, "leaseExpiresAt" = null,
        "finishedAt" = case when ${unconfirmedAttention} or ${job.cancelled} or ${setAside} or not "safeToRetry" or attempt >= "retryBaseAttempt" + 2 then now() else null end,
        error = case when sensitive then 'Job failed; sensitive details omitted' else ${reason.slice(0, 500)} end,
        data = case when sensitive then '{}'::jsonb else data end
        where id = ${claim.id}::uuid and ${owned}
        returning id, state, "latestPending"`.execute(tx);
      if (rows.length === 0) {
        return false;
      }
      await sql`update job_attempt set outcome = ${rows[0].state}, "finishedAt" = now(),
        error = (select error from job where id = ${claim.id}::uuid) where "jobId" = ${claim.id}::uuid
          and ${options.queuedCancellation ? sql`"finishedAt" is null` : sql`token = ${claim.token}::uuid`}`.execute(
        tx,
      );
      for (const settle of options.settlements ?? []) await settle(tx, reason, job.cancelled);
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
      if (rows[0].state !== 'pending') {
        const terminalParents = [claim.id];
        await sql`update job set "latestPending" = null where id = ${claim.id}::uuid`.execute(tx);
        // Work held for attention never replays its deferred request. Repeatable work that ran out of retries
        // on an unconfirmed stop schedules it like any other failure: publication is fenced by the revoked
        // claim token, and scheduleLatest still holds an unsafe request for attention.
        if (!unconfirmedAttention && !setAside) {
          terminalParents.push(...(await this.scheduleLatest(claim.id, rows[0].latestPending, tx, false)));
        }
        await this.settleDependencies(tx, terminalParents);
      }
      return true;
    });
  }

  /** Runs the request that arrived while this job ran. Returns the ids of requests it had to stop for attention. */
  private async scheduleLatest(
    previousId: string,
    latest: QueueIntent | null,
    tx: Executor,
    predecessorSucceeded = true,
  ) {
    if (!latest) {
      return [];
    }
    // A repeated item/stage in one run retains its row and monotonic attempt audit.
    const { rows } = await sql`update job set state = 'pending', data = ${JSON.stringify(latest.data)}::text::jsonb,
      "rootItemKey" = ${latest.rootItemKey ?? null}, "safeToRetry" = ${latest.safeToRetry}, sensitive = ${latest.sensitive}, "deadlineMs" = ${latest.deadlineMs},
      "availableAt" = ${intentAvailability(latest)},
      "retryBaseAttempt" = attempt, "finishedAt" = null, "cancelRequestedAt" = null, "cancelReason" = null, error = null,
      "workerId" = null, "latestPending" = null
      where id = ${previousId}::uuid and "runId" = ${latest.runId ?? null}::uuid
      and "itemKey" = ${latest.itemKey ?? null} and name = ${latest.name} returning id`.execute(tx);
    if (rows.length > 0) {
      await sql`update job_run set "finishedAt" = null where id = ${latest.runId ?? null}::uuid`.execute(tx);
    } else {
      // A fresh safe request is not a dependency on the predecessor's success.
      await this.enqueue([{ ...latest, parentId: latest.parentId === previousId ? undefined : latest.parentId }], tx);
    }
    if (predecessorSucceeded || latest.safeToRetry) {
      return [];
    }
    // An ambiguous external effect cannot be replayed via the latest-request back door.
    const key = latest.options?.deduplication?.id ?? latest.options?.jobId;
    const { rows: blocked } = await sql<{ id: string }>`update job set state = 'needs_attention', "finishedAt" = now(),
      error = 'Previous execution did not settle safely; review this request before rerunning',
      data = case when sensitive then '{}'::jsonb else data end
      where queue = ${latest.queue} and "dedupKey" = ${key ?? null} and state in ('pending','waiting') returning id`.execute(
      tx,
    );
    return blocked.map(({ id }) => id);
  }

  /** Only the coordinator observes persisted deadlines; no handler event-loop timer is trusted. */
  async deadlines(workerId: string) {
    const { rows } = await sql<{ id: string; token: string; cancelRequestedAt: Date | null }>`
      update job set "cancelRequestedAt" = coalesce("cancelRequestedAt", now()),
        "cancelReason" = case when "cancelRequestedAt" is null then 'deadline' else "cancelReason" end
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

  private async settleDependencies(tx: Executor, parentIds: string[]) {
    if (parentIds.length === 0) return;
    // Walk outward from this transaction's terminal parents, never all retained dependencies.
    await sql`with recursive blocked as (
      select c.id from job c join job p on p.id = c."parentId"
      where c."parentId" is not null and c."parentId" = any(${parentIds}::uuid[]) and c.state in ('pending','waiting')
        and p.state in ('failed','needs_attention','cancelled','blocked')
      union select c.id from job c join blocked b on c."parentId" = b.id
        where c."parentId" is not null and c.state in ('pending','waiting')
    ) update job set state = 'blocked', error = 'Dependency did not succeed', "finishedAt" = now()
      where id in (select id from blocked)`.execute(tx);
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
    if (!paused) this.wake();
    this.forgetRunReads();
  }

  async isPaused(name: string) {
    const { rows } = await sql<{ paused: boolean }>`select paused from job_queue where name = ${name}`.execute(this.db);
    return rows[0]?.paused ?? false;
  }

  /** The names of every paused queue, in one round trip. */
  async pausedQueues() {
    const { rows } = await sql<{ name: string }>`select name from job_queue where paused`.execute(this.db);
    return new Set(rows.map(({ name }) => name));
  }

  /** Scans that ended (also by domain recovery or cancellation, without a worker) may finish their runs. */
  async settleTerminalLibrarySources(): Promise<number> {
    const { rows } = await sql`update job_run r set "enumerationDone" = true where r.id in (
        select r.id from job_run r join media_operation o on o.id = r.id
        where r.kind = ${MediaOperationKind.LibraryScan} and not r."enumerationDone"
          and o.status in ('completed','failed','cancelled') limit ${QUEUE_BATCH})
      returning r.id`.execute(this.db);
    return rows.length;
  }

  /** FL-1265 quiet hours: nothing new is claimed from the queue until `closedUntil`; null opens it. */
  async setSchedule(name: string, closedUntil: Date | null) {
    await sql`insert into job_queue(name, "closedUntil") values (${name}, ${closedUntil})
      on conflict (name) do update set "closedUntil" = excluded."closedUntil"`.execute(this.db);
    if (!closedUntil) this.wake();
    this.forgetRunReads();
  }

  async getSchedule(name: string): Promise<Date | null> {
    const { rows } = await sql<{ closedUntil: Date | null }>`select "closedUntil" from job_queue
      where name = ${name} and "closedUntil" > now()`.execute(this.db);
    return rows[0]?.closedUntil ?? null;
  }

  async counts(name: string) {
    const steps = FOLLOW_UP_STEPS[name];
    const {
      rows: [row],
    } = await sql<{
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      waiting: number;
      paused: number;
      followUp?: number;
    }>`select ${steps ? sql`count(*) filter (where state in ('pending','waiting') and j.name = any(${steps}::text[]))::int "followUp",` : sql``}
      count(*) filter (where state = 'active')::int active,
      count(*) filter (where state = 'completed')::int completed,
      count(*) filter (where state in ('failed','needs_attention','blocked'))::int failed,
      count(*) filter (where state in ('pending','waiting') and "availableAt" > now() and "availableAt" <> ${HELD}
        and not j."operationPaused")::int delayed,
      count(*) filter (where state in ('pending','waiting') and "availableAt" <= now() and not q.paused
        and not coalesce(q."closedUntil" > now(), false) and not j."operationPaused")::int waiting,
      count(*) filter (where state in ('pending','waiting') and (j."operationPaused" or "availableAt" = ${HELD}
        or ("availableAt" <= now() and (q.paused or coalesce(q."closedUntil" > now(), false)))))::int paused
      from (${reportedQueueJobs(name)}) j join job_queue q on q.name = j.queue`.execute(this.db);
    return row;
  }

  async hasDedup(queue: string, key: string) {
    const { rows } = await sql`select 1 from job where queue = ${queue} and "dedupKey" = ${key}
      and state in ${LIVE} limit 1`.execute(this.db);
    return rows.length > 0;
  }

  private unfinished(queue: string, includeHeld: boolean) {
    // Individual edit retries can be delayed or paused before their next physical job exists.
    // Probe indexed operation kind/status, not retained failed queue history.
    const edits =
      queue === QueueName.Editor
        ? [JobName.AssetEditThumbnailGeneration, JobName.AssetDevelopRender]
        : queue === QueueName.VideoConversion
          ? [JobName.AssetVideoEditGeneration]
          : [];
    const operations =
      edits.length > 0
        ? sql`or exists (select 1 from media_operation
            where kind='quick_edit' and status in ('queued','paused','preparing','rendering','validating','cancelling')
              and snapshot->>'executor'='job_queue' and snapshot->'job'->>'name'=any(${edits}::text[]))`
        : sql``;
    // Without held work: the earliest waiting job in claim order (`job_claim`) tells, one index row.
    const jobs = includeHeld
      ? sql`exists (select 1 from job where queue = ${queue} and state in ${LIVE})`
      : sql`(exists (select 1 from job where queue = ${queue} and state = 'active')
          or coalesce((select "availableAt" from job where queue = ${queue} and state in ('pending','waiting')
            order by "availableAt" limit 1) < ${HELD}, false))`;
    return sql<boolean>`(${jobs} ${operations})`;
  }

  /** Paused work counts; held work counts only with `includeHeld`. */
  async hasUnfinishedWork(queue: string, includeHeld = true) {
    const {
      rows: [row],
    } = await sql<{ unfinished: boolean }>`select ${this.unfinished(queue, includeHeld)} unfinished`.execute(this.db);
    return row.unfinished;
  }

  /** Which of these queues have unfinished work, in one round trip. */
  async queuesWithUnfinishedWork(queues: readonly string[], includeHeld = true) {
    if (queues.length === 0) return [];
    const { rows } = await sql<{ queue: string }>`${sql.join(
      queues.map((queue) => sql`select ${queue}::text queue where ${this.unfinished(queue, includeHeld)}`),
      sql` union all `,
    )}`.execute(this.db);
    return rows.map(({ queue }) => queue);
  }

  /** Activity and the running-jobs summary poll this; a costly recount is shared and not repeated at once. */
  private readonly runReads = costReusedRead(
    ({ take, skip, foldNightly }: { take: number; skip: number; foldNightly: boolean }) =>
      listRuns(this.db, take, skip, foldNightly),
  );

  listRuns(take: number, skip: number, foldNightly = false) {
    return this.runReads({ take, skip, foldNightly });
  }

  /** A run's page polls this; an unfinished run is recounted from its jobs, so it is shared like `listRuns`. */
  private readonly singleRunReads = costReusedRead((runId: string) => getRun(this.db, runId));

  getRun(runId: string) {
    return this.singleRunReads(runId);
  }

  /**
   * After a pause, start, retry or cancel, Activity's next read is fresh, never a count from before the change. Called
   * once the change is committed; a caller that writes in its own transaction (`retryRun`) calls it after.
   */
  forgetRunReads() {
    this.runReads.clear();
    this.singleRunReads.clear();
    this.queueRunReads.clear();
  }

  listRunItems(runId: string, take: number, skip: number) {
    return listRunItems(this.db, runId, take, skip);
  }

  /**
   * The running-jobs summary reads every queue each time any tab polls it; on a large backlog one queue took
   * 0.3-1.7 s and spilled to disk. A read over 250 ms is reused for ten times as long as it took.
   */
  private readonly queueRunReads = costReusedRead((name: string) => observeQueueRun(this.db, name), {
    minCostMs: 250,
    // an idle queue is never kept: the summary leaves idle queues out, so work started next would stay hidden
    reusable: (run) => run.active + run.waiting > 0,
  });

  observeQueueRun(name: string) {
    return this.queueRunReads(name);
  }

  /** Tasks per stage of a run, and how many of them ended. */
  async runStageProgress(runId: string) {
    const { rows } = await sql<{ name: string; total: number; done: number }>`select name, count(*)::int total,
      count(*) filter (where state not in ${LIVE})::int done
      from job where "runId" = ${runId}::uuid group by name order by name`.execute(this.db);
    return rows;
  }

  /** Whether the run still has live work; `ignoreParked` leaves out jobs held because their stage is parked. */
  async runHasLiveWork(runId: string, options: { ignoreParked?: boolean } = {}, db: Executor = this.db) {
    const {
      rows: [row],
    } = await sql<{ live: boolean }>`select exists (select 1 from job j where j."runId" = ${runId}::uuid
      and j.state in ${LIVE}
      ${
        options.ignoreParked
          ? sql`and not (j."availableAt" = ${HELD} and exists (select 1 from job_run r where r.id = j."runId"
              and r.selection->'holds'->>j.name = 'parked'))`
          : sql``
      }) live`.execute(db);
    return row.live;
  }

  /**
   * FL-1265: writes a run's holds descriptor. The coordinator then moves its pending jobs to and from
   * `availableAt = 'infinity'` in batches (`reconcileHolds`). Releasing a parked stage reopens a finished run.
   */
  async setRunHolds(runId: string, holds: RunHolds, db: Executor) {
    const {
      rows: [run],
    } = await sql<{ holds: RunHolds | null }>`select selection->'holds' holds from job_run
      where id = ${runId}::uuid for update`.execute(db);
    if (!run) return;
    const previous = run.holds ?? {};
    const next = Object.fromEntries(Object.entries(holds).filter(([, reason]) => reason));
    if (run.holds && canonicalJson(previous) === canonicalJson(next)) return;
    const reopen = Object.entries(previous).some(([stage, reason]) => reason === 'parked' && next[stage] !== 'parked');
    await sql`update job_run set selection = (selection - 'holdsCursor')
        || jsonb_build_object('holds', ${JSON.stringify(next)}::text::jsonb, 'holdsDirty', true)
        ${reopen ? sql`, "finishedAt" = null` : sql``}
      where id = ${runId}::uuid`.execute(db);
    this.wake();
  }

  /** Release every hold of a run (Jobs → Release). An import is released only once its journal is activated. */
  async releaseRun(runId: string): Promise<'released' | 'not_held' | 'import_not_activated' | 'not_found'> {
    const result = await this.db.transaction().execute(async (tx) => {
      const {
        rows: [run],
      } = await sql<{ kind: string; holds: RunHolds | null; held: boolean; activated: boolean }>`select r.kind,
          r.selection->'holds' holds,
          exists (select 1 from job j where j."runId" = r.id and j.state in ('pending','waiting')
            and j."availableAt" = ${HELD}) held,
          case r.kind
            when 'immich-import-derived' then exists (select 1 from frameleaf_immich_import where status = 'activated')
            when 'library-import-derived' then exists (select 1 from frameleaf_library_import where status = 'activated')
            else true end activated
        from job_run r where r.id = ${runId}::uuid for update`.execute(tx);
      if (!run) return 'not_found' as const;
      if (Object.keys(run.holds ?? {}).length === 0 && !run.held) return 'not_held' as const;
      if (!run.activated) return 'import_not_activated' as const;
      await sql`update job_run set "finishedAt" = null, selection = (selection - 'holdsCursor' - 'authorityHeld')
          || jsonb_build_object('holds', '{}'::jsonb, 'holdsDirty', true, 'releasedAt', now())
        where id = ${runId}::uuid`.execute(tx);
      this.wake();
      return 'released' as const;
    });
    this.forgetRunReads();
    return result;
  }

  /**
   * Coordinator: applies changed holds descriptors to pending jobs, one keyset page of a run's jobs per statement,
   * for up to `budgetMs`. A changed descriptor restarts its run's pass. Returns how many jobs changed.
   */
  async reconcileHolds(budgetMs: number): Promise<number> {
    const start = performance.now();
    let changed = 0;
    while (performance.now() - start < budgetMs) {
      const {
        rows: [run],
      } = await sql<{ id: string; holds: RunHolds | null; itemKey: string | null; name: string | null }>`select id,
          selection->'holds' holds, selection #>> '{holdsCursor,itemKey}' "itemKey", selection #>> '{holdsCursor,name}' name
        from job_run where selection->>'holdsDirty' = 'true' order by "createdAt", id limit 1`.execute(this.db);
      if (!run) break;
      const holds = run.holds ?? {};
      const held = Object.keys(holds);
      const {
        rows: [page],
      } = await sql<{
        selected: number;
        changed: number;
        released: number;
        itemKey: string | null;
        name: string | null;
      }>`
        with page as materialized (
          select id, "itemKey", name from job where "runId" = ${run.id}::uuid
            ${run.itemKey === null ? sql`` : sql`and ("itemKey", name) > (${run.itemKey}, ${run.name})`}
          order by "itemKey", name limit ${HOLD_PAGE}
        ), held as (
          update job j set "availableAt" = ${HELD} from page p where j.id = p.id and j.state in ('pending','waiting')
            and j.name = any(${held}::text[]) and j."availableAt" <> ${HELD} returning 1
        ), released as (
          update job j set "availableAt" = now() from page p where j.id = p.id and j.state in ('pending','waiting')
            and not (j.name = any(${held}::text[])) and j."availableAt" = ${HELD} returning 1
        ), last as (select "itemKey", name from page order by "itemKey" desc, name desc limit 1)
        select (select count(*) from page)::int selected,
          ((select count(*) from held) + (select count(*) from released))::int changed,
          (select count(*) from released)::int released,
          (select "itemKey" from last) "itemKey", (select name from last) name`.execute(this.db);
      changed += page.changed;
      const done = page.selected < HOLD_PAGE || page.itemKey === null;
      // Written only while the descriptor is the one this page applied; a newer one starts its own pass.
      await sql`update job_run set selection = ${
        done
          ? sql`selection - 'holdsDirty' - 'holdsCursor'`
          : sql`jsonb_set(selection, '{holdsCursor}', jsonb_build_object('itemKey', ${page.itemKey}::text, 'name', ${page.name}::text))`
      } where id = ${run.id}::uuid and coalesce(selection->'holds', '{}'::jsonb) = ${JSON.stringify(holds)}::text::jsonb`.execute(
        this.db,
      );
      if (page.released > 0) this.wake();
    }
    if (changed > 0) this.forgetRunReads();
    return changed;
  }

  /**
   * `entityIds` narrows the clear to the jobs about those items (their `data.id`), e.g. removed assets.
   * FL-1265: a whole-queue clear (Empty) keeps held jobs; they belong to a run that has not been released yet.
   */
  async clear(queue: string, states: QueueState[], entityIds?: string[]) {
    if (entityIds?.length === 0) return;
    const about = entityIds
      ? sql`and j.data ->> 'id' = any(${entityIds}::text[])`
      : sql`and j."availableAt" <> ${HELD}`;
    await this.cancel(queue, states, about);
    this.forgetRunReads();
  }

  /** Cancel one queued job by its `options.jobId`; a later request for its run stage re-arms the same row. */
  async cancelQueued(queue: string, externalId: string) {
    await this.cancel(queue, ['pending', 'waiting'], sql`and j."externalId" = ${externalId}`);
    this.forgetRunReads();
  }

  private async cancel(queue: string, states: QueueState[], about: RawBuilder<unknown>) {
    // Keep dependency history. Clearing hides payloads and cancels pending work.
    await this.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{ id: string }>`update job j set state = 'cancelled', data = '{}'::jsonb,
        "latestPending" = null, "finishedAt" = now() where j.queue = ${queue} and j.state = any(${states}::text[])
        and j.state != 'active' ${about} returning id`.execute(tx);
      await this.settleDependencies(
        tx,
        rows.map((item) => item.id),
      );
    });
  }

  /**
   * Puts a run's failed and blocked repeatable work back (the import Retry): its own failures, and blocked work whose
   * parent can run again. Never replays cancelled, operation-owned or unsafe work. The run's holds still apply.
   */
  async retryRun(runId: string, db: Executor): Promise<number> {
    return (await this.putBackRunWork(runId, db)).jobs;
  }

  /** `retryRun`, of only the photos (roots) `roots` when given; returns how many jobs and photos went back. */
  private async putBackRunWork(runId: string, db: Executor, roots?: string[]) {
    let total = 0;
    const photos = new Set<string>();
    for (;;) {
      const { rows } = await sql<{ id: string; root: string | null }>`WITH RECURSIVE eligible AS (
        SELECT j.id,j."parentId",j.state FROM job j
        WHERE j."runId"=${runId}::uuid AND j."safeToRetry" AND j.data->>'operationId' IS NULL
          ${roots ? sql`AND j."rootItemKey" = any(${roots}::text[])` : sql``}
          AND j.state IN ('failed','blocked') AND NOT (${queuedProcessingIsSetAside})
          AND (j."dedupKey" IS NULL OR NOT EXISTS (
            SELECT 1 FROM job d WHERE d.queue=j.queue AND d."dedupKey"=j."dedupKey" AND d.id<>j.id
              AND (d.state IN ('pending','waiting','active') OR (d.state IN ('failed','blocked')
                AND (d."createdAt",d.id)<(j."createdAt",j.id)))))
      ), recoverable AS (
        SELECT e.id FROM eligible e WHERE (e.state='failed' AND e."parentId" IS NULL) OR EXISTS (
          SELECT 1 FROM job p WHERE p.id=e."parentId" AND p.state IN ('pending','waiting','active','completed'))
        UNION SELECT e.id FROM eligible e JOIN recoverable p ON p.id=e."parentId"
      ) UPDATE job j SET state='pending',"availableAt"=${availability(sql`j."runId"`, sql`j.name`)},"finishedAt"=NULL,error=NULL,
        "retryBaseAttempt"=attempt,"cancelRequestedAt"=NULL,"cancelReason"=NULL
        WHERE id IN (SELECT id FROM recoverable LIMIT 1000) RETURNING id, "rootItemKey" root`.execute(db);
      total += rows.length;
      for (const { root } of rows) if (root) photos.add(root);
      if (rows.length < 1000) break;
    }
    if (total > 0) {
      await sql`UPDATE job_run SET "finishedAt"=NULL WHERE id=${runId}::uuid`.execute(db);
      this.wake();
    }
    return { jobs: total, photos: photos.size };
  }

  /**
   * FL-1349 Try again now: one cause's left-over photos (stopped ones aside) go back, their processing failures
   * re-armed first (set aside work is never put back otherwise). Returns how many photos went back, or undefined for
   * an unknown run.
   */
  async retryRunFailures(runId: string, cause: RunFailureCause): Promise<number | undefined> {
    const photos = await this.db.transaction().execute(async (tx) => {
      const {
        rows: [run],
      } = await sql`select id from job_run where id = ${runId}::uuid for no key update`.execute(tx);
      if (!run) return;
      const roots = await runFailureRoots(tx, runId, cause);
      if (roots.length === 0) return 0;
      await sql`update asset_processing_failure f set "quarantinedAt" = null, attempts = 0 from job j
        where j."runId" = ${runId}::uuid and j."rootItemKey" = any(${roots}::text[]) and j.state = 'failed'
          and f."assetId" = case when pg_input_is_valid(j.data->>'id', 'uuid') then (j.data->>'id')::uuid end
          and f.step = j.name and f."dismissedAt" is null`.execute(tx);
      const { photos } = await this.putBackRunWork(runId, tx, roots);
      await rewriteFailureCauses(tx, runId);
      return photos;
    });
    if (photos !== undefined) this.forgetRunReads();
    return photos;
  }

  /**
   * FL-1349 Stop trying: the processing steps (`processingFailureSteps`) that failed on one cause's left-over photos
   * are dismissed, so nightly reprocessing selects them no more. Their jobs stay failed: history and the per-photo
   * list are kept. Returns how many photos were stopped, or undefined for an unknown run.
   */
  async stopRunFailures(runId: string, cause: RunFailureCause): Promise<number | undefined> {
    const photos = await this.db.transaction().execute(async (tx) => {
      const {
        rows: [run],
      } = await sql`select id from job_run where id = ${runId}::uuid for no key update`.execute(tx);
      if (!run) return;
      const roots = await runFailureRoots(tx, runId, cause);
      if (roots.length === 0) return 0;
      // a fixed cause, never exception text (`recordProcessingFailure`)
      const lastError = cause === 'unsupported' ? 'unsupported' : 'unreadable';
      // keyed by what each task works on (`data.id`), as the set-aside checks are; counted by photo (root)
      const {
        rows: [stopped],
      } = await sql<{ photos: number }>`with picked as (
          select distinct j."rootItemKey" root, a.id "assetId", j.name step from job j join asset a
            on a.id = case when pg_input_is_valid(j.data->>'id', 'uuid') then (j.data->>'id')::uuid end
          where j."runId" = ${runId}::uuid and j."rootItemKey" = any(${roots}::text[])
            and j.state in ('failed','needs_attention') and j.name = any(${[...processingFailureSteps]}::text[])
        ), written as (
          insert into asset_processing_failure as f ("assetId", step, attempts, "lastError", "lastFailedAt", "dismissedAt")
          select distinct "assetId", step, 1, ${lastError}::text, clock_timestamp(), clock_timestamp() from picked
          on conflict ("assetId", step) do update set "dismissedAt" = coalesce(f."dismissedAt", excluded."dismissedAt")
          returning 1
        ) select (select count(distinct root) from picked)::int photos, (select count(*) from written) "written"`.execute(
        tx,
      );
      await rewriteFailureCauses(tx, runId);
      return stopped.photos;
    });
    if (photos !== undefined) this.forgetRunReads();
    return photos;
  }

  /**
   * The job of this name already running on one item or, with none running, the newest one still
   * waiting to run on it (FL-1249: Run on one item counts a running job as started).
   */
  async findOpenJob(queue: string, name: string, itemId: string): Promise<{ id: string; active: boolean } | undefined> {
    const { rows } = await sql<{ id: string; active: boolean }>`select id, state = 'active' as active from job
      where queue = ${queue} and name = ${name} and state in ${LIVE} and data->>'id' = ${itemId}
      order by state = 'active' desc, "createdAt" desc, id desc limit 1`.execute(this.db);
    return rows[0];
  }

  /** Puts failed jobs back with their saved data: every one in the queue, or only `jobId`. */
  async retryFailed(queue: string, jobId?: string) {
    let total = 0;
    for (;;) {
      const count = await this.db.transaction().execute(async (tx) => {
        const { rows } = await sql<{ id: string; runId: string | null }>`update job j set state = 'pending',
          "availableAt" = ${availability(sql`j."runId"`, sql`j.name`)}, "finishedAt" = null, error = null,
          "retryBaseAttempt" = attempt
          where id in (
            select id from (select id, "dedupKey", row_number() over (partition by coalesce("dedupKey", id::text) order by "createdAt", id) ordinal
              from job j where queue = ${queue} and state = 'failed' and "safeToRetry"
                and not (${queuedProcessingIsSetAside})
                ${jobId ? sql`and id = ${jobId}::uuid` : sql``}) candidates
            where ordinal = 1 and (candidates."dedupKey" is null or not exists (
              select 1 from job d where d.queue = ${queue} and d."dedupKey" = candidates."dedupKey"
                and d.state in ('pending','waiting','active'))) limit 1000
          ) returning id, "runId"`.execute(tx);
        const runIds = [...new Set(rows.flatMap(({ runId }) => (runId ? [runId] : [])))];
        if (runIds.length > 0) {
          await sql`update job_run set "finishedAt" = null where id = any(${runIds}::uuid[])`.execute(tx);
        }
        if (rows.length > 0) this.wake();
        return rows.length;
      });
      total += count;
      if (count < 1000) {
        this.forgetRunReads();
        return total;
      }
    }
  }
}

/** Restore runs with all workers stopped. Only audited repeatable work retains its existing retry budget.
 * Operation-owned jobs are never resumed here; the media-operation dispatcher owns their retry.
 * Held jobs stay held: a hold is just their `availableAt`.
 */
export async function resetQueueAfterRestore(db: QueryExecutorProvider) {
  // Older dumps serialized this audited local job as unsafe. Its current handler publishes a
  // unique verified dump per attempt; retain the same one-retry budget and operation exclusions.
  const backup = sql`(name = ${JobName.DatabaseBackup} and queue = ${QueueName.BackupDatabase})`;
  const repeatable = sql`("safeToRetry" or ${backup}) and not (data ? 'operationId')`;
  // A restored dump already fulfilled its active backup invocation. Discard that transient
  // request without claiming handler success or manufacturing evidence that its executor stopped.
  const discardBackup = sql`(state = 'active' and ${backup} and not (data ? 'operationId'))`;
  const cancelled = sql`("cancelRequestedAt" is not null and "cancelReason" is distinct from 'deadline')`;
  await sql`update job_attempt a set outcome = case when ${discardBackup} then 'restored_discarded_backup' when ${cancelled} then
      case when ${stoppedJobAttempts} then 'restored_cancelled' else 'restored_needs_attention' end when ${repeatable}
      and j.attempt < j."retryBaseAttempt" + 2 then 'restored_retry' else 'restored_needs_attention' end,
      "finishedAt" = now() from job j where a."jobId" = j.id and a."finishedAt" is null`.execute(db);
  await sql`update job j set state = case when ${discardBackup} then 'cancelled' when ${cancelled} then
      case when ${stoppedJobAttempts} then 'cancelled' else 'needs_attention' end when ${repeatable}
        and attempt < "retryBaseAttempt" + 2 then 'pending' else 'needs_attention' end,
    "safeToRetry" = "safeToRetry" or (${backup} and not (data ? 'operationId')),
    token = null, "leaseExpiresAt" = null, "workerId" = null, "cancelRequestedAt" = null, "cancelReason" = null,
    "availableAt" = case when state != 'active' and "availableAt" = ${HELD} then "availableAt" else now() + interval '30 seconds' end,
    "latestPending" = null,
    "finishedAt" = case when not ${discardBackup} and not ${cancelled} and ${repeatable} and attempt < "retryBaseAttempt" + 2 then null else now() end,
    error = case when ${discardBackup} then 'Restore discarded the snapshot backup invocation'
      when ${cancelled} and not ${stoppedJobAttempts}
      then 'Executor stop could not be confirmed; review the worker before retrying'
      else 'Restore revoked the previous execution claim' end,
    data = case when sensitive then '{}'::jsonb else data end
    where state = 'active' or ((not "safeToRetry" or data ? 'operationId' or ${cancelled}) and state in ('pending','waiting'))`.execute(
    db,
  );
  await sql`update job_worker set state = 'lost'`.execute(db);
}
