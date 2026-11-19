import { Injectable } from '@nestjs/common';
import { type Kysely, type Selectable, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import z from 'zod';
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
import { desktopAccountPermitted } from 'src/utils/desktop-assistance-policy.js';
import { type DesktopMlDisclosure, desktopMlDisclosureSchema } from 'src/utils/desktop-ml-disclosure.js';
import { equivalentDesktopModelKeys } from 'src/utils/desktop-model-equivalents.js';
import { DESKTOP_LEASE_SECONDS, DESKTOP_PRESENCE_SECONDS } from 'src/utils/desktop-worker-timing.js';
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
};
export type DesktopFailureCode = 'inference-failed' | 'input-invalid' | 'model-unavailable' | 'cancelled';
export type DesktopMlRequest = Pick<Task, 'ownerId' | 'modelKey' | 'authorityKey' | 'config' | 'inputKind'> & {
  input: Buffer;
  deadlineAt: Date;
  disclosure?: DesktopMlDisclosure;
};
const jsonObject = z.record(z.string(), z.json());
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

  async create(request: DesktopMlRequest): Promise<TaskMetadata> {
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
        .where('state', '!=', 'consumed')
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= 32) throw new Error('desktop_broker_busy');
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

  async claim(grant: DesktopWorkerGrant, modelKeys: string[]): Promise<DesktopMlClaim | undefined> {
    if (modelKeys.length === 0 || modelKeys.length > 64) return;
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
      const busy = await db
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
            qualifications.map((q) =>
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
      const qualification = qualifications.find(
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
      };
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
   * in line; any other code counts toward the three failures after which the task itself fails.
   */
  async fail(
    grant: DesktopWorkerGrant,
    attemptId: string,
    code: DesktopFailureCode = 'inference-failed',
  ): Promise<boolean> {
    return (
      (await this.withAttempt(grant, attemptId, async (db, task) => {
        const outcome = code === 'cancelled' ? 'cancelled' : 'failed';
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
   * of that work until it qualifies again (the next inventory still lists the model).
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
      return kept.length !== worker.modelKeys.length;
    });
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
   * A desktop holds one lease across every queue, so it counts once: for the queue whose job it is running,
   * or, while free, for the first queue in `scopes` that it is qualified for and that has work waiting. Only
   * a desktop that is online, of a permitted account, with an unexpired qualification for a key in that
   * queue's scope counts, so the number falls as soon as a model changes, a qualification runs out or the
   * desktop stops asking for work.
   */
  async helperCapacity(scopes: Readonly<Record<string, readonly string[]>>): Promise<Record<string, number>> {
    const queues = Object.keys(scopes).filter((queue) => scopes[queue].length > 0);
    const capacity: Record<string, number> = Object.fromEntries(Object.keys(scopes).map((queue) => [queue, 0]));
    if (queues.length === 0) return capacity;
    const keys = [...new Set(queues.flatMap((queue) => scopes[queue]))];
    const { rows } = await sql<{
      id: string;
      userId: string;
      isAdmin: boolean;
      held: string[];
      busyQueue: string | null;
      busy: boolean;
    }>`
      SELECT d.id, u.id AS "userId", u."isAdmin", array_agg(DISTINCT q."modelKey") AS held,
        lease.queue AS "busyQueue", lease.id IS NOT NULL AS busy
      FROM desktop_device d
      JOIN "user" u ON u.id=d."userId" AND u."deletedAt" IS NULL
      JOIN desktop_worker_session w ON w."deviceId"=d.id AND w."authorizationEpoch"=d."authorizationEpoch"
      JOIN session p ON p.id=w."photoSessionId" AND p."userId"=u.id
      JOIN desktop_worker_qualification q ON q."sessionId"=w.id AND q."deviceId"=d.id
        AND q."authorizationEpoch"=d."authorizationEpoch" AND q."modelKey"=ANY(${keys}::text[])
        AND q."expiresAt">clock_timestamp() AND w."modelKeys" @> jsonb_build_array(q."modelKey")
      LEFT JOIN LATERAL (
        SELECT a.id, j.queue FROM desktop_ml_attempt a
        JOIN desktop_ml_task t ON t."attemptId"=a.id AND t.state='running' AND t."deadlineAt">clock_timestamp()
        LEFT JOIN job j ON j.id=(t.disclosure->'job'->>'id')::uuid AND j.state='active'
        WHERE a."deviceId"=d.id AND a.outcome IS NULL AND a."expiresAt">clock_timestamp() LIMIT 1
      ) lease ON true
      WHERE d.state='preparing' AND d.mode='client-worker' AND d."revokedAt" IS NULL
        AND w."revokedAt" IS NULL AND w."expiresAt">clock_timestamp() AND w."lastSeenAt">${seenSince}
        AND (p."expiresAt" IS NULL OR p."expiresAt">clock_timestamp())
      GROUP BY d.id, u.id, u."isAdmin", lease.queue, lease.id
      ORDER BY d.id LIMIT 64`.execute(this.db);
    if (rows.length === 0) return capacity;
    const policy = await readDesktopAssistancePolicy(this.db);
    if (!policy) return capacity;
    const { rows: waiting } = await sql<{ queue: string }>`
      SELECT name AS queue FROM job_queue WHERE name=ANY(${queues}::text[]) AND EXISTS (
        SELECT 1 FROM job WHERE job.queue=job_queue.name AND job.state='pending' AND job."availableAt"<=now())`.execute(
      this.db,
    );
    const hasWork = new Set(waiting.map((row) => row.queue));
    for (const row of rows) {
      if (!desktopAccountPermitted(policy, row.userId, row.isAdmin)) continue;
      const qualified = (queue: string) => scopes[queue].some((key) => row.held.includes(key));
      const queue = row.busy
        ? queues.find((name) => name === row.busyQueue && qualified(name))
        : queues.find((name) => hasWork.has(name) && qualified(name));
      if (queue) capacity[queue]++;
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
