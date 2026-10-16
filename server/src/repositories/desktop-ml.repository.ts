import { Injectable } from '@nestjs/common';
import { type Kysely, type Selectable, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import z from 'zod';
import {
  type DesktopWorkerGrant,
  type DesktopWorkerTables,
  lockDesktopWorker,
  lockDesktopWorkerForAdoption,
} from 'src/repositories/desktop-worker.repository.js';
import { DB } from 'src/schema/index.js';

export type { DesktopWorkerGrant } from 'src/repositories/desktop-worker.repository.js';
import { DesktopMlAttemptTable, DesktopMlTaskTable } from 'src/schema/tables/desktop-ml-task.table.js';
import { type DesktopQualificationTables } from 'src/schema/tables/desktop-worker-qualification.table.js';
import { canonicalJson } from 'src/utils/object.js';

export type DesktopMlTables = {
  desktop_ml_task: DesktopMlTaskTable;
  desktop_ml_attempt: DesktopMlAttemptTable;
};
type DesktopMlDatabase = DB & DesktopMlTables & DesktopWorkerTables & DesktopQualificationTables;
type Task = Selectable<DesktopMlTaskTable>;
type Attempt = Selectable<DesktopMlAttemptTable>;
type TaskMetadata = Omit<Task, 'input'>;
const taskColumns = [
  'id',
  'ownerId',
  'modelKey',
  'authorityKey',
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
export type DesktopMlClaim = { task: Omit<Task, 'input'>; attempt: Attempt; qualificationExpiresAt: Date };
export type DesktopMlRequest = Pick<Task, 'ownerId' | 'modelKey' | 'authorityKey' | 'config' | 'inputKind'> & {
  input: Buffer;
  deadlineAt: Date;
};
const jsonObject = z.record(z.string(), z.json());
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const leaseEnd = (deadline: Date, credentialExpiry: Date) =>
  sql<Date>`least(${deadline}, ${credentialExpiry}, clock_timestamp() + interval '120 seconds')`;

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
        if (!modelKeys.includes(busy.modelKey)) return;
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
        if (task.ownerId !== worker.ownerId) return;
        const qualification = await this.qualification(db, grant, task, attempt.qualificationId);
        if (!qualification) return;
        return { task, attempt, qualificationExpiresAt: new Date(qualification.expiresAt) };
      }

      const task = await db
        .selectFrom('desktop_ml_task')
        .select(taskColumns)
        .where('ownerId', '=', worker.ownerId)
        .where((eb) =>
          eb.or(
            qualifications.map((q) =>
              eb.and([
                eb('modelKey', '=', q.modelKey),
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
        (q) => q.modelKey === task.modelKey && q.configSha256 === task.configSha256 && q.inputKind === task.inputKind,
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
        qualificationExpiresAt: new Date(qualification.expiresAt),
      };
    });
  }

  input(grant: DesktopWorkerGrant, attemptId: string): Promise<Buffer | undefined> {
    return this.withAttempt(grant, attemptId, async (db, task) => {
      const row = await db.selectFrom('desktop_ml_task').select('input').where('id', '=', task.id).executeTakeFirst();
      return row?.input ?? undefined;
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
  async complete(grant: DesktopWorkerGrant, attemptId: string, value: Record<string, unknown>): Promise<boolean> {
    const result = jsonObject.parse(value);
    const encoded = canonicalJson(result);
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('desktop_result_too_large');
    const resultSha256 = sha256(encoded);
    const accepted = await this.withAttempt(grant, attemptId, async (db, task) => {
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

  async fail(grant: DesktopWorkerGrant, attemptId: string): Promise<boolean> {
    return (
      (await this.withAttempt(grant, attemptId, async (db, task) => {
        const exhausted = task.generation >= 3;
        await db
          .updateTable('desktop_ml_task')
          .set({
            state: exhausted ? 'failed' : 'pending',
            attemptId: null,
            input: exhausted ? null : sql<Buffer>`input`,
          })
          .where('id', '=', task.id)
          .execute();
        await db.updateTable('desktop_ml_attempt').set({ outcome: 'failed' }).where('id', '=', attemptId).execute();
        return true;
      })) ?? false
    );
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
    const { rows } = await sql<{ live: boolean }>`SELECT EXISTS (
      SELECT 1 FROM desktop_ml_task t
      JOIN desktop_ml_attempt a ON a.id=t."attemptId" AND a."taskId"=t.id AND a.generation=t.generation
      JOIN desktop_worker_session w ON w.id=a."workerSessionId" AND w."deviceId"=a."deviceId"
      JOIN desktop_device d ON d.id=a."deviceId"
      JOIN "user" u ON u.id=d."userId" AND u.id=t."ownerId"
      JOIN session p ON p.id=w."photoSessionId" AND p."userId"=u.id
      JOIN desktop_worker_qualification q ON q.id=a."qualificationId" AND q."sessionId"=w.id
        AND q."deviceId"=d.id AND q."authorizationEpoch"=d."authorizationEpoch"
        AND q."modelKey"=t."modelKey" AND q."configSha256"=t."configSha256" AND q."inputKind"=t."inputKind"
      WHERE t.id=${id} AND t.state='running' AND t."deadlineAt">clock_timestamp()
        AND a.outcome IS NULL AND a."expiresAt">clock_timestamp()
        AND a."authorizationEpoch"=d."authorizationEpoch" AND w."authorizationEpoch"=d."authorizationEpoch"
        AND w."revokedAt" IS NULL AND w."expiresAt">clock_timestamp()
        AND w."lastSeenAt">clock_timestamp()-interval '90 seconds'
        AND w."modelKeys" @> jsonb_build_array(t."modelKey") AND q."expiresAt">clock_timestamp()
        AND d.state='preparing' AND d.mode='client-worker' AND d."revokedAt" IS NULL
        AND u."isAdmin" AND u."deletedAt" IS NULL AND (p."expiresAt" IS NULL OR p."expiresAt">clock_timestamp())
    ) AS live`.execute(this.db);
    return rows[0]?.live;
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
      if (!worker || worker.ownerId !== expected.ownerId || !worker.modelKeys.includes(expected.modelKey))
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
      if (
        !task ||
        !(await this.qualification(
          db,
          { ...attempt, sessionId: attempt.workerSessionId },
          task,
          attempt.qualificationId,
        ))
      )
        throw new Error('desktop_result_authority_lost');
    };
    if (transaction)
      await assert(transaction.withTables<DesktopMlTables & DesktopWorkerTables & DesktopQualificationTables>());
    else await this.db.transaction().execute(assert);
  }

  async discard(id: string): Promise<void> {
    await this.db
      .updateTable('desktop_ml_task')
      .set({ state: 'consumed', result: null, input: null, config: sql<Record<string, unknown>>`'{}'::jsonb` })
      .where('id', '=', id)
      .where('state', '=', 'completed')
      .execute();
    await this.db
      .deleteFrom('desktop_ml_task')
      .where('id', '=', id)
      .where('state', 'in', ['cancelled', 'failed'])
      .execute();
  }

  private qualification(
    db: Transaction<DesktopMlDatabase>,
    grant: Omit<DesktopWorkerGrant, 'credentialHash'>,
    task: Pick<Task, 'modelKey' | 'configSha256' | 'inputKind'>,
    id: string | null,
  ) {
    if (!id) return Promise.resolve(undefined);
    return db
      .selectFrom('desktop_worker_qualification')
      .selectAll()
      .where('id', '=', id)
      .where('sessionId', '=', grant.sessionId)
      .where('deviceId', '=', grant.deviceId)
      .where('authorizationEpoch', '=', grant.authorizationEpoch)
      .where('modelKey', '=', task.modelKey)
      .where('configSha256', '=', task.configSha256)
      .where('inputKind', '=', task.inputKind)
      .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
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
  ): Promise<T | undefined> {
    return this.db.transaction().execute(async (db) => {
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
      if (!task || task.ownerId !== worker.ownerId || !worker.modelKeys.includes(task.modelKey)) return;
      const qualification = await this.qualification(db, grant, task, attempt.qualificationId);
      if (!qualification) return;
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
    });
  }
}
