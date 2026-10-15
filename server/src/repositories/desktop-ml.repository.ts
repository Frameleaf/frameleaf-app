import { Injectable } from '@nestjs/common';
import { type Kysely, type Selectable, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import z from 'zod';
import { DB } from 'src/schema/index.js';
import { DesktopMlAttemptTable, DesktopMlTaskTable } from 'src/schema/tables/desktop-ml-task.table.js';
import { canonicalJson } from 'src/utils/object.js';

export type DesktopMlTables = {
  desktop_ml_task: DesktopMlTaskTable;
  desktop_ml_attempt: DesktopMlAttemptTable;
};
type DesktopMlDatabase = DB & DesktopMlTables;
export type DesktopWorkerGrant = { deviceId: string; authorizationEpoch: number };
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
  'createdAt',
  'deadlineAt',
] as const;
export type DesktopMlClaim = { task: Omit<Task, 'input'>; attempt: Attempt };
export type DesktopMlRequest = Pick<Task, 'ownerId' | 'modelKey' | 'authorityKey' | 'config' | 'inputKind'> & {
  input: Buffer;
  deadlineAt: Date;
};
const jsonObject = z.record(z.string(), z.json());
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const leaseEnd = (deadline: Date) => sql<Date>`least(${deadline}, clock_timestamp() + interval '90 seconds')`;

@Injectable()
export class DesktopMlRepository {
  private db: Kysely<DesktopMlDatabase>;

  constructor(@InjectKysely() db: Kysely<DB>) {
    this.db = db.withTables<DesktopMlTables>();
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
        })
        .returning(taskColumns)
        .executeTakeFirstOrThrow();
      return row;
    });
  }

  async claim(grant: DesktopWorkerGrant, modelKeys: string[]): Promise<DesktopMlClaim | undefined> {
    if (modelKeys.length === 0 || modelKeys.length > 64) return;
    return this.db.transaction().execute(async (db) => {
      if (!(await this.device(db, grant))) return;
      const busy = await db
        .selectFrom('desktop_ml_attempt as attempt')
        .innerJoin('desktop_ml_task as task', 'task.attemptId', 'attempt.id')
        .select('attempt.id')
        .where('attempt.deviceId', '=', grant.deviceId)
        .where('attempt.authorizationEpoch', '=', grant.authorizationEpoch)
        .where('attempt.expiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('attempt.outcome', 'is', null)
        .where('task.state', '=', 'running')
        .where('task.deadlineAt', '>', sql<Date>`clock_timestamp()`)
        .limit(1)
        .executeTakeFirst();
      if (busy) return;

      const task = await db
        .selectFrom('desktop_ml_task')
        .select(taskColumns)
        .where('modelKey', 'in', modelKeys)
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
          authorizationEpoch: grant.authorizationEpoch,
          generation: task.generation + 1,
          expiresAt: leaseEnd(new Date(task.deadlineAt)),
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
    return (
      (await this.withAttempt(grant, attemptId, async (db, task) => {
        await db
          .updateTable('desktop_ml_attempt')
          .set({ expiresAt: leaseEnd(new Date(task.deadlineAt)) })
          .where('id', '=', attemptId)
          .execute();
        return true;
      })) ?? false
    );
  }

  /** Stages a result only. The NAS dispatcher must revalidate asset/route authority before adopting it. */
  async complete(grant: DesktopWorkerGrant, attemptId: string, value: Record<string, unknown>): Promise<boolean> {
    const result = jsonObject.parse(value);
    if (Buffer.byteLength(canonicalJson(result)) > 4 * 1024 * 1024) throw new Error('desktop_result_too_large');
    return (
      (await this.withAttempt(grant, attemptId, async (db, task) => {
        await db
          .updateTable('desktop_ml_task')
          .set({ state: 'completed', result, input: null })
          .where('id', '=', task.id)
          .execute();
        await db.updateTable('desktop_ml_attempt').set({ outcome: 'completed' }).where('id', '=', attemptId).execute();
        return true;
      })) ?? false
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

  result(id: string): Promise<TaskMetadata | undefined> {
    return this.db.selectFrom('desktop_ml_task').select(taskColumns).where('id', '=', id).executeTakeFirst();
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
        .select(['attempt.id', 'attempt.deviceId', 'attempt.authorizationEpoch', 'attempt.generation'])
        .where('task.id', '=', id)
        .where('task.state', '=', 'completed')
        .where('attempt.outcome', '=', 'completed')
        .executeTakeFirst();
      if (!attempt || !(await this.device(db, attempt))) throw new Error('desktop_result_authority_lost');
      const task = await db
        .selectFrom('desktop_ml_task')
        .select('id')
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
      if (!task) throw new Error('desktop_result_authority_lost');
    };
    if (transaction) await assert(transaction.withTables<DesktopMlTables>());
    else await this.db.transaction().execute(assert);
  }

  async discard(id: string): Promise<void> {
    await this.db
      .deleteFrom('desktop_ml_task')
      .where('id', '=', id)
      .where('state', 'in', ['completed', 'cancelled', 'failed'])
      .execute();
  }

  private device(db: Transaction<DesktopMlDatabase>, grant: DesktopWorkerGrant) {
    return db
      .selectFrom('desktop_device')
      .select('id')
      .where('id', '=', grant.deviceId)
      .where('authorizationEpoch', '=', grant.authorizationEpoch)
      .where('state', '=', 'preparing')
      .where('mode', '=', 'client-worker')
      .where('revokedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
  }

  private withAttempt<T>(
    grant: DesktopWorkerGrant,
    id: string,
    operation: (db: Transaction<DesktopMlDatabase>, task: TaskMetadata) => Promise<T>,
  ): Promise<T | undefined> {
    return this.db.transaction().execute(async (db) => {
      if (!(await this.device(db, grant))) return;
      const attempt = await db
        .selectFrom('desktop_ml_attempt')
        .selectAll()
        .where('id', '=', id)
        .where('deviceId', '=', grant.deviceId)
        .where('authorizationEpoch', '=', grant.authorizationEpoch)
        .executeTakeFirst();
      if (!attempt) return;
      const task = await db
        .selectFrom('desktop_ml_task')
        .select(taskColumns)
        .where('id', '=', attempt.taskId)
        .where('attemptId', '=', id)
        .where('generation', '=', attempt.generation)
        .where('state', '=', 'running')
        .where('deadlineAt', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (!task) return;
      const live = await db
        .selectFrom('desktop_ml_attempt')
        .select('id')
        .where('id', '=', id)
        .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('outcome', 'is', null)
        .executeTakeFirst();
      if (!live) return;
      return operation(db, task);
    });
  }
}
