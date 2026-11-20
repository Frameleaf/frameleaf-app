import { Injectable } from '@nestjs/common';
import { type Kysely, type Selectable, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import z from 'zod';
import { SystemMetadataKey } from 'src/enum.js';
import {
  type DesktopWorkerGrant,
  type DesktopWorkerTables,
  desktopHouseholdDevices,
  desktopWorkerAccountAllowed,
  lockDesktopWorker,
  lockDesktopWorkerForAdoption,
  readDesktopAssistancePolicy,
} from 'src/repositories/desktop-worker.repository.js';
import { DB } from 'src/schema/index.js';

export type { DesktopWorkerGrant } from 'src/repositories/desktop-worker.repository.js';
import { DesktopMlAttemptTable, DesktopMlTaskTable } from 'src/schema/tables/desktop-ml-task.table.js';
import { type DesktopQualificationTables } from 'src/schema/tables/desktop-worker-qualification.table.js';
import { desktopAccountPermitted, householdDevices } from 'src/utils/desktop-assistance-policy.js';
import { type DesktopMlDisclosure, desktopMlDisclosureSchema } from 'src/utils/desktop-ml-disclosure.js';
import { equivalentDesktopModelKeys } from 'src/utils/desktop-model-equivalents.js';
import {
  DESKTOP_CANCELS_PER_TASK,
  DESKTOP_CANCEL_WINDOW_SECONDS,
  DESKTOP_LEASE_SECONDS,
  DESKTOP_PRESENCE_SECONDS,
  DESKTOP_REQUALIFY_HOLD_SECONDS,
} from 'src/utils/desktop-worker-timing.js';
import { lockedAssetIdExists } from 'src/utils/locked.js';
import { canonicalJson } from 'src/utils/object.js';

export type DesktopMlTables = {
  desktop_ml_task: DesktopMlTaskTable;
  desktop_ml_attempt: DesktopMlAttemptTable;
};
type DesktopMlDatabase = DB & DesktopMlTables & DesktopWorkerTables & DesktopQualificationTables;
type Task = Selectable<DesktopMlTaskTable>;

/** FL-1484: `OR d.id IN (…)` for the computers that work on everyone's photos; nothing when there are none. */
const householdMatch = (devices: readonly string[]) =>
  devices.length > 0 ? sql`OR d.id IN (${sql.join(devices.map((id) => sql`${id}::uuid`))})` : sql``;
type Attempt = Selectable<DesktopMlAttemptTable>;
type TaskMetadata = Omit<Task, 'input'>;
const taskColumns = [
  'id',
  'ownerId',
  'modelKey',
  'authorityKey',
  'disclosure',
  'config',
  'configSha256',
  'inputSha256',
  'inputKind',
  'state',
  'generation',
  'attemptId',
  'result',
  'resultSha256',
  'createdAt',
  'deadlineAt',
] as const;
export type DesktopMlClaim = {
  task: Omit<Task, 'input'>;
  attempt: Attempt;
  /** The desktop's own qualification for this task: its id, and the model key the desktop holds the model under. */
  qualificationId: string;
  workerModelKey: string;
  qualificationExpiresAt: Date;
  /** The lease this desktop already held, returned again; not one made by this claim. */
  resumed: boolean;
};
export type DesktopFailureCode = 'inference-failed' | 'input-invalid' | 'model-unavailable' | 'cancelled';
export type DesktopMlRequest = Pick<Task, 'ownerId' | 'modelKey' | 'authorityKey' | 'config' | 'inputKind'> & {
  input: Buffer;
  deadlineAt: Date;
  disclosure?: DesktopMlDisclosure;
};
const jsonObject = z.record(z.string(), z.json());
const failuresSchema = z.record(
  z.string(),
  z.object({
    failures: z.number().int().min(0),
    at: z.iso.datetime(),
    heldUntil: z.iso.datetime().optional(),
    cancels: z.number().int().min(0).optional(),
    cancelsFrom: z.iso.datetime().optional(),
    cancelAt: z.iso.datetime().optional(),
    /** The newest lease of the model the desktop had when its last stop was counted (UTC, microseconds). */
    cancelLease: z.string().optional(),
  }),
);
/**
 * Per desktop and model: failures in a row and when the last one was counted, a hold after the model was
 * withdrawn, and the hand-backs (`cancelled`) in the current window with when the last one was counted.
 */
export type DesktopModelFailures = z.infer<typeof failuresSchema>;
const failureKey = (deviceId: string, modelKey: string) => `${deviceId}:${modelKey}`;
/**
 * The most desktop tasks open at once. Each holds its input (a preview image, at most 16 MB) in the
 * database until a desktop returns it. It was 32 when a desktop held one lease; with several leases per
 * desktop that would cap a few desktops at a handful of tasks each.
 * ponytail: a fixed bound; scale it with the desktops' total capacity if 256 is ever the limit in practice.
 */
export const MAX_OPEN_TASKS = 256;
/** The most input bytes open desktop tasks hold in the database together. One task always fits. */
export const MAX_OPEN_TASK_BYTES = 512 * 1024 * 1024;
/** The most tasks one desktop is ever given at once, whatever it asks for. */
export const MAX_DESKTOP_LEASES = 64;
/** The kind of work a model key names: `clip`, `face` or `ocr`. */
const workloadOf = (modelKey: string) => modelKey.split(':', 1)[0];
/** The queue each kind of desktop work comes from. */
const WORKLOAD_QUEUES: Record<string, string> = { clip: 'smartSearch', face: 'faceDetection', ocr: 'ocr' };
/** The Jobs concurrency setting of each kind of work's queue; 1 where the queue has no row yet. */
const queueLimits = async (db: Kysely<DesktopMlDatabase>): Promise<Record<string, number>> => {
  const { rows } = await sql<{ name: string; concurrency: number }>`
    SELECT name, concurrency FROM job_queue WHERE name=ANY(${Object.values(WORKLOAD_QUEUES)}::text[])`.execute(db);
  return Object.fromEntries(
    Object.entries(WORKLOAD_QUEUES).map(([workload, queue]) => [
      workload,
      Math.max(1, rows.find((row) => row.name === queue)?.concurrency ?? 1),
    ]),
  );
};
const capacitiesSchema = z.record(z.string(), z.object({ total: z.number().int().min(1), at: z.iso.datetime() }));
/** How many tasks each desktop said it can run at once; a desktop that never said holds one. */
const readCapacities = async (db: Kysely<DesktopMlDatabase>): Promise<z.infer<typeof capacitiesSchema>> => {
  const { rows } = await sql<{ value: unknown }>`SELECT value FROM system_metadata
    WHERE key=${SystemMetadataKey.FrameleafDesktopWorkerCapacity}`.execute(db);
  const parsed = capacitiesSchema.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : {};
};
/** How many of a queue's next jobs are looked at to see whose photos are coming up. */
const UPCOMING_JOBS = 64;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const leaseEnd = (deadline: Date, credentialExpiry: Date) =>
  sql<Date>`least(${deadline}, ${credentialExpiry}, clock_timestamp() + ${sql.raw(`interval '${DESKTOP_LEASE_SECONDS} seconds'`)})`;
const seenSince = sql.raw(`clock_timestamp() - interval '${DESKTOP_PRESENCE_SECONDS} seconds'`);
/** A task made for one key can be run under the same encoder's key of another desktop runtime revision. */
const sameModel = (taskModelKey: string, held: string) => equivalentDesktopModelKeys(taskModelKey).includes(held);

@Injectable()
export class DesktopMlRepository {
  private db: Kysely<DesktopMlDatabase>;

  constructor(@InjectKysely() db: Kysely<DB>) {
    this.db = db.withTables<DesktopMlTables & DesktopWorkerTables & DesktopQualificationTables>();
  }

  async create(request: DesktopMlRequest, maxOpenBytes = MAX_OPEN_TASK_BYTES): Promise<TaskMetadata> {
    if (request.input.length === 0 || request.input.length > 16 * 1024 * 1024)
      throw new Error('desktop_input_size_invalid');
    if (request.deadlineAt.getTime() <= Date.now() || request.deadlineAt.getTime() > Date.now() + 600_000)
      throw new Error('desktop_deadline_invalid');
    const disclosure = request.disclosure === undefined ? null : desktopMlDisclosureSchema.parse(request.disclosure);
    if (Buffer.byteLength(canonicalJson(disclosure)) > 256 * 1024) throw new Error('desktop_authority_too_large');
    const config = jsonObject.parse(request.config);
    const encoded = canonicalJson(config);
    if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error('desktop_config_too_large');
    return this.db.transaction().execute(async (db) => {
      // Bound durable transient inputs across API processes, including expired rows awaiting cleanup.
      await sql`select pg_advisory_xact_lock(912740, 1)`.execute(db);
      await db
        .deleteFrom('desktop_ml_task')
        .where('deadlineAt', '<=', sql<Date>`clock_timestamp()`)
        .execute();
      const count = await db
        .selectFrom('desktop_ml_task')
        .select(db.fn.countAll<string>().as('count'))
        .select(sql<string>`coalesce(sum(octet_length(input)), 0)`.as('bytes'))
        .where('state', '!=', 'consumed')
        .executeTakeFirstOrThrow();
      // Bounded by how many and by how much: an input is usually a preview of a few hundred kilobytes, but
      // may be 16 MB, and the count alone would let 256 of those hold 4 GB in the database.
      if (
        Number(count.count) >= MAX_OPEN_TASKS ||
        (Number(count.count) > 0 && Number(count.bytes) + request.input.length > maxOpenBytes)
      )
        throw new Error('desktop_broker_busy');
      const row = await db
        .insertInto('desktop_ml_task')
        .values({
          ...request,
          disclosure,
          config,
          configSha256: sha256(encoded),
          inputSha256: sha256(request.input),
          attemptId: null,
          result: null,
          resultSha256: null,
        })
        .returning(taskColumns)
        .executeTakeFirstOrThrow();
      return row;
    });
  }

  /**
   * Leases the oldest task this desktop's qualified models can run.
   *
   * Without `slots` a desktop holds one lease: while it holds one, a claim returns that lease again.
   * With `slots` (how many more tasks the desktop says it can take now) it may hold several: each claim
   * returns one new lease, never one it already holds, and only while it holds fewer leases of that kind of
   * work than the administrator's Jobs setting for that work's queue allows.
   */
  async claim(grant: DesktopWorkerGrant, modelKeys: string[], slots?: number): Promise<DesktopMlClaim | undefined> {
    if (modelKeys.length === 0 || modelKeys.length > 64) return;
    if (slots !== undefined && (!Number.isSafeInteger(slots) || slots < 1)) return;
    return this.db.transaction().execute(async (db) => {
      const worker = await this.device(db, grant);
      if (!worker) return;
      modelKeys = modelKeys.filter((key) => worker.modelKeys.includes(key));
      if (modelKeys.length === 0) return;
      // FL-1484: a computer that works on everyone's photos at home
      const household = (await desktopHouseholdDevices(db)).includes(grant.deviceId);
      const qualifications = await db
        .selectFrom('desktop_worker_qualification')
        .selectAll()
        .where('sessionId', '=', grant.sessionId)
        .where('deviceId', '=', grant.deviceId)
        .where('authorizationEpoch', '=', grant.authorizationEpoch)
        .where('modelKey', 'in', modelKeys)
        .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
        .execute();
      if (qualifications.length === 0) return;
      // The qualifications a new lease may be made under: all of them, or with several leases only those of
      // work this desktop holds less of than its queue's Jobs setting.
      let open = qualifications;
      if (slots !== undefined) {
        const held = await this.heldModelKeys(db, grant);
        // Whatever the settings and the desktop say, one desktop never holds more than this.
        if (held.length >= MAX_DESKTOP_LEASES) return;
        const limits = await queueLimits(db);
        const holding = (workload: string) => held.filter((key) => workloadOf(key) === workload).length;
        open = qualifications.filter((q) => holding(workloadOf(q.modelKey)) < (limits[workloadOf(q.modelKey)] ?? 1));
        if (open.length === 0) return;
      }
      const busy =
        slots !== undefined
          ? undefined
          : await db
              .selectFrom('desktop_ml_attempt as attempt')
              .innerJoin('desktop_ml_task as task', 'task.attemptId', 'attempt.id')
              .select(['attempt.id', 'task.modelKey'])
              .forUpdate('task')
              .where('attempt.deviceId', '=', grant.deviceId)
              .where('attempt.authorizationEpoch', '=', grant.authorizationEpoch)
              .where('attempt.expiresAt', '>', sql<Date>`clock_timestamp()`)
              .where('attempt.outcome', 'is', null)
              .where('task.state', '=', 'running')
              .where('task.deadlineAt', '>', sql<Date>`clock_timestamp()`)
              .limit(1)
              .executeTakeFirst();
      if (busy) {
        const attempt = await db
          .selectFrom('desktop_ml_attempt')
          .selectAll()
          .where('id', '=', busy.id)
          .executeTakeFirstOrThrow();
        if (attempt.workerSessionId !== grant.sessionId) return;
        const task = await db
          .selectFrom('desktop_ml_task')
          .select(taskColumns)
          .where('id', '=', attempt.taskId)
          .executeTakeFirstOrThrow();
        if (task.ownerId !== worker.ownerId && !household) return;
        const qualification = await this.qualification(db, grant, task);
        if (!qualification || !modelKeys.includes(qualification.modelKey)) return;
        return {
          task,
          attempt,
          qualificationId: qualification.id,
          workerModelKey: qualification.modelKey,
          qualificationExpiresAt: new Date(qualification.expiresAt),
          resumed: true,
        };
      }

      const task = await db
        .selectFrom('desktop_ml_task')
        .select(taskColumns)
        .$if(!household, (query) => query.where('ownerId', '=', worker.ownerId))
        // FL-1484: another account's Locked photos stay on that account's own computers
        .$if(household, (query) =>
          query.where((eb) =>
            eb.or([
              eb('ownerId', '=', worker.ownerId),
              eb.and([
                eb.not(lockedAssetIdExists(sql`(desktop_ml_task.disclosure -> 'source' ->> 'assetId')::uuid`)),
                // FL-1058: a gallery guest's selfie stays on the photographer's own computers
                sql<boolean>`desktop_ml_task.disclosure ->> 'workload' IS DISTINCT FROM 'guest-face'`,
              ]),
            ]),
          ),
        )
        .where((eb) =>
          eb.or(
            open.map((q) =>
              eb.and([
                eb('modelKey', 'in', [...equivalentDesktopModelKeys(q.modelKey)]),
                eb('configSha256', '=', q.configSha256),
                eb('inputKind', '=', q.inputKind),
              ]),
            ),
          ),
        )
        .where('deadlineAt', '>', sql<Date>`clock_timestamp()`)
        .where((eb) =>
          eb.or([
            eb('state', '=', 'pending'),
            eb.and([
              eb('state', '=', 'running'),
              eb.exists(
                eb
                  .selectFrom('desktop_ml_attempt')
                  .select('id')
                  .whereRef('desktop_ml_attempt.id', '=', 'desktop_ml_task.attemptId')
                  .where('expiresAt', '<=', sql<Date>`clock_timestamp()`),
              ),
            ]),
          ]),
        )
        .orderBy('createdAt', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!task) return;
      const qualification = open.find(
        (q) =>
          sameModel(task.modelKey, q.modelKey) &&
          q.configSha256 === task.configSha256 &&
          q.inputKind === task.inputKind,
      )!;
      if (task.attemptId)
        await db
          .updateTable('desktop_ml_attempt')
          .set({ outcome: 'expired' })
          .where('id', '=', task.attemptId)
          .execute();
      const attempt = await db
        .insertInto('desktop_ml_attempt')
        .values({
          taskId: task.id,
          deviceId: grant.deviceId,
          workerSessionId: grant.sessionId,
          qualificationId: qualification.id,
          authorizationEpoch: grant.authorizationEpoch,
          generation: task.generation + 1,
          // when the lease was made, not when this transaction began: failures are grouped by it
          createdAt: sql<Date>`clock_timestamp()`,
          expiresAt: leaseEnd(
            new Date(task.deadlineAt),
            new Date(Math.min(new Date(worker.expiresAt).getTime(), new Date(qualification.expiresAt).getTime())),
          ),
          outcome: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .updateTable('desktop_ml_task')
        .set({ state: 'running', generation: attempt.generation, attemptId: attempt.id })
        .where('id', '=', task.id)
        .execute();
      const metadata = task;
      return {
        task: { ...metadata, state: 'running', generation: attempt.generation, attemptId: attempt.id },
        attempt,
        qualificationId: qualification.id,
        workerModelKey: qualification.modelKey,
        qualificationExpiresAt: new Date(qualification.expiresAt),
        resumed: false,
      };
    });
  }

  /** The model key of each task this desktop holds a live lease for. */
  private async heldModelKeys(
    db: Kysely<DesktopMlDatabase>,
    grant: Pick<DesktopWorkerGrant, 'deviceId' | 'authorizationEpoch'>,
  ): Promise<string[]> {
    const rows = await db
      .selectFrom('desktop_ml_attempt as attempt')
      .innerJoin('desktop_ml_task as task', 'task.attemptId', 'attempt.id')
      .select('task.modelKey')
      .where('attempt.deviceId', '=', grant.deviceId)
      .where('attempt.authorizationEpoch', '=', grant.authorizationEpoch)
      .where('attempt.expiresAt', '>', sql<Date>`clock_timestamp()`)
      .where('attempt.outcome', 'is', null)
      .where('task.state', '=', 'running')
      .where('task.deadlineAt', '>', sql<Date>`clock_timestamp()`)
      .execute();
    return rows.map((row) => row.modelKey);
  }

  /** How many leases this desktop holds now. */
  async heldLeases(grant: Pick<DesktopWorkerGrant, 'deviceId' | 'authorizationEpoch'>): Promise<number> {
    return (await this.heldModelKeys(this.db, grant)).length;
  }

  /**
   * The administrator's Jobs setting for each kind of work a desktop does: how many tasks of that work one
   * desktop may hold at once, sent to it in the inventory.
   */
  workloadConcurrency(): Promise<Record<string, number>> {
    return queueLimits(this.db);
  }

  /**
   * Remembers how many tasks a desktop said it can run at once (what it holds plus the free slots of its
   * last claim), so the queues start that many jobs for it. Kept for an hour from the last write.
   */
  async rememberCapacity(grant: Pick<DesktopWorkerGrant, 'deviceId'>, total: number): Promise<void> {
    const capacity = Math.max(1, Math.min(MAX_DESKTOP_LEASES, Math.trunc(total)));
    await this.db.transaction().execute(async (db) => {
      await sql`SELECT pg_advisory_xact_lock(912740, 3)`.execute(db);
      const now = new Date();
      const known = await readCapacities(db);
      for (const [device, entry] of Object.entries(known))
        if (now.getTime() - new Date(entry.at).getTime() > 3_600_000) delete known[device];
      known[grant.deviceId] = { total: capacity, at: now.toISOString() };
      await sql`INSERT INTO system_metadata (key, value)
        VALUES (${SystemMetadataKey.FrameleafDesktopWorkerCapacity}, ${JSON.stringify(known)}::text::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(db);
    });
  }

  input(
    grant: DesktopWorkerGrant,
    attemptId: string,
    authorize: (task: TaskMetadata, tx: Transaction<DB>) => Promise<void>,
  ): Promise<Buffer | undefined> {
    return this.db.transaction().execute(async (db) => {
      const household = await desktopHouseholdDevices(db);
      const pending = await db
        .selectFrom('desktop_ml_task as task')
        .innerJoin('desktop_ml_attempt as attempt', 'task.attemptId', 'attempt.id')
        .innerJoin('desktop_device as device', 'device.id', 'attempt.deviceId')
        .select(taskColumns.map((column) => `task.${column}` as const))
        .where('attempt.id', '=', attemptId)
        .where('attempt.deviceId', '=', grant.deviceId)
        .where('attempt.workerSessionId', '=', grant.sessionId)
        .where('attempt.authorizationEpoch', '=', grant.authorizationEpoch)
        .where((eb) =>
          household.length > 0
            ? eb.or([eb('device.userId', '=', eb.ref('task.ownerId')), eb('device.id', 'in', household)])
            : eb('device.userId', '=', eb.ref('task.ownerId')),
        )
        .whereRef('attempt.generation', '=', 'task.generation')
        .where('attempt.outcome', 'is', null)
        .where('attempt.expiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('task.state', '=', 'running')
        .where('task.deadlineAt', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (!pending) return;
      // Match activation/publication lock order before taking any worker row, then recheck before bytes.
      await authorize(pending, db);
      return this.withAttempt(
        grant,
        attemptId,
        async (tx, task) => {
          await authorize(task, tx);
          const row = await tx
            .selectFrom('desktop_ml_task')
            .select('input')
            .where('id', '=', task.id)
            .executeTakeFirst();
          return row?.input ?? undefined;
        },
        'running',
        db,
      );
    });
  }

  async heartbeat(grant: DesktopWorkerGrant, attemptId: string): Promise<boolean> {
    return (await this.heartbeatLease(grant, attemptId)) !== undefined;
  }

  heartbeatLease(grant: DesktopWorkerGrant, attemptId: string): Promise<Date | undefined> {
    return this.withAttempt(grant, attemptId, async (db, task, credentialExpiry) => {
      const attempt = await db
        .updateTable('desktop_ml_attempt')
        .set({ expiresAt: leaseEnd(new Date(task.deadlineAt), credentialExpiry) })
        .where('id', '=', attemptId)
        .returning('expiresAt')
        .executeTakeFirstOrThrow();
      return new Date(attempt.expiresAt);
    });
  }

  /** Stages a result only. The NAS dispatcher must revalidate asset/route authority before adopting it. */
  async complete(
    grant: DesktopWorkerGrant,
    attemptId: string,
    value: Record<string, unknown>,
    /** Throws when the result is not what this task's model returns; nothing is staged then. */
    validate?: (task: Pick<Task, 'modelKey' | 'inputKind'>, result: Record<string, unknown>) => void,
  ): Promise<boolean> {
    const result = jsonObject.parse(value);
    const encoded = canonicalJson(result);
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('desktop_result_too_large');
    const resultSha256 = sha256(encoded);
    const accepted = await this.withAttempt(grant, attemptId, async (db, task) => {
      validate?.(task, result);
      await db
        .updateTable('desktop_ml_task')
        .set({ state: 'completed', result, resultSha256, input: null })
        .where('id', '=', task.id)
        .execute();
      await db.updateTable('desktop_ml_attempt').set({ outcome: 'completed' }).where('id', '=', attemptId).execute();
      return true;
    });
    if (accepted) return true;
    return (
      (await this.withAttempt(
        grant,
        attemptId,
        (_db, task) => Promise.resolve(task.resultSha256 === resultSha256),
        'finished',
      )) ?? false
    );
  }

  /**
   * The desktop gives up this attempt. `cancelled` (the person paused the desktop) puts the task straight back
   * in line; any other code counts toward the three failures after which the task itself fails, and so does
   * a `cancelled` once the task was handed back `DESKTOP_CANCELS_PER_TASK` times.
   */
  async fail(
    grant: DesktopWorkerGrant,
    attemptId: string,
    code: DesktopFailureCode = 'inference-failed',
  ): Promise<boolean> {
    return (
      (await this.withAttempt(grant, attemptId, async (db, task) => {
        let outcome: 'cancelled' | 'failed' = code === 'cancelled' ? 'cancelled' : 'failed';
        if (outcome === 'cancelled') {
          // A task that is only ever handed back would never end: past the cap a hand-back is a failed attempt.
          const { cancelled } = await db
            .selectFrom('desktop_ml_attempt')
            .select(db.fn.countAll<string>().as('cancelled'))
            .where('taskId', '=', task.id)
            .where('outcome', '=', 'cancelled')
            .executeTakeFirstOrThrow();
          if (Number(cancelled) >= DESKTOP_CANCELS_PER_TASK) outcome = 'failed';
        }
        await db.updateTable('desktop_ml_attempt').set({ outcome }).where('id', '=', attemptId).execute();
        const { failed } = await db
          .selectFrom('desktop_ml_attempt')
          .select(db.fn.countAll<string>().as('failed'))
          .where('taskId', '=', task.id)
          .where('outcome', '=', 'failed')
          .executeTakeFirstOrThrow();
        const exhausted = Number(failed) >= 3;
        await db
          .updateTable('desktop_ml_task')
          .set({
            state: exhausted ? 'failed' : 'pending',
            attemptId: null,
            input: exhausted ? null : sql<Buffer>`input`,
          })
          .where('id', '=', task.id)
          .execute();
        return true;
      })) ?? false
    );
  }

  /** The model key of the task behind one of this desktop's attempts, for the log line of a refusal. */
  async attemptModelKey(grant: Pick<DesktopWorkerGrant, 'deviceId'>, attemptId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('desktop_ml_attempt as attempt')
      .innerJoin('desktop_ml_task as task', 'task.id', 'attempt.taskId')
      .select('task.modelKey')
      .where('attempt.id', '=', attemptId)
      .where('attempt.deviceId', '=', grant.deviceId)
      .executeTakeFirst();
    return row?.modelKey;
  }

  /**
   * Takes a model away from a desktop that keeps failing it. Its qualification goes, so it is offered no more
   * of that work until it qualifies again (the next inventory still lists the model), and it cannot qualify
   * for it again until `DESKTOP_REQUALIFY_HOLD_SECONDS` have passed.
   */
  withdraw(grant: DesktopWorkerGrant, taskModelKey: string): Promise<boolean> {
    const keys = [...equivalentDesktopModelKeys(taskModelKey)];
    return this.db.transaction().execute(async (db) => {
      const worker = await this.device(db, grant);
      if (!worker) return false;
      await db
        .deleteFrom('desktop_worker_qualification')
        .where('deviceId', '=', grant.deviceId)
        .where('sessionId', '=', grant.sessionId)
        .where('modelKey', 'in', keys)
        .execute();
      const kept = worker.modelKeys.filter((key) => !keys.includes(key));
      await db
        .updateTable('desktop_worker_session')
        .set({ modelKeys: sql<string[]>`${kept}::jsonb` })
        .where('id', '=', grant.sessionId)
        .execute();
      // The other tasks of this model it still holds go straight back in line for another desktop: without
      // its qualification it can no longer finish them, and they would wait for their leases to run out.
      // Task rows are locked before attempt rows everywhere in this file (`withAttempt`, `cancel`).
      const { rows: stranded } = await sql<{ id: string; attemptId: string }>`
        SELECT t.id, t."attemptId" FROM desktop_ml_task t JOIN desktop_ml_attempt a ON a.id=t."attemptId"
        WHERE t.state='running' AND a."deviceId"=${grant.deviceId} AND a.outcome IS NULL
          AND t."modelKey"=ANY(${keys}::text[]) ORDER BY t.id FOR UPDATE OF t`.execute(db);
      if (stranded.length > 0) {
        await sql`UPDATE desktop_ml_attempt SET outcome='cancelled'
          WHERE id=ANY(${stranded.map((row) => row.attemptId)}::uuid[]) AND outcome IS NULL`.execute(db);
        await sql`UPDATE desktop_ml_task SET state='pending', "attemptId"=NULL
          WHERE id=ANY(${stranded.map((row) => row.id)}::uuid[]) AND state='running'`.execute(db);
      }
      await this.changeFailures(db, (failures, now) => {
        failures[failureKey(grant.deviceId, taskModelKey)] = {
          failures: 0,
          at: now.toISOString(),
          heldUntil: new Date(now.getTime() + DESKTOP_REQUALIFY_HOLD_SECONDS * 1000).toISOString(),
        };
      });
      return kept.length !== worker.modelKeys.length;
    });
  }

  /**
   * Counts one more failure in a row for this desktop and model, and returns the count. Kept in the database
   * (one small `system_metadata` record), so it is the same for every API process and survives a restart.
   *
   * Every failure counts. A runtime that crashes with several tasks in hand is one failure because the
   * desktop says so: it reports `model-unavailable` for one task and `cancelled` for the others. With
   * `stop`, the failure is that crash: the tasks handed back after it, with no lease in between, belong to
   * it and are not counted as a hand-back (`countCancel`).
   */
  countFailure(grant: Pick<DesktopWorkerGrant, 'deviceId'>, taskModelKey: string, stop = false): Promise<number> {
    const key = failureKey(grant.deviceId, taskModelKey);
    return this.db.transaction().execute(async (db) => {
      const cancelLease = stop ? await this.lastLease(db, grant, taskModelKey) : undefined;
      let count = 0;
      await this.changeFailures(db, (failures, now) => {
        count = (failures[key]?.failures ?? 0) + 1;
        failures[key] = {
          ...failures[key],
          failures: count,
          at: now.toISOString(),
          ...(cancelLease && { cancelLease }),
        };
      });
      return count;
    });
  }

  /** When this desktop was last given a task of the model: UTC with microseconds, so two leases never tie. */
  private async lastLease(
    db: Transaction<DesktopMlDatabase>,
    grant: Pick<DesktopWorkerGrant, 'deviceId'>,
    taskModelKey: string,
  ): Promise<string> {
    const { rows } = await sql<{ at: string | null }>`
      SELECT to_char(max(a."createdAt") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM desktop_ml_attempt a JOIN desktop_ml_task t ON t.id=a."taskId"
      WHERE a."deviceId"=${grant.deviceId}
        AND t."modelKey"=ANY(${[...equivalentDesktopModelKeys(taskModelKey)]}::text[])`.execute(db);
    return rows[0]?.at ?? '';
  }

  /**
   * Counts a task handed back (`cancelled`) by this desktop for this model, and returns how many hand-backs
   * the current window holds. The window is `DESKTOP_CANCEL_WINDOW_SECONDS` from its first hand-back.
   *
   * Hand-backs with no lease of this model given to the desktop in between are one: a stop, a pause, or the
   * tasks a crash left, however many were in hand. Only the first of them is counted and returns the count;
   * the others return 0, so one stop is never more than one hand-back, below the cap or above it. A desktop
   * that takes a task and hands it back is counted each time.
   *
   * The record keeps the newest lease seen when a stop was counted, and a later hand-back is the same stop
   * only if no newer lease exists. The time the stop was written is not used: a lease made while the stop
   * was being counted would look older than it and its hand-back would be lost.
   */
  countCancel(grant: Pick<DesktopWorkerGrant, 'deviceId'>, taskModelKey: string): Promise<number> {
    const key = failureKey(grant.deviceId, taskModelKey);
    return this.db.transaction().execute(async (db) => {
      const leasedAt = await this.lastLease(db, grant, taskModelKey);
      let count = 0;
      await this.changeFailures(db, (failures, now) => {
        const known = failures[key] ?? { failures: 0, at: now.toISOString() };
        const open =
          !!known.cancelsFrom &&
          now.getTime() - new Date(known.cancelsFrom).getTime() < DESKTOP_CANCEL_WINDOW_SECONDS * 1000;
        // records written before `cancelLease` existed have only the time the stop was written
        const sameStop = known.cancelLease
          ? leasedAt <= known.cancelLease
          : open && !!known.cancelAt && leasedAt < known.cancelAt;
        if (sameStop) return;
        count = open ? (known.cancels ?? 0) + 1 : 1;
        failures[key] = {
          ...known,
          cancels: count,
          cancelsFrom: open ? known.cancelsFrom : now.toISOString(),
          cancelAt: now.toISOString(),
          cancelLease: leasedAt,
        };
      });
      return count;
    });
  }

  /** A result the desktop got right ends its run of failures for that model. */
  async clearFailures(grant: Pick<DesktopWorkerGrant, 'deviceId'>, taskModelKey: string): Promise<void> {
    const key = failureKey(grant.deviceId, taskModelKey);
    // Nearly every result finds nothing to clear: look before taking the lock.
    const known = (await this.readFailures(this.db))[key];
    if (!known?.failures && !known?.cancels) return;
    await this.db.transaction().execute((db) =>
      this.changeFailures(db, (failures) => {
        const { heldUntil, at } = failures[key] ?? {};
        if (heldUntil && at) failures[key] = { failures: 0, at, heldUntil };
        else delete failures[key];
      }),
    );
  }

  /** Until when this desktop may not qualify for a model again (any of `modelKeys`), if it is being held back. */
  async heldUntil(deviceId: string, modelKeys: readonly string[]): Promise<Date | undefined> {
    const failures = await this.readFailures(this.db);
    const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(this.db);
    const until = modelKeys
      .map((modelKey) => failures[failureKey(deviceId, modelKey)]?.heldUntil)
      .filter((value): value is string => !!value)
      .map((value) => new Date(value))
      .filter((value) => value.getTime() > new Date(rows[0].now).getTime())
      .toSorted((a, b) => b.getTime() - a.getTime());
    return until[0];
  }

  /**
   * Which of `modelKeys` the server took away from this computer and has not granted again. The desktop's
   * own count starts again each time it sets up, so it can still believe it holds such a model.
   */
  async withdrawnModels(deviceId: string, modelKeys: readonly string[]): Promise<string[]> {
    const failures = await this.readFailures(this.db);
    return modelKeys.filter((modelKey) =>
      equivalentDesktopModelKeys(modelKey).some((key) => failures[failureKey(deviceId, key)]?.heldUntil),
    );
  }

  /** The model was granted to this computer again: the withdrawal is over. */
  async clearWithdrawal(deviceId: string, modelKey: string): Promise<void> {
    const keys = equivalentDesktopModelKeys(modelKey).map((key) => failureKey(deviceId, key));
    const failures = await this.readFailures(this.db);
    if (keys.every((key) => !failures[key])) return;
    await this.db.transaction().execute((db) =>
      this.changeFailures(db, (current) => {
        for (const key of keys) delete current[key];
      }),
    );
  }

  private async readFailures(db: Kysely<DesktopMlDatabase>): Promise<DesktopModelFailures> {
    const { rows } = await sql<{ value: unknown }>`SELECT value FROM system_metadata
      WHERE key=${SystemMetadataKey.FrameleafDesktopModelFailures}`.execute(db);
    const parsed = failuresSchema.safeParse(rows[0]?.value ?? {});
    return parsed.success ? parsed.data : {};
  }

  /** Read, change and write the record under one lock; entries with nothing left to say are dropped. */
  private async changeFailures(
    db: Transaction<DesktopMlDatabase>,
    change: (failures: DesktopModelFailures, now: Date) => void,
  ): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(912740, 2)`.execute(db);
    const failures = await this.readFailures(db);
    const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db);
    const now = new Date(rows[0].now);
    change(failures, now);
    for (const [key, entry] of Object.entries(failures)) {
      // A count and the record of a withdrawal are good for an hour (a qualification's life), by which time
      // the desktop has qualified again. The hand-backs have a window of their own and outlive them.
      const handingBack =
        !!entry.cancels &&
        !!entry.cancelsFrom &&
        now.getTime() - new Date(entry.cancelsFrom).getTime() < DESKTOP_CANCEL_WINDOW_SECONDS * 1000;
      if (now.getTime() - new Date(entry.at).getTime() > 3_600_000) {
        if (handingBack) {
          failures[key] = {
            failures: 0,
            at: entry.cancelAt ?? entry.cancelsFrom!,
            cancels: entry.cancels,
            cancelsFrom: entry.cancelsFrom,
            cancelAt: entry.cancelAt,
            cancelLease: entry.cancelLease,
          };
        } else delete failures[key];
      } else if (!entry.heldUntil && entry.failures === 0 && !handingBack) delete failures[key];
    }
    await sql`INSERT INTO system_metadata (key, value)
      VALUES (${SystemMetadataKey.FrameleafDesktopModelFailures}, ${JSON.stringify(failures)}::text::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(db);
  }

  async cancel(id: string): Promise<boolean> {
    return this.db.transaction().execute(async (db) => {
      const row = await db
        .updateTable('desktop_ml_task')
        .set({ state: 'cancelled', input: null, result: null })
        .where('id', '=', id)
        .where('state', 'in', ['pending', 'running'])
        .returning('attemptId')
        .executeTakeFirst();
      if (!row) return false;
      if (row.attemptId)
        await db
          .updateTable('desktop_ml_attempt')
          .set({ outcome: 'cancelled' })
          .where('id', '=', row.attemptId)
          .execute();
      return true;
    });
  }

  async hasLiveAttempt(id: string): Promise<boolean> {
    const task = await this.db.selectFrom('desktop_ml_task').select('modelKey').where('id', '=', id).executeTakeFirst();
    if (!task) return false;
    const keys = [...equivalentDesktopModelKeys(task.modelKey)];
    const household = householdMatch(await desktopHouseholdDevices(this.db));
    // The attempt stays live while its desktop holds any current qualification for this model and config:
    // qualifying again replaces the row the attempt was leased under, and must not end the attempt.
    const { rows } = await sql<{ ownerId: string; isAdmin: boolean }>`
      SELECT u.id AS "ownerId", u."isAdmin" FROM desktop_ml_task t
      JOIN desktop_ml_attempt a ON a.id=t."attemptId" AND a."taskId"=t.id AND a.generation=t.generation
      JOIN desktop_worker_session w ON w.id=a."workerSessionId" AND w."deviceId"=a."deviceId"
      JOIN desktop_device d ON d.id=a."deviceId"
      JOIN "user" u ON u.id=d."userId" AND (u.id=t."ownerId" ${household})
      JOIN session p ON p.id=w."photoSessionId" AND p."userId"=u.id
      JOIN desktop_worker_qualification q ON q."sessionId"=w.id
        AND q."deviceId"=d.id AND q."authorizationEpoch"=d."authorizationEpoch"
        AND q."modelKey"=ANY(${keys}::text[]) AND q."configSha256"=t."configSha256" AND q."inputKind"=t."inputKind"
      WHERE t.id=${id} AND t.state='running' AND t."deadlineAt">clock_timestamp()
        AND a.outcome IS NULL AND a."expiresAt">clock_timestamp()
        AND a."authorizationEpoch"=d."authorizationEpoch" AND w."authorizationEpoch"=d."authorizationEpoch"
        AND w."revokedAt" IS NULL AND w."expiresAt">clock_timestamp()
        AND w."lastSeenAt">${seenSince}
        AND w."modelKeys" @> jsonb_build_array(q."modelKey") AND q."expiresAt">clock_timestamp()
        AND d.state='preparing' AND d.mode='client-worker' AND d."revokedAt" IS NULL
        AND u."deletedAt" IS NULL AND (p."expiresAt" IS NULL OR p."expiresAt">clock_timestamp())
      LIMIT 1`.execute(this.db);
    return !!rows[0] && desktopWorkerAccountAllowed(this.db, rows[0].ownerId, rows[0].isAdmin);
  }

  /**
   * FL-456: one of the owner's approved Frameleaf Desktop helpers, or (FL-1484) a computer that works on
   * everyone's photos, is online (seen within `DESKTOP_PRESENCE_SECONDS`) and holds a current qualification
   * for `modelKey` (or the same encoder under its own runtime revision), so a job sent to the helpers now
   * can be taken.
   */
  async hasReadyWorker(ownerId: string, modelKey: string, options: { household?: boolean } = {}): Promise<boolean> {
    const household = householdMatch(options.household === false ? [] : await desktopHouseholdDevices(this.db));
    const keys = [...equivalentDesktopModelKeys(modelKey)];
    const { rows } = await sql<{ userId: string; isAdmin: boolean }>`
      SELECT u.id AS "userId", u."isAdmin" FROM desktop_device d
      JOIN "user" u ON u.id=d."userId" AND u."deletedAt" IS NULL
      JOIN desktop_worker_session w ON w."deviceId"=d.id AND w."authorizationEpoch"=d."authorizationEpoch"
      JOIN session p ON p.id=w."photoSessionId" AND p."userId"=u.id
      JOIN desktop_worker_qualification q ON q."sessionId"=w.id AND q."deviceId"=d.id
        AND q."authorizationEpoch"=d."authorizationEpoch" AND q."modelKey"=ANY(${keys}::text[])
      WHERE (d."userId"=${ownerId} ${household}) AND d.state='preparing' AND d.mode='client-worker'
        AND d."revokedAt" IS NULL AND w."revokedAt" IS NULL AND w."expiresAt">clock_timestamp()
        AND w."lastSeenAt">${seenSince}
        AND w."modelKeys" @> jsonb_build_array(q."modelKey") AND q."expiresAt">clock_timestamp()
        AND (p."expiresAt" IS NULL OR p."expiresAt">clock_timestamp())
      LIMIT 16`.execute(this.db);
    for (const row of rows) {
      // the computer's own account must still be allowed to help
      if (await desktopWorkerAccountAllowed(this.db, row.userId, row.isAdmin)) return true;
    }
    return false;
  }

  /**
   * How many extra jobs each queue may start for desktops, given the model keys its work needs now
   * (`scopes`; a queue is left out when its route would not send work to desktops or its task is off).
   *
   * A desktop counts once per task it can run at once (one, unless it said it can run more): each lease it
   * holds counts for the queue of the job it is for, and each free slot for the first queue in `scopes` that
   * it is qualified for, that has a job coming up for an account it works for, and of whose work it holds
   * fewer tasks than that queue's Jobs setting. Only
   * a desktop that is online, of a permitted account, with an unexpired qualification for a key in that
   * queue's scope counts, so the number falls as soon as a model changes, a qualification runs out or the
   * desktop stops asking for work.
   */
  async helperCapacity(scopes: Readonly<Record<string, readonly string[]>>): Promise<Record<string, number>> {
    const queues = Object.keys(scopes).filter((queue) => scopes[queue].length > 0);
    const capacity: Record<string, number> = Object.fromEntries(Object.keys(scopes).map((queue) => [queue, 0]));
    if (queues.length === 0) return capacity;
    const keys = [...new Set(queues.flatMap((queue) => scopes[queue]))];
    const { rows } = await sql<{ id: string; userId: string; isAdmin: boolean; held: string[] }>`
      SELECT d.id, u.id AS "userId", u."isAdmin", array_agg(DISTINCT q."modelKey") AS held
      FROM desktop_device d
      JOIN "user" u ON u.id=d."userId" AND u."deletedAt" IS NULL
      JOIN desktop_worker_session w ON w."deviceId"=d.id AND w."authorizationEpoch"=d."authorizationEpoch"
      JOIN session p ON p.id=w."photoSessionId" AND p."userId"=u.id
      JOIN desktop_worker_qualification q ON q."sessionId"=w.id AND q."deviceId"=d.id
        AND q."authorizationEpoch"=d."authorizationEpoch" AND q."modelKey"=ANY(${keys}::text[])
        AND q."expiresAt">clock_timestamp() AND w."modelKeys" @> jsonb_build_array(q."modelKey")
      WHERE d.state='preparing' AND d.mode='client-worker' AND d."revokedAt" IS NULL
        AND w."revokedAt" IS NULL AND w."expiresAt">clock_timestamp() AND w."lastSeenAt">${seenSince}
        AND (p."expiresAt" IS NULL OR p."expiresAt">clock_timestamp())
      GROUP BY d.id, u.id, u."isAdmin"
      ORDER BY d.id LIMIT 64`.execute(this.db);
    if (rows.length === 0) return capacity;
    const policy = await readDesktopAssistancePolicy(this.db);
    if (!policy) return capacity;
    // The leases each of those desktops holds, and the queue of the job each is for (none for work that is
    // not a queued job, such as a gallery guest's selfie: it takes a slot and adds no queue job).
    const { rows: leases } = await sql<{ id: string; queue: string | null }>`
      SELECT a."deviceId" AS id, j.queue FROM desktop_ml_attempt a
      JOIN desktop_ml_task t ON t."attemptId"=a.id AND t.state='running' AND t."deadlineAt">clock_timestamp()
      LEFT JOIN job j ON j.id=(t.disclosure->'job'->>'id')::uuid AND j.state='active'
      WHERE a."deviceId"=ANY(${rows.map((row) => row.id)}::uuid[]) AND a.outcome IS NULL
        AND a."expiresAt">clock_timestamp()`.execute(this.db);
    // How many tasks each desktop said it can run at once (one, for a desktop that never said), and how many
    // of one kind of work the administrator lets a desktop hold: the Jobs setting of that work's queue.
    const capacities = await readCapacities(this.db);
    const { rows: settings } = await sql<{ name: string; concurrency: number }>`
      SELECT name, concurrency FROM job_queue WHERE name=ANY(${queues}::text[])`.execute(this.db);
    const limit = (queue: string) => Math.max(1, settings.find((row) => row.name === queue)?.concurrency ?? 1);
    // Whose photos the next jobs of each queue are for (the next few in claim order, so a long backlog is
    // never read). A free slot is counted only for a queue where a job its desktop may take is coming up: its
    // own account's photo, or anyone's when it works on everyone's photos. A job nobody's desktop can take
    // runs on the next place in the order, and must not start on top of that place's own concurrency.
    // ponytail: another account's Locked photo is counted for a household desktop though it will not take
    // it; such a job then runs on the next place, one above its concurrency at worst.
    const { rows: waiting } = await sql<{ queue: string; owner: string | null; jobs: number }>`
      SELECT q.queue, a."ownerId"::text AS owner, count(*)::int AS jobs
      FROM unnest(${queues}::text[]) AS q(queue)
      CROSS JOIN LATERAL (
        SELECT j.data->>'id' AS id FROM job j
        WHERE j.queue=q.queue AND j.state='pending' AND j."availableAt"<=now()
        ORDER BY j."availableAt", j."createdAt", j.id LIMIT ${UPCOMING_JOBS}
      ) upcoming
      LEFT JOIN asset a ON a.id = CASE WHEN upcoming.id ~ '^[0-9a-fA-F-]{36}$' THEN upcoming.id::uuid END
      GROUP BY q.queue, a."ownerId"`.execute(this.db);
    const household = householdDevices(policy);
    /** The upcoming jobs of a queue this desktop may take. */
    const upcoming = (queue: string, desktop: { id: string; userId: string }) =>
      waiting
        .filter(
          (row) => row.queue === queue && row.owner && (row.owner === desktop.userId || household.has(desktop.id)),
        )
        .reduce((jobs, row) => jobs + row.jobs, 0);
    for (const row of rows) {
      if (!desktopAccountPermitted(policy, row.userId, row.isAdmin)) continue;
      const own = leases.filter((lease) => lease.id === row.id);
      const holding = (queue: string) => own.filter((lease) => lease.queue === queue).length;
      let free = Math.max(0, Math.min(MAX_DESKTOP_LEASES, capacities[row.id]?.total ?? 1) - own.length);
      for (const queue of queues) {
        if (scopes[queue].every((key) => !row.held.includes(key))) continue;
        // The jobs it is running in this queue keep their place beside this server's own...
        capacity[queue] += holding(queue);
        // ...and each free slot adds one, in queue order, while the queue's setting and its upcoming work allow.
        const more = Math.max(0, Math.min(free, limit(queue) - holding(queue), upcoming(queue, row)));
        capacity[queue] += more;
        free -= more;
      }
    }
    return capacity;
  }

  /** FL-1484: whether this photo is Locked, which keeps it off another account's computers. */
  async isLockedAsset(assetId: string): Promise<boolean> {
    const { rows } = await sql<{
      locked: boolean;
    }>`SELECT ${lockedAssetIdExists(sql`${assetId}::uuid`)} AS locked`.execute(this.db);
    return !!rows[0]?.locked;
  }

  result(id: string): Promise<TaskMetadata | undefined> {
    return this.db
      .selectFrom('desktop_ml_task')
      .select(taskColumns)
      .where('id', '=', id)
      .where('state', '!=', 'consumed')
      .executeTakeFirst();
  }

  async assertAdoption(
    id: string,
    expected: Pick<Task, 'ownerId' | 'modelKey' | 'authorityKey' | 'configSha256' | 'inputSha256'>,
    transaction?: Transaction<DB>,
  ): Promise<void> {
    const assert = async (db: Transaction<DesktopMlDatabase>) => {
      const attempt = await db
        .selectFrom('desktop_ml_attempt as attempt')
        .innerJoin('desktop_ml_task as task', 'task.attemptId', 'attempt.id')
        .select([
          'attempt.id',
          'attempt.deviceId',
          'attempt.workerSessionId',
          'attempt.qualificationId',
          'attempt.authorizationEpoch',
          'attempt.generation',
        ])
        .where('task.id', '=', id)
        .where('task.state', '=', 'completed')
        .where('attempt.outcome', '=', 'completed')
        .executeTakeFirst();
      if (!attempt?.workerSessionId) throw new Error('desktop_result_authority_lost');
      const worker = await lockDesktopWorkerForAdoption(db, { ...attempt, sessionId: attempt.workerSessionId });
      const household = (await desktopHouseholdDevices(db)).includes(attempt.deviceId);
      if (!worker || (worker.ownerId !== expected.ownerId && !household))
        throw new Error('desktop_result_authority_lost');
      const task = await db
        .selectFrom('desktop_ml_task')
        .select(['id', 'modelKey', 'configSha256', 'inputKind'])
        .where('id', '=', id)
        .where('state', '=', 'completed')
        .where('attemptId', '=', attempt.id)
        .where('generation', '=', attempt.generation)
        .where('ownerId', '=', expected.ownerId)
        .where('modelKey', '=', expected.modelKey)
        .where('authorityKey', '=', expected.authorityKey)
        .where('configSha256', '=', expected.configSha256)
        .where('inputSha256', '=', expected.inputSha256)
        .where('deadlineAt', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      const qualification =
        task && (await this.qualification(db, { ...attempt, sessionId: attempt.workerSessionId }, task));
      if (!qualification || !worker.modelKeys.includes(qualification.modelKey))
        throw new Error('desktop_result_authority_lost');
    };
    if (transaction)
      await assert(transaction.withTables<DesktopMlTables & DesktopWorkerTables & DesktopQualificationTables>());
    else await this.db.transaction().execute(assert);
  }

  /** `forget`: FL-1058, a guest selfie task leaves no consumed row (nor its input hash) behind. */
  async discard(id: string, forget = false): Promise<void> {
    if (forget) {
      await this.db.deleteFrom('desktop_ml_task').where('id', '=', id).execute();
      return;
    }
    await this.db
      .updateTable('desktop_ml_task')
      .set({
        state: 'consumed',
        result: null,
        input: null,
        disclosure: null,
        config: sql<Record<string, unknown>>`'{}'::jsonb`,
      })
      .where('id', '=', id)
      .where('state', '=', 'completed')
      .execute();
    await this.db
      .deleteFrom('desktop_ml_task')
      .where('id', '=', id)
      .where('state', 'in', ['cancelled', 'failed'])
      .execute();
  }

  /**
   * This desktop's current qualification for the task's model and config. An attempt is not tied to the row
   * it was leased under: qualifying again replaces that row with fresh evidence for the same model, and the
   * attempt in flight goes on under it.
   */
  private qualification(
    db: Transaction<DesktopMlDatabase>,
    grant: Omit<DesktopWorkerGrant, 'credentialHash'>,
    task: Pick<Task, 'modelKey' | 'configSha256' | 'inputKind'>,
  ) {
    return db
      .selectFrom('desktop_worker_qualification')
      .selectAll()
      .where('sessionId', '=', grant.sessionId)
      .where('deviceId', '=', grant.deviceId)
      .where('authorizationEpoch', '=', grant.authorizationEpoch)
      .where('modelKey', 'in', [...equivalentDesktopModelKeys(task.modelKey)])
      .where('configSha256', '=', task.configSha256)
      .where('inputKind', '=', task.inputKind)
      .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  private device(db: Transaction<DesktopMlDatabase>, grant: DesktopWorkerGrant) {
    return lockDesktopWorker(db, grant);
  }

  private withAttempt<T>(
    grant: DesktopWorkerGrant,
    id: string,
    operation: (db: Transaction<DesktopMlDatabase>, task: TaskMetadata, credentialExpiry: Date) => Promise<T>,
    state: 'running' | 'finished' = 'running',
    transaction?: Transaction<DesktopMlDatabase>,
  ): Promise<T | undefined> {
    const execute = async (db: Transaction<DesktopMlDatabase>) => {
      const worker = await this.device(db, grant);
      if (!worker) return;
      const attempt = await db
        .selectFrom('desktop_ml_attempt')
        .selectAll()
        .where('id', '=', id)
        .where('deviceId', '=', grant.deviceId)
        .where('workerSessionId', '=', grant.sessionId)
        .where('authorizationEpoch', '=', grant.authorizationEpoch)
        .executeTakeFirst();
      if (!attempt) return;
      const task = await db
        .selectFrom('desktop_ml_task')
        .select(taskColumns)
        .where('id', '=', attempt.taskId)
        .where('attemptId', '=', id)
        .where('generation', '=', attempt.generation)
        .where('state', 'in', state === 'running' ? ['running'] : ['completed', 'consumed'])
        .where('deadlineAt', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (!task) return;
      if (task.ownerId !== worker.ownerId && !(await desktopHouseholdDevices(db)).includes(grant.deviceId)) return;
      const qualification = await this.qualification(db, grant, task);
      if (!qualification || !worker.modelKeys.includes(qualification.modelKey)) return;
      const live = await db
        .selectFrom('desktop_ml_attempt')
        .select('id')
        .where('id', '=', id)
        .$if(state === 'running', (query) => query.where('outcome', 'is', null))
        .$if(state === 'finished', (query) => query.where('outcome', '=', 'completed'))
        .$if(state === 'running', (query) => query.where('expiresAt', '>', sql<Date>`clock_timestamp()`))
        .executeTakeFirst();
      if (!live) return;
      return operation(
        db,
        task,
        new Date(Math.min(new Date(worker.expiresAt).getTime(), new Date(qualification.expiresAt).getTime())),
      );
    };
    return transaction ? execute(transaction) : this.db.transaction().execute(execute);
  }
}
