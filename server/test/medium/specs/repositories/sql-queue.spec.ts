import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MessageChannel, Worker } from 'node:worker_threads';
import postgres from 'postgres';
import type { JobItem } from 'src/types.js';
import {
  JobName,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  MlWorkload,
  QueueName,
} from 'src/enum.js';
import { publishJobDiagnostic, publishJobResult, queueExecution } from 'src/queue/context.js';
import { feedManifest, freezeSelection } from 'src/queue/manifest.js';
import { queueNotifications } from 'src/queue/notifications.js';
import { SqlQueueStore, resetQueueAfterRestore } from 'src/queue/store.js';
import { superviseQueueWorker } from 'src/queue/supervisor.js';
import { publicationDatabase, publicationTransaction } from 'src/queue/transaction.js';
import { QUEUE_HIGH_WATER, QUEUE_TIMING, QueueClaim, QueueIntent } from 'src/queue/types.js';
import { QueueWatchdog, monitorQueueProgress } from 'src/queue/watchdog.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { MlDestinationRefusedError } from 'src/utils/ml-destination.js';
import { PIPELINE_MEDIA } from 'test/medium/scale.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** Real PostgreSQL races and rollback tests. Runs in the hosted medium suite, never on the operator Mac. */
describe('PostgreSQL queue', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let workerA: string;
  let workerB: string;
  let capturedQueries: string[] | undefined;
  const intent = (extra: Partial<QueueIntent> = {}): QueueIntent => ({
    queue,
    name: 'thumbnail',
    data: { id: randomUUID() },
    safeToRetry: true,
    sensitive: false,
    deadlineMs: QUEUE_TIMING.opaqueDeadline,
    ...extra,
  });
  beforeAll(async () => {
    db = await getKyselyDB(undefined, (event) => {
      if (event.level === 'query') capturedQueries?.push(event.query.sql);
    });
    store = new SqlQueueStore(db);
  });
  beforeEach(async () => {
    queue = `test-${randomUUID()}`;
    workerA = randomUUID();
    workerB = randomUUID();
    await store.initialize([queue], workerA);
    await store.initialize([], workerB);
  });

  it('discovers paused manifest-only work and pending producers in one read without treating retained terminal jobs as work', async () => {
    const producerQueue = `${queue}-producer`;
    const idleQueue = `${queue}-idle`;
    await store.initialize([producerQueue, idleQueue]);
    await store.enqueue([intent({ queue: producerQueue, name: 'producer' }), intent({ queue: idleQueue })]);
    const [finished] = await store.claim(idleQueue, workerA);
    await store.complete(finished, []);
    const runId = await freezeSelection(
      db,
      intent(),
      db.selectFrom('job_worker').select('id').where('id', '=', workerA),
    );
    await store.pause(queue, true);
    expect((await sql`select id from job where queue = ${queue}`.execute(db)).rows).toEqual([]);
    capturedQueries = [];
    try {
      expect((await store.queuesWithUnfinishedWork([idleQueue, queue, producerQueue])).sort()).toEqual(
        [queue, producerQueue].sort(),
      );
      expect(capturedQueries).toHaveLength(1);
      expect(await store.claim(queue, workerA)).toEqual([]);
      expect(await store.feedManifest(queue)).toBe(0);
      await store.pause(queue, false);
      expect(await store.feedManifest(queue)).toBe(1);
      const [selected] = await store.claim(queue, workerA);
      expect(selected.runId).toBe(runId);
      await store.complete(selected, []);
      const [producer] = await store.claim(producerQueue, workerA);
      await store.complete(producer, []);
      expect(await store.queuesWithUnfinishedWork([queue, producerQueue, idleQueue])).toEqual([]);
      capturedQueries = [];
      expect(await store.queuesWithUnfinishedWork([])).toEqual([]);
      expect(capturedQueries).toEqual([]);
    } finally {
      capturedQueries = undefined;
    }
  });

  it('finishes an empty manifest page without linkage updates or a recount and clears filling state', async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    await sql`update job_queue set "manifestFilling" = true where name = ${queue}`.execute(db);
    capturedQueries = [];
    try {
      expect(await feedManifest(db, queue, enqueue)).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
      expect(capturedQueries.filter((query) => query.startsWith('update job_run_item'))).toEqual([]);
      expect(capturedQueries.filter((query) => query.includes('select count(*)::int count from job'))).toHaveLength(1);
      expect((await sql`select "manifestFilling" from job_queue where name = ${queue}`.execute(db)).rows).toEqual([
        { manifestFilling: false },
      ]);
      capturedQueries = [];
      expect(await feedManifest(db, queue, enqueue)).toBe(0);
      expect(capturedQueries.filter((query) => query.startsWith('update job_queue'))).toEqual([]);
    } finally {
      capturedQueries = undefined;
    }
  });

  it('stops after an empty promotion page while still claiming waiting work and preserving pending eligibility', async () => {
    capturedQueries = [];
    try {
      expect(await store.claim(queue, workerA)).toEqual([]);
      expect(capturedQueries.filter((query) => query.startsWith("update job set state = 'waiting'"))).toHaveLength(1);
      await store.enqueue([intent(), intent({ options: { delay: 30_000 } })]);
      const { rows: waiting } = await sql<{ id: string }>`update job set state = 'waiting'
        where queue = ${queue} and "availableAt" <= now() returning id`.execute(db);
      await store.enqueue([intent({ parentId: waiting[0].id })]);
      capturedQueries = [];
      const [claim] = await store.claim(queue, workerA);
      expect(claim.id).toBe(waiting[0].id);
      expect(claim.attempt).toBe(1);
      expect(capturedQueries.filter((query) => query.startsWith("update job set state = 'waiting'"))).toHaveLength(1);
      expect(
        (await sql`select id from job where queue = ${queue} and state = 'pending'`.execute(db)).rows,
      ).toHaveLength(2);
      expect(await store.complete(claim, [])).toBe(true);
      expect(await store.claim(queue, workerB)).toHaveLength(1);
      expect(
        (await sql`select id from job where queue = ${queue} and state = 'pending'`.execute(db)).rows,
      ).toHaveLength(1);
    } finally {
      capturedQueries = undefined;
    }
  });

  it('restores safe work within its existing retry budget and never independently resumes operation jobs', async () => {
    await store.setConcurrency(queue, 4);
    await store.enqueue([
      intent({ data: { kind: 'safe' } }),
      intent({ safeToRetry: false, data: { kind: 'unsafe' } }),
      intent({ data: { kind: 'operation', operationId: randomUUID() } }),
      intent({ data: { kind: 'cancelled' } }),
    ]);
    const claims = await store.claim(queue, workerA);
    expect(claims).toHaveLength(4);
    const cancelled = claims.find(({ data }) => data.kind === 'cancelled')!;
    await sql`update job set "cancelRequestedAt" = now(), "cancelReason" = 'request'
      where id = ${cancelled.id}::uuid`.execute(db);
    await recordStoppedAttempt(db, cancelled.id, cancelled.token);
    await resetQueueAfterRestore(db);
    await resetQueueAfterRestore(db); // resumed recovery must be idempotent
    const { rows } = await sql<{ kind: string; state: string; token: string | null; attempt: number }>`select
      data->>'kind' kind, state, token, attempt from job where queue = ${queue}`.execute(db);
    expect(rows).toEqual(
      expect.arrayContaining([
        { kind: 'safe', state: 'pending', token: null, attempt: 1 },
        { kind: 'unsafe', state: 'needs_attention', token: null, attempt: 1 },
        { kind: 'operation', state: 'needs_attention', token: null, attempt: 1 },
        { kind: 'cancelled', state: 'cancelled', token: null, attempt: 1 },
      ]),
    );
    for (const claim of claims) {
      expect(await store.complete(claim, [])).toBe(false);
    }
    await sql`update job set "availableAt" = now() where queue = ${queue}`.execute(db);
    const [retry] = await store.claim(queue, workerB);
    expect(retry.data.kind).toBe('safe');
    expect(retry.attempt).toBe(2);
    await store.fail(retry, 'exhausted');
    expect(await store.claim(queue, workerB)).toEqual([]);
  });

  it('discards active snapshot backup invocations without replay or fabricated completion', async () => {
    const backupQueue = QueueName.BackupDatabase;
    const testId = randomUUID();
    const runId = await store.createRun('snapshot-backup', {});
    const backup = (kind: string, data: Record<string, unknown> = {}): QueueIntent =>
      intent({
        name: JobName.DatabaseBackup,
        queue: backupQueue,
        safeToRetry: false,
        data: { kind, testId, ...data },
      });
    await store.initialize([backupQueue]);
    await store.setConcurrency(backupQueue, 3);
    try {
      await store.enqueue([
        { ...backup('retry'), safeToRetry: true, runId, itemKey: 'backup' },
        backup('exhausted'),
        backup('operation', { operationId: randomUUID() }),
      ]);
      await store.finishEnumeration(runId);
      const originals = await store.claim(backupQueue, workerA);
      expect(originals).toHaveLength(3);
      const first = originals.find((claim) => claim.data.kind === 'retry')!;
      const exhausted = originals.find((claim) => claim.data.kind === 'exhausted')!;
      await sql`update job set "safeToRetry" = true where id = ${exhausted.id}::uuid`.execute(db);
      await store.fail(exhausted, 'first attempt failed');
      await sql`update job set "availableAt" = now() where id = ${exhausted.id}::uuid`.execute(db);
      const [second] = await store.claim(backupQueue, workerA);
      expect(second.id).toBe(exhausted.id);
      expect(second.attempt).toBe(2);
      // Simulate the old serialized classification after a real second claim was recorded.
      await sql`update job set "safeToRetry" = false where id = ${second.id}::uuid`.execute(db);
      await store.enqueue([backup('not-started'), { ...backup('wrong-queue'), queue }]);
      await resetQueueAfterRestore(db);
      await resetQueueAfterRestore(db);
      expect(
        (
          await sql`select data->>'kind' kind, state, attempt, "retryBaseAttempt", "safeToRetry", token
        from job where data->>'testId' = ${testId}`.execute(db)
        ).rows,
      ).toEqual(
        expect.arrayContaining([
          { kind: 'retry', state: 'cancelled', attempt: 1, retryBaseAttempt: 0, safeToRetry: true, token: null },
          { kind: 'not-started', state: 'pending', attempt: 0, retryBaseAttempt: 0, safeToRetry: true, token: null },
          {
            kind: 'exhausted',
            state: 'cancelled',
            attempt: 2,
            retryBaseAttempt: 0,
            safeToRetry: true,
            token: null,
          },
          {
            kind: 'operation',
            state: 'needs_attention',
            attempt: 1,
            retryBaseAttempt: 0,
            safeToRetry: false,
            token: null,
          },
          {
            kind: 'wrong-queue',
            state: 'needs_attention',
            attempt: 0,
            retryBaseAttempt: 0,
            safeToRetry: false,
            token: null,
          },
        ]),
      );
      for (const stale of [...originals, second]) expect(await store.complete(stale, [])).toBe(false);
      expect(
        (
          await sql`select a.outcome, a.token, a."workerId", a."finishedAt" is not null settled
        from job_attempt a join job j on j.id = a."jobId"
        where j.data->>'testId' = ${testId} and j.data->>'kind' in ('retry','exhausted')
        order by j.data->>'kind', a.attempt`.execute(db)
        ).rows,
      ).toEqual([
        { outcome: 'pending', token: exhausted.token, workerId: workerA, settled: true },
        { outcome: 'restored_discarded_backup', token: second.token, workerId: workerA, settled: true },
        { outcome: 'restored_discarded_backup', token: first.token, workerId: workerA, settled: true },
      ]);
      expect((await sql`select state from job_run_item where "runId" = ${runId}::uuid`.execute(db)).rows).toEqual([
        { state: 'cancelled' },
      ]);
      expect(
        (await sql`select "finishedAt" is not null settled from job_run where id = ${runId}::uuid`.execute(db)).rows,
      ).toEqual([{ settled: true }]);
      expect(
        (
          await sql`select key from system_metadata where key = ${'frameleaf-worker-stopped:' + workerA}
        or key = any(${[...originals, second].map(({ token }) => 'frameleaf-attempt-evidence:' + token)}::text[])`.execute(
            db,
          )
        ).rows,
      ).toEqual([]);
      await sql`update job set "availableAt" = now() where data->>'testId' = ${testId}`.execute(db);
      const retries = await store.claim(backupQueue, workerB);
      expect(retries).toHaveLength(1);
      expect(retries[0].data.kind).toBe('not-started');
      expect(retries[0].attempt).toBe(1);
      expect(await store.complete(retries[0], [])).toBe(true);
      expect(await store.claim(backupQueue, workerB)).toEqual([]);
      expect(
        (
          await sql`select data->>'kind' kind, state from job where data->>'testId' = ${testId}
        and data->>'kind' in ('retry','not-started')`.execute(db)
        ).rows,
      ).toEqual(
        expect.arrayContaining([
          { kind: 'retry', state: 'cancelled' },
          { kind: 'not-started', state: 'completed' },
        ]),
      );
    } finally {
      await sql`delete from job where data->>'testId' = ${testId}`.execute(db);
    }
  });

  it('commits failure diagnostics with the failed attempt, discarding successful effects and stale diagnostics', async () => {
    const table = `queue_diagnostic_${randomUUID().replaceAll('-', '')}`;
    await sql`create table ${sql.id(table)} (attempt integer not null, kind text not null)`.execute(db);
    try {
      const executor: JobRepository = new JobRepository(
        {} as never,
        {} as never,
        {
          emit: async () => {
            await publishJobResult(async () => {
              await sql`insert into ${sql.id(table)} values (99, 'success')`.execute(
                publicationTransaction.getStore()!,
              );
            });
            const attempt = queueExecution.getStore()!.claim.attempt;
            await publishJobDiagnostic(async () => {
              await sql`insert into ${sql.id(table)} values (${attempt}, 'failed')`.execute(
                publicationTransaction.getStore()!,
              );
            });
            await executor.collectFollowups(() =>
              executor.queue({ name: JobName.SmartSearch, data: { id: randomUUID() } }),
            );
            throw new Error('provider fixture refused');
          },
        } as never,
        { setContext: vi.fn(), error: vi.fn() } as never,
        db,
      );
      executor['handlers'][JobName.SmartSearch] = { queueName: queue as QueueName } as never;
      await store.enqueue([intent()]);
      const [first] = await store.claim(queue, workerA);
      await executor['execute'](first, new AbortController());
      const stale = vi.fn();
      expect(await store.fail(first, 'late error', stale)).toBe(false);
      expect(stale).not.toHaveBeenCalled();
      await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
      const [second] = await store.claim(queue, workerB);
      await executor['execute'](second, new AbortController());
      expect((await sql`select * from ${sql.id(table)} order by attempt`.execute(db)).rows).toEqual([
        { attempt: 1, kind: 'failed' },
        { attempt: 2, kind: 'failed' },
      ]);
      expect((await store.counts(queue)).failed).toBe(1);
      expect((await sql`select id from job where queue = ${queue}`.execute(db)).rows).toHaveLength(1);
    } finally {
      await sql`drop table ${sql.id(table)}`.execute(db);
    }
  });

  it('detects a real FFmpeg progress stall, terminates its executor, then accepts exactly one replacement', async () => {
    expect(spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status).toBe(0);
    await store.enqueue([intent()]);
    const [claim] = await store.claim(queue, workerA);
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'color=size=16x16:rate=10',
        '-progress',
        'pipe:1',
        '-stats_period',
        '0.05',
        '-f',
        'null',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const childExit = once(ffmpeg, 'exit');
    await once(ffmpeg, 'spawn');
    const worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');
        parentPort.postMessage({type:'queue-child',pid:workerData,active:true});
        parentPort.on('message', ({port,workerId})=>{parentPort.postMessage({type:'queue-watchdog-port',workerId,port},[port]);
        parentPort.postMessage({type:'ready'}); while(true) {} });`,
      { eval: true, workerData: ffmpeg.pid },
    );
    const supervised = superviseQueueWorker(worker, undefined, undefined, {
      recordStopped: async (proof) => {
        await sql`insert into system_metadata(key,value)
            values (${'frameleaf-worker-stopped:' + proof.workerId}, ${JSON.stringify(proof)}::text::jsonb)`.execute(
          db,
        );
      },
    });
    const workerExit = once(worker, 'exit');
    const { port1, port2 } = new MessageChannel();
    const ready = new Promise<void>((resolve) =>
      worker.on('message', (m) => {
        if (m.type === 'ready') resolve();
      }),
    );
    worker.postMessage({ workerId: workerA, port: port1 }, [port1]);
    await ready;
    const watchdog = new QueueWatchdog({ noProgressDeadline: 150, cancelGrace: 100, lease: 5000 });
    watchdog.add(claim.id, performance.now(), 3000);
    let units = 0;
    let cancelled = false;
    const progress = new Promise<void>((resolve) =>
      ffmpeg.stdout!.on('data', (chunk) => {
        const match = /out_time_us=(\d+)/.exec(String(chunk));
        if (match && Number(match[1]) > units) {
          units = Number(match[1]);
          watchdog.progress(claim.id, units, performance.now());
          resolve();
        }
      }),
    );
    const stop = monitorQueueProgress(
      watchdog,
      {
        alive: () => port2.postMessage({ type: 'alive' }),
        cancel: (id) => {
          expect(id).toBe(claim.id);
          cancelled = true;
          worker.postMessage({ type: 'cancel', id });
        },
        terminate: () => port2.postMessage({ type: 'terminate' }),
        lastHeartbeat: () => performance.now(),
      },
      20,
    );
    try {
      await progress;
      process.kill(ffmpeg.pid!, 'SIGSTOP');
      expect((await workerExit)[0]).toBe(1);
      expect((await childExit)[1]).toBe('SIGKILL');
      await supervised.stopped;
      expect(cancelled).toBe(true);
      expect(
        (await sql`select value from system_metadata where key = ${'frameleaf-worker-stopped:' + workerA}`.execute(db))
          .rows,
      ).toEqual([{ value: { workerId: workerA, stoppedAt: expect.any(Number) } }]);
      // Advance only database lease/retry time after real process death. No terminal states are injected.
      await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${claim.id}::uuid`.execute(db);
      await store.recoverExpired();
      expect(await store.complete(claim, [])).toBe(false);
      await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
      const replacements = await store.claim(queue, workerB);
      expect(replacements).toHaveLength(1);
      expect(replacements[0].attempt).toBe(2);
      expect(await store.complete(replacements[0], [])).toBe(true);
      expect(await store.claim(queue, workerA)).toEqual([]);
    } finally {
      stop();
      port2.close();
      ffmpeg.kill('SIGKILL');
      await worker.terminate();
    }
  }, 15_000);

  it('rejects prepared media when its original path changes before acceptance', async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const adopted = vi.fn();
    const executor: JobRepository = new JobRepository(
      {} as never,
      {} as never,
      {
        emit: async () => {
          await executor.guardAssetSource(asset.id);
          await db
            .updateTable('asset')
            .set({ originalPath: `${asset.originalPath}.replaced` })
            .where('id', '=', asset.id)
            .execute();
          await publishJobResult(() => {
            adopted();
            return Promise.resolve();
          });
        },
      } as never,
      { setContext: vi.fn(), error: vi.fn() } as never,
      db,
    );
    await store.enqueue([intent({ data: { id: asset.id } })]);
    const [claim] = await store.claim(queue, workerA);
    await executor['execute'](claim, new AbortController());
    expect(adopted).not.toHaveBeenCalled();
    expect((await store.counts(queue)).delayed).toBe(1);
  });

  it('keeps face sub-stages distinct while all descendants count toward their selected asset', async () => {
    const runId = await store.createRun('face-fixture', {});
    const root = randomUUID();
    await store.enqueue([intent({ runId, itemKey: root, rootItemKey: root })]);
    const [claim] = await store.claim(queue, workerA);
    const face = randomUUID();
    expect(
      await store.complete(claim, [
        intent({ name: JobName.FacialRecognition, data: { id: face }, runId, itemKey: face, rootItemKey: root }),
      ]),
    ).toBe(true);
    const [recognition] = await store.claim(queue, workerB);
    const executor = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    executor['handlers'][JobName.FacialRecognition] = { queueName: queue as QueueName } as never;
    const next = queueExecution.run(
      {
        claim: recognition,
        signal: new AbortController().signal,
        progress: vi.fn(),
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: true,
      },
      () => executor['intent']({ name: JobName.FacialRecognition, data: { id: face, deferred: true } }),
    );
    expect(next.itemKey).toBe(`${face}/deferred`);
    expect(next.rootItemKey).toBe(root);
    expect(await store.complete(recognition, [next])).toBe(true);
    const [deferred] = await store.claim(queue, workerA);
    expect(deferred.itemKey).toBe(`${face}/deferred`);
    expect(deferred.rootItemKey).toBe(root);
    expect(await store.complete(deferred, [])).toBe(true);
    const {
      rows: [counts],
    } = await sql<{ items: number; stages: number }>`select count(distinct "rootItemKey")::int items,
      count(*)::int stages from job_run_item where "runId" = ${runId}::uuid`.execute(db);
    expect(counts).toEqual({ items: 1, stages: 3 });
  });

  it('wakes through a real dedicated LISTEN session while durable admission still works without it', async () => {
    const {
      rows: [database],
    } = await sql<{ name: string }>`select current_database() name`.execute(db);
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = `/${database.name}`;
    const listener = postgres(url.href, { max: 1, connect_timeout: 5 });
    let wake = Promise.withResolvers<void>();
    const notifications = queueNotifications(listener, () => wake.resolve());
    notifications.connect();
    try {
      await wake.promise; // initial LISTEN acknowledgement
      wake = Promise.withResolvers<void>();
      await store.enqueue([intent()]);
      await wake.promise; // transaction's real pg_notify
      const [claim] = await store.claim(queue, workerA);
      expect(await store.complete(claim, [])).toBe(true);
      await notifications.close();
      await store.enqueue([intent()]);
      expect(await store.claim(queue, workerB)).toHaveLength(1); // no listener required for the scan
    } finally {
      await notifications.close();
    }
  }, 15_000);

  it('defers caught ML admission failures without spending retries or completing selected items', async () => {
    const runId = await store.createRun('unavailable-fixture', {});
    const id = randomUUID();
    await store.enqueue([intent({ name: JobName.SmartSearch, runId, itemKey: id, rootItemKey: id })]);
    let unavailable = true;
    let genuineFailures = 0;
    const adopted = vi.fn();
    const diagnosed = vi.fn();
    const executor: JobRepository = new JobRepository(
      {} as never,
      {} as never,
      { emit: async (_event: string, _queue: string, item: JobItem) => executor.run(item) } as never,
      { setContext: vi.fn(), error: vi.fn() } as never,
      db,
    );
    executor['handlers'][JobName.SmartSearch] = {
      queueName: queue as QueueName,
      handler: async () => {
        await publishJobResult(() => {
          adopted();
          return Promise.resolve();
        });
        if (unavailable) {
          try {
            throw new MlDestinationRefusedError(
              MlAdmissionRefusal.DestinationUnhealthy,
              MlWorkload.Clip,
              id,
              'fixture',
            );
          } catch {
            await publishJobDiagnostic(() => {
              diagnosed();
              return Promise.resolve();
            });
            return JobStatus.Failed;
          }
        }
        if (genuineFailures++ === 0) throw new Error('actual inference failed');
        return JobStatus.Success;
      },
    } as never;
    for (let index = 0; index < 3; index++) {
      const [claim] = await store.claim(queue, workerA);
      await executor['execute'](claim, new AbortController());
      const {
        rows: [job],
      } = await sql<{ state: string; attempt: number; base: number; reason: string }>`select state, attempt,
        "retryBaseAttempt" base, "dependencyReason" reason from job where id = ${claim.id}::uuid`.execute(db);
      expect(job).toEqual({ state: 'pending', attempt: index + 1, base: index + 1, reason: 'destination-unavailable' });
      expect(await store.defer(claim, 'destination-unavailable')).toBe(false); // stale credit cannot be refunded twice
      await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
    }
    expect(adopted).not.toHaveBeenCalled();
    expect(diagnosed).not.toHaveBeenCalled();
    expect((await sql`select state from job_run_item where "runId" = ${runId}::uuid`.execute(db)).rows).toEqual([
      { state: 'pending' },
    ]);
    unavailable = false;
    const [failed] = await store.claim(queue, workerA);
    await executor['execute'](failed, new AbortController());
    expect(adopted).not.toHaveBeenCalled();
    await sql`update job set "availableAt" = now() where id = ${failed.id}::uuid`.execute(db);
    const [retry] = await store.claim(queue, workerB);
    await executor['execute'](retry, new AbortController());
    expect(adopted).toHaveBeenCalledOnce();
    expect(await store.claim(queue, workerA)).toEqual([]);
    expect(
      (await sql`select outcome from job_attempt where "jobId" = ${retry.id}::uuid order by attempt`.execute(db)).rows,
    ).toEqual([
      { outcome: 'deferred' },
      { outcome: 'deferred' },
      { outcome: 'deferred' },
      { outcome: 'pending' },
      { outcome: 'completed' },
    ]);
  });

  it('uses the configured idle deadline while accepting long work with recent advancing progress', async () => {
    await store.setConcurrency(queue, 2);
    await store.enqueue([intent(), intent()]);
    const [stalled, healthy] = await store.claim(queue, workerA);
    await sql`update job set "progressUnits" = 1, "startedAt" = now() - interval '2 hours',
      "progressAt" = now() - (${QUEUE_TIMING.noProgressDeadline}+1000) * interval '1 millisecond'
      where id = ${stalled.id}::uuid`.execute(db);
    await sql`update job set "progressUnits" = 1, "startedAt" = now() - interval '2 hours', "progressAt" = now()
      where id = ${healthy.id}::uuid`.execute(db);
    expect((await store.deadlines(workerA)).map(({ id }) => id)).toEqual([stalled.id]);
  });

  it('claims at most concurrency one across competing workers, without holding the connection during work', async () => {
    await store.enqueue([intent(), intent()]);
    const claims = (await Promise.all([store.claim(queue, workerA), store.claim(queue, workerB)])).flat();
    expect(claims).toHaveLength(1);
    await expect(sql`select 1`.execute(db)).resolves.toBeDefined();
    expect(await store.complete(claims[0], [])).toBe(true);
    expect(await store.claim(queue, workerB)).toHaveLength(1);
  });

  it('deduplicates concurrent arrivals and retains exactly the latest request while active', async () => {
    const options = { deduplication: { id: 'same', keepLastIfActive: true } };
    await Promise.all([store.enqueue([intent({ options })]), store.enqueue([intent({ options })])]);
    const [first] = await store.claim(queue, workerA);
    await store.enqueue([intent({ options, data: { value: 1 } }), intent({ options, data: { value: 2 } })]);
    await store.complete(first, []);
    const [next] = await store.claim(queue, workerB);
    expect(next.data).toEqual({ value: 2 });
    expect((await store.counts(queue)).active).toBe(1);
    expect((await store.counts(queue)).waiting).toBe(0);
  });

  it('observes pause and delayed availability even when no NOTIFY listener exists', async () => {
    await store.enqueue([intent({ options: { delay: 30_000 } })]);
    expect(await store.claim(queue, workerA)).toEqual([]);
    await sql`update job set "availableAt" = now() where queue = ${queue}`.execute(db);
    await store.pause(queue, true);
    expect(await store.claim(queue, workerA)).toEqual([]);
    await store.pause(queue, false);
    expect(await store.claim(queue, workerA)).toHaveLength(1);
  });

  it('retries a confirmed stopped safe attempt once and fences its late output and follow-up intents', async () => {
    await store.enqueue([intent()]);
    const [first] = await store.claim(queue, workerA);
    await recordStoppedAttempt(db, first.id, first.token);
    await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${first.id}::uuid`.execute(db);
    await store.recoverExpired();
    const adopted = vi.fn();
    expect(await store.complete(first, [intent()], adopted)).toBe(false);
    expect(adopted).not.toHaveBeenCalled();
    expect((await store.counts(queue)).delayed).toBe(1);
    await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
    const [second] = await store.claim(queue, workerB);
    expect(second.attempt).toBe(2);
    await store.fail(second, 'second failure');
    expect((await store.counts(queue)).failed).toBe(1);
    expect(await store.claim(queue, workerA)).toEqual([]);
  });

  it.each(['completed', 'failed', 'deferred', 'aborted', 'unsafe'] as const)(
    'settles explicit cancellation before the coordinator observes a %s handler return',
    async (outcome) => {
      const runId = await store.createRun('cancel-before-abort', {});
      await store.enqueue([
        intent({ runId, itemKey: 'parent', rootItemKey: 'parent', sensitive: true, safeToRetry: outcome !== 'unsafe' }),
      ]);
      const [claim] = await store.claim(queue, workerA);
      await store.enqueue([intent({ runId, itemKey: 'child', rootItemKey: 'parent', parentId: claim.id })]);
      await store.finishEnumeration(runId);
      const abort = new AbortController();
      const adopted = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const diagnosed = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const notified = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const handler = vi.fn(async () => {
        const execution = queueExecution.getStore()!;
        execution.adoptions.push(adopted);
        execution.failureDiagnostics = [diagnosed];
        execution.afterCommit = [notified];
        execution.followups.push(intent({ name: 'unpublished-followup' }));
        await sql`update job set "cancelRequestedAt" = now(), "cancelReason" = 'request'
          where id = ${claim.id}::uuid`.execute(db);
        expect(abort.signal.aborted).toBe(false); // the database sees it before the coordinator's message
        if (outcome === 'failed') throw new Error('fixture handler failure');
        if (outcome === 'deferred') execution.dependencyReason = 'destination-unavailable';
        else if (outcome === 'aborted') abort.abort(new Error('fixture cancellation'));
      });
      const executor = new JobRepository(
        {} as never,
        {} as never,
        { emit: handler } as never,
        { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
        db,
      );
      const complete = vi.spyOn(executor['store'], 'complete');
      await executor['execute'](claim, abort);
      expect(handler).toHaveBeenCalledOnce();
      if (outcome === 'completed' || outcome === 'unsafe') {
        expect(complete).toHaveBeenCalledOnce();
        await expect(complete.mock.results[0].value).resolves.toBe(false);
      }
      expect(adopted).not.toHaveBeenCalled();
      expect(diagnosed).not.toHaveBeenCalled();
      expect(notified).not.toHaveBeenCalled();
      const { rows: jobs } = await sql`select state, token, attempt, "retryBaseAttempt", data
        from job where id = ${claim.id}::uuid`.execute(db);
      expect(jobs).toEqual([{ state: 'cancelled', token: null, attempt: 1, retryBaseAttempt: 0, data: {} }]);
      const { rows: attempts } = await sql`select outcome, "finishedAt" is not null finished
        from job_attempt where token = ${claim.token}::uuid`.execute(db);
      expect(attempts).toEqual([{ outcome: 'cancelled', finished: true }]);
      const { rows: proofs } = await sql`select value->>'jobId' "jobId", value ? 'stoppedAt' stopped
        from system_metadata where key = ${'frameleaf-attempt-evidence:' + claim.token}`.execute(db);
      expect(proofs).toEqual([{ jobId: claim.id, stopped: true }]);
      const { rows: items } = await sql`select "itemKey", state from job_run_item
        where "runId" = ${runId}::uuid order by "itemKey"`.execute(db);
      expect(items).toEqual([
        { itemKey: 'child', state: 'blocked' },
        { itemKey: 'parent', state: 'cancelled' },
      ]);
      const { rows: runs } = await sql`select "finishedAt" is not null finished from job_run
        where id = ${runId}::uuid`.execute(db);
      expect(runs).toEqual([{ finished: true }]);
      expect(await store.complete(claim, [intent()], adopted)).toBe(false);
      expect(await store.retryFailed(queue)).toBe(0);
      expect(await store.claim(queue, workerB)).toEqual([]);
      expect(await store.hasUnfinishedWork(queue)).toBe(false);
    },
  );

  it.each([null, 'request'])(
    'requires matching stopped proof for cancellation cause %s, including after expiry',
    async (cause) => {
      await store.enqueue([intent()]);
      const [claim] = await store.claim(queue, workerA);
      await sql`update job set "cancelRequestedAt" = now(), "cancelReason" = ${cause}
        where id = ${claim.id}::uuid`.execute(db);
      await recordStoppedAttempt(db, claim.id, randomUUID());
      await sql`insert into system_metadata(key,value) values (${'frameleaf-worker-stopped:' + workerB},
        ${JSON.stringify({ workerId: workerB, stoppedAt: Date.now() })}::text::jsonb)`.execute(db);
      expect(await store.fail(claim, 'cancel', undefined, { stopRequestedOnly: true })).toBe(false);
      expect((await store.counts(queue)).active).toBe(1);
      await recordStoppedAttempt(db, claim.id, claim.token);
      expect(await store.fail({ ...claim, token: randomUUID() }, 'stale', undefined, { stopRequestedOnly: true })).toBe(
        false,
      );
      await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${claim.id}::uuid`.execute(db);
      await store.recoverExpired();
      const { rows } = await sql`select state, attempt from job where id = ${claim.id}::uuid`.execute(db);
      expect(rows).toEqual([{ state: 'cancelled', attempt: 1 }]);
      expect(await store.claim(queue, workerB)).toEqual([]);
    },
  );

  it('fences deadline output immediately, retries once after stopped proof, and lets an explicit request win', async () => {
    await store.enqueue([intent()]);
    const [first] = await store.claim(queue, workerA);
    const adopted = vi.fn();
    await sql`update job set "startedAt" = now() - interval '1 hour' where id = ${first.id}::uuid`.execute(db);
    expect((await store.deadlines(workerA)).map(({ id }) => id)).toContain(first.id);
    expect(await store.complete(first, [intent()], adopted)).toBe(false);
    expect(await store.fail(first, 'deadline', undefined, { stopRequestedOnly: true })).toBe(false);
    await recordStoppedAttempt(db, first.id, first.token);
    expect(await store.fail(first, 'deadline', undefined, { stopRequestedOnly: true })).toBe(true);
    expect(adopted).not.toHaveBeenCalled();
    const { rows: delayed } = await sql`select state, "cancelReason",
      "availableAt" = a."finishedAt" + interval '30 seconds' delayed
      from job j join job_attempt a on a."jobId" = j.id where j.id = ${first.id}::uuid`.execute(db);
    expect(delayed).toEqual([{ state: 'pending', cancelReason: 'deadline', delayed: true }]);
    await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
    const [second] = await store.claim(queue, workerB);
    expect(second.attempt).toBe(2);
    const { rows: renewed } = await sql`select "cancelRequestedAt", "cancelReason" from job
      where id = ${second.id}::uuid`.execute(db);
    expect(renewed).toEqual([{ cancelRequestedAt: null, cancelReason: null }]);
    await sql`update job set "startedAt" = now() - interval '1 hour' where id = ${second.id}::uuid`.execute(db);
    await store.deadlines(workerB);
    await recordStoppedAttempt(db, second.id, second.token);
    await store.fail(second, 'second deadline', undefined, { stopRequestedOnly: true });
    expect((await store.counts(queue)).failed).toBe(1);
    expect(await store.claim(queue, workerA)).toEqual([]);

    await store.enqueue([intent()]);
    const [requested] = await store.claim(queue, workerA);
    await sql`update job set "startedAt" = now() - interval '1 hour' where id = ${requested.id}::uuid`.execute(db);
    await store.deadlines(workerA);
    await sql`update job set "cancelReason" = 'request' where id = ${requested.id}::uuid`.execute(db);
    await store.deadlines(workerA); // later deadline scans cannot overwrite the explicit request
    await recordStoppedAttempt(db, requested.id, requested.token);
    await store.fail(requested, 'deadline and request', undefined, { stopRequestedOnly: true });
    const { rows: cancelled } = await sql`select state, "cancelReason" from job
      where id = ${requested.id}::uuid`.execute(db);
    expect(cancelled).toEqual([{ state: 'cancelled', cancelReason: 'request' }]);
    expect(await store.claim(queue, workerB)).toEqual([]);
  });

  it('does not replay legacy queued cancellations, including after restore or without matching stopped proof', async () => {
    const fixtures = [
      { cause: null, proof: true, state: 'pending' },
      { cause: null, proof: false, state: 'waiting' },
      { cause: 'request', proof: true, state: 'waiting' },
      { cause: 'request', proof: false, state: 'pending' },
      { cause: 'deadline', proof: true, state: 'pending' },
    ] as const;
    for (const restore of [false, true]) {
      const runId = await store.createRun('queued-cancellation', { restore });
      await store.setConcurrency(queue, fixtures.length);
      await store.enqueue(
        fixtures.map((fixture, index) =>
          intent({
            runId,
            itemKey: String(index),
            rootItemKey: String(index),
            sensitive: fixture.cause !== 'deadline',
          }),
        ),
      );
      const claims = await store.claim(queue, workerA);
      expect(claims).toHaveLength(fixtures.length);
      for (const claim of claims) {
        const fixture = fixtures[Number(claim.itemKey)];
        // Reproduce the former recovery result: attempt finished, token cleared, cancellation retained.
        await sql`update job set state = ${fixture.state}, token = null, "leaseExpiresAt" = null,
          "availableAt" = now(), "cancelRequestedAt" = now(), "cancelReason" = ${fixture.cause}
          where id = ${claim.id}::uuid`.execute(db);
        await sql`update job_attempt set outcome = 'pending', "finishedAt" = now()
          where token = ${claim.token}::uuid`.execute(db);
        await recordStoppedAttempt(db, claim.id, fixture.proof ? claim.token : randomUUID());
      }
      const unrelatedWorker = randomUUID();
      await sql`insert into system_metadata(key,value) values (${'frameleaf-worker-stopped:' + unrelatedWorker},
        ${JSON.stringify({ workerId: unrelatedWorker, stoppedAt: Date.now() })}::text::jsonb)`.execute(db);
      await store.finishEnumeration(runId);
      if (restore) {
        await resetQueueAfterRestore(db);
        await resetQueueAfterRestore(db);
      }
      const next = await store.claim(queue, workerB);
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({ itemKey: '4', attempt: 2 }); // only the deadline retains its retry
      await store.complete(next[0], []);
      const { rows } = await sql`select "itemKey", state, attempt, data from job
        where "runId" = ${runId}::uuid and "itemKey" != '4' order by "itemKey"`.execute(db);
      expect(rows).toEqual(
        fixtures.slice(0, 4).map((fixture, index) => ({
          itemKey: String(index),
          state: fixture.proof ? 'cancelled' : 'needs_attention',
          attempt: 1,
          data: {},
        })),
      );
      expect(
        (
          await sql`select "itemKey", state from job_run_item where "runId" = ${runId}::uuid
        order by "itemKey"`.execute(db)
        ).rows,
      ).toEqual([
        ...fixtures.slice(0, 4).map((fixture, index) => ({
          itemKey: String(index),
          state: fixture.proof ? 'cancelled' : 'needs_attention',
        })),
        { itemKey: '4', state: 'completed' },
      ]);
      const { rows: attempts } = await sql`select count(*)::int count, bool_and(a.outcome = 'pending') unchanged
        from job_attempt a join job j on j.id = a."jobId"
        where j."runId" = ${runId}::uuid and j."itemKey" != '4'`.execute(db);
      expect(attempts).toEqual([{ count: 4, unchanged: true }]);
      const { rows: missingProof } = await sql`select count(*)::int count from system_metadata m join job_attempt a
        on m.key = 'frameleaf-attempt-evidence:' || a.token::text join job j on j.id = a."jobId"
        where j."runId" = ${runId}::uuid and j."itemKey" in ('1','3')`.execute(db);
      expect(missingProof).toEqual([{ count: 0 }]);
      const { rows: attention } = await sql<{ error: string }>`select error from job
        where "runId" = ${runId}::uuid and state = 'needs_attention'`.execute(db);
      expect(attention).toHaveLength(2);
      expect(
        attention.every(({ error }) =>
          error.includes(restore ? 'Executor stop could not be confirmed' : 'sensitive details omitted'),
        ),
      ).toBe(true);
      for (const claim of claims) expect(await store.complete(claim, [])).toBe(false);
      expect(await store.claim(queue, workerA)).toEqual([]);
      expect(await store.retryFailed(queue)).toBe(0);
      expect(await store.hasUnfinishedWork(queue)).toBe(false);
      expect(
        (await sql`select "finishedAt" is not null finished from job_run where id = ${runId}::uuid`.execute(db)).rows,
      ).toEqual([{ finished: true }]);
    }
  });

  it('never replays an ambiguous external effect and keeps sensitive payloads out of failed history', async () => {
    await store.enqueue([intent({ safeToRetry: false, sensitive: true, data: { password: 'fixture-only' } })]);
    const [claim] = await store.claim(queue, workerA);
    await store.fail(claim, 'sensitive fixture error');
    const {
      rows: [row],
    } = await sql<{
      state: string;
      data: unknown;
      error: string;
    }>`select state, data, error from job where id = ${claim.id}::uuid`.execute(db);
    expect(row).toEqual({ state: 'needs_attention', data: {}, error: 'Job failed; sensitive details omitted' });
    expect(await store.retryFailed(queue)).toBe(0);
    expect(await store.claim(queue, workerB)).toEqual([]);
  });

  it.each([true, false])(
    'preserves deferred latest-request safety after a confirmed cancellation (safe=%s)',
    async (safeToRetry) => {
      const runId = await store.createRun('cancelled-predecessor', {});
      const latestRun = await store.createRun('latest-after-cancel', {});
      const options = { deduplication: { id: randomUUID(), keepLastIfActive: true } };
      await store.enqueue([intent({ runId, itemKey: 'old', rootItemKey: 'old', options })]);
      const [old] = await store.claim(queue, workerA);
      await store.enqueue([
        intent({ runId: latestRun, itemKey: 'latest', rootItemKey: 'latest', options, safeToRetry }),
        intent({ runId, itemKey: 'dependent', rootItemKey: 'old', parentId: old.id }),
      ]);
      await store.finishEnumeration(runId);
      await store.finishEnumeration(latestRun);
      await sql`update job set "cancelRequestedAt" = now(), "cancelReason" = 'request'
        where id = ${old.id}::uuid`.execute(db);
      await recordStoppedAttempt(db, old.id, old.token);
      expect(await store.fail(old, 'cancel', undefined, { stopRequestedOnly: true })).toBe(true);
      const { rows: original } = await sql`select "itemKey", state from job_run_item
        where "runId" = ${runId}::uuid order by "itemKey"`.execute(db);
      expect(original).toEqual([
        { itemKey: 'dependent', state: 'blocked' },
        { itemKey: 'old', state: 'cancelled' },
      ]);
      const { rows: latest } = await sql`select state from job_run_item where "runId" = ${latestRun}::uuid`.execute(db);
      expect(latest).toEqual([{ state: safeToRetry ? 'pending' : 'needs_attention' }]);
      const claims = await store.claim(queue, workerB);
      if (safeToRetry) {
        expect(claims).toHaveLength(1);
        expect(claims[0]).toMatchObject({ runId: latestRun, attempt: 1, itemKey: 'latest' });
        expect(claims[0].id).not.toBe(old.id);
        await store.complete(claims[0], []);
      } else {
        expect(claims).toEqual([]);
      }
      const { rows: attempts } = await sql`select outcome from job_attempt where "jobId" = ${old.id}::uuid`.execute(db);
      expect(attempts).toEqual([{ outcome: 'cancelled' }]);
      expect(await store.claim(queue, workerA)).toEqual([]);
    },
  );

  it('settles unconfirmed termination for attention without replaying the latest request or stopping independent items', async () => {
    const runId = await store.createRun('stop-unconfirmed', {});
    const latestRun = await store.createRun('latest-unconfirmed', {});
    const options = { deduplication: { id: randomUUID(), keepLastIfActive: true } };
    await store.enqueue([intent({ runId, itemKey: 'old', rootItemKey: 'old', options })]);
    const [old] = await store.claim(queue, workerA);
    await store.enqueue([
      intent({ runId: latestRun, itemKey: 'latest', rootItemKey: 'latest', options }),
      intent({ runId, itemKey: 'independent', rootItemKey: 'independent' }),
    ]);
    await store.finishEnumeration(runId);
    await store.finishEnumeration(latestRun);
    // An unrelated worker/attempt proof must not authorize this attempt's replay.
    await recordStoppedAttempt(db, old.id, randomUUID());
    await sql`insert into system_metadata(key,value) values (${'frameleaf-worker-stopped:' + workerB},
      ${JSON.stringify({ workerId: workerB, stoppedAt: Date.now() })}::text::jsonb)`.execute(db);
    await sql`update job set "cancelRequestedAt" = now(), "cancelReason" = 'request'
      where id = ${old.id}::uuid`.execute(db);
    await sql`update job set "leaseExpiresAt"=clock_timestamp()-interval '1 second' where id=${old.id}::uuid`.execute(
      db,
    );
    await store.recoverExpired();
    expect(await store.claim(queue, workerB)).toEqual([]);
    expect(
      (await sql`select state, "cancelRequestedAt" is not null cancelled from job where id=${old.id}::uuid`.execute(db))
        .rows,
    ).toEqual([{ state: 'active', cancelled: true }]);
    await sql`update job set "leaseExpiresAt"=clock_timestamp()-interval '31 seconds' where id=${old.id}::uuid`.execute(
      db,
    );
    await store.recoverExpired();
    expect(
      (await sql`select state, token, "latestPending" from job where id=${old.id}::uuid`.execute(db)).rows,
    ).toEqual([{ state: 'needs_attention', token: null, latestPending: null }]);
    expect(await store.retryFailed(queue)).toBe(0);
    const [independent] = await store.claim(queue, workerB);
    expect(independent.itemKey).toBe('independent');
    await store.complete(independent, []);
    expect(await store.claim(queue, workerB)).toEqual([]);
    const { rows: items } = await sql`select "rootItemKey", state from job_run_item
      where "runId" in (${runId}::uuid, ${latestRun}::uuid) order by "rootItemKey"`.execute(db);
    expect(items).toEqual([
      { rootItemKey: 'independent', state: 'completed' },
      { rootItemKey: 'latest', state: 'needs_attention' },
      { rootItemKey: 'old', state: 'needs_attention' },
    ]);
    expect(
      (
        await sql`select id from job_run where id in (${runId}::uuid, ${latestRun}::uuid)
      and "finishedAt" is not null`.execute(db)
      ).rows,
    ).toHaveLength(2);
  });

  it('fences the linked operation without giving its dispatcher an independent retry after an unconfirmed stop', async () => {
    const { ctx } = newMediumService(BaseService, { database: db, mock: [LoggingRepository], real: [] });
    const operations = ctx.get(MediaOperationRepository);
    const { user } = await ctx.newUser();
    const operation = await operations.create({
      ownerId: user.id,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      label: 'Unconfirmed executor',
      snapshot: {},
      settings: {},
    });
    const operationToken = randomUUID();
    await sql`update media_operation set status='rendering', "claimToken"=${operationToken}::uuid,
      "claimedBy"='job-queue', "claimExpiresAt"=clock_timestamp()-interval '1 second',
      result='{"retainedCheckpoint":7}'::jsonb where id=${operation.id}::uuid`.execute(db);
    await store.enqueue([intent({ safeToRetry: false, data: { operationId: operation.id } })]);
    const [claim] = await store.claim(queue, workerA);
    await sql`update job set "leaseExpiresAt"=clock_timestamp()-interval '31 seconds' where id=${claim.id}::uuid`.execute(
      db,
    );
    await store.recoverExpired();
    await operations.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'expired' });
    expect(
      await db
        .selectFrom('media_operation')
        .select(['status', 'claimToken', 'autoRetries', 'errorCode', 'result'])
        .where('id', '=', operation.id)
        .executeTakeFirst(),
    ).toEqual({
      status: MediaOperationStatus.Failed,
      claimToken: null,
      autoRetries: 0,
      errorCode: 'executor_stop_unconfirmed',
      result: { retainedCheckpoint: 7, status: 'needs_attention' },
    });
    expect(await store.retryFailed(queue)).toBe(0);
    expect(await store.claim(queue, workerB)).toEqual([]);
  });

  it('rolls back output adoption, terminal state, and follow-ups together after a crash inside the transaction', async () => {
    await store.enqueue([intent()]);
    const [claim] = await store.claim(queue, workerA);
    await expect(
      store.complete(claim, [intent()], async (tx) => {
        await sql`update job set error = 'must roll back' where id = ${claim.id}::uuid`.execute(tx);
        throw new Error('crash');
      }),
    ).rejects.toThrow('crash');
    const { rows } = await sql<{
      state: string;
      error: string | null;
    }>`select state, error from job where queue = ${queue}`.execute(db);
    expect(rows).toEqual([{ state: 'active', error: null }]);
    expect(await store.complete(claim, [intent()])).toBe(true);
    expect((await store.counts(queue)).waiting).toBe(1);
  });

  it('claims and recovers through an independent coordinator pool while every execution connection is reserved', async () => {
    const {
      rows: [database],
    } = await sql<{ name: string }>`select current_database() name`.execute(db);
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = `/${database.name}`;
    const executionClient = postgres(url.href, {
      max: 2,
      connect_timeout: 3,
      connection: { statement_timeout: 2000 },
    });
    const coordinatorClient = postgres(url.href, {
      max: 1,
      connect_timeout: 3,
      connection: { statement_timeout: 2000, lock_timeout: 1000 },
    });
    const executionDb = new Kysely<any>({ dialect: new PostgresJSDialect({ postgres: executionClient }) });
    const coordinatorDb = new Kysely<any>({ dialect: new PostgresJSDialect({ postgres: coordinatorClient }) });
    const coordinator = new SqlQueueStore(coordinatorDb);
    const reservations: Array<Awaited<ReturnType<typeof executionClient.reserve>>> = [];
    let queuedQuery: Promise<unknown> | undefined;
    let queryFinished = false;
    try {
      for (let count = 0; count < 2; count++) reservations.push(await executionClient.reserve());
      const executorPids = await Promise.all(
        reservations.map(
          async (connection) => (await connection<{ pid: number }[]>`select pg_backend_pid() pid`)[0].pid,
        ),
      );
      const {
        rows: [dispatchPid],
      } = await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(coordinatorDb);
      expect(new Set([...executorPids, dispatchPid.pid]).size).toBe(3);
      // All executor slots are held; this Kysely query cannot acquire any connection yet.
      queuedQuery = sql`select 1`.execute(executionDb).finally(() => {
        queryFinished = true;
      });
      await coordinator.enqueue([intent({ data: { id: 'lost' } }), intent({ data: { id: 'healthy' } })]);
      const started = performance.now();
      const [lost] = await coordinator.claim(queue, workerA);
      expect(lost).toBeDefined();
      await recordStoppedAttempt(coordinatorDb, lost.id, lost.token);
      // Inject an expired clock, not a terminal outcome. The production recovery path revokes the token.
      await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${lost.id}::uuid`.execute(
        coordinatorDb,
      );
      await coordinator.recoverExpired();
      await coordinator.heartbeat(workerB, []);
      const [healthy] = await coordinator.claim(queue, workerB);
      expect(healthy.id).not.toBe(lost.id);
      expect(await coordinator.complete(healthy, [])).toBe(true);
      const latePublication = vi.fn();
      expect(await coordinator.complete(lost, [], latePublication)).toBe(false);
      expect(latePublication).not.toHaveBeenCalled();
      expect(performance.now() - started).toBeLessThan(5000);
      expect(queryFinished).toBe(false);
      expect(await coordinator.counts(queue)).toMatchObject({ active: 0, completed: 1, delayed: 1 });
      reservations.pop()!.release();
      await queuedQuery;
      expect(queryFinished).toBe(true);
      await sql`update job set "availableAt" = now() where id = ${lost.id}::uuid`.execute(coordinatorDb);
      const [retry] = await coordinator.claim(queue, workerB);
      expect(retry).toMatchObject({ id: lost.id, attempt: 2 });
      expect(await coordinator.complete(retry, [])).toBe(true);
      expect(await coordinator.counts(queue)).toMatchObject({ active: 0, completed: 2, delayed: 0 });
    } finally {
      for (const connection of reservations) connection.release();
      await queuedQuery?.catch(() => {});
      await executionDb.destroy();
      await coordinatorDb.destroy();
    }
  }, 15_000);

  it('executes the selected media through synthetic metadata, thumbnail, video and ML stages via the production facade', async ({
    signal,
    onTestFinished,
  }) => {
    // Every item is four real facade executions, about 20 ms each on a hosted runner, so the size is
    // what the behaviour needs and no more: three times the 1,000-job high-water mark (the manifest
    // must hold a backlog through several refills), well past the twentieth batch where the facade
    // is replaced a second time, and enough for three poisoned and six transient items.
    const media = PIPELINE_MEDIA;
    const poisoned = Math.floor(media / 1000);
    const transient = Math.floor(media / 499);
    const caseQueue = queue;
    const caseWorkerA = workerA;
    const caseWorkerB = workerB;
    // These handlers model scheduling/publication only: they do not decode media, run FFmpeg or call ML.
    // The separate child-process/ML-body fault cases below exercise those cancellation boundaries.
    const table = `queue_fixture_${randomUUID().replaceAll('-', '')}`;
    const checkpoints = `${table}_checkpoint`;
    await sql`create table ${sql.id(table)} (id text not null, stage text not null, attempt integer not null,
      output text not null, primary key(id, stage))`.execute(db);
    await sql`create table ${sql.id(checkpoints)} (name text primary key, requested integer not null)`.execute(db);
    const stages = [
      JobName.AssetExtractMetadata,
      JobName.AssetGenerateThumbnails,
      JobName.AssetEncodeVideo,
      JobName.SmartSearch,
    ];
    const concurrency = 128;
    let activeClaims: QueueClaim[] = [];
    let heartbeatBusy: Promise<void> | undefined;
    let heartbeatError: unknown;
    const heartbeat = setInterval(() => {
      if (!heartbeatBusy) {
        heartbeatBusy = Promise.all([
          store.heartbeat(
            caseWorkerA,
            activeClaims.filter((claim) => claim.workerId === caseWorkerA),
          ),
          store.heartbeat(
            caseWorkerB,
            activeClaims.filter((claim) => claim.workerId === caseWorkerB),
          ),
        ])
          .then(() => {})
          .catch((error) => {
            heartbeatError = error;
          })
          .finally(() => {
            heartbeatBusy = undefined;
          });
      }
    }, 10_000);
    const controllers = new Set<AbortController>();
    const abort = () => {
      for (const controller of controllers) controller.abort(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    const settled = Promise.withResolvers<void>();
    // Timeout fails the case, but must not leave its facade consuming later cases' claims.
    onTestFinished(() => settled.promise, 15_000);
    try {
      signal.throwIfAborted();
      const artifacts = publicationDatabase(db);
      const makeExecutor = () => {
        const next: JobRepository = new JobRepository(
          {} as never,
          {} as never,
          { emit: async (_event: string, _queue: string, item: JobItem) => next.run(item) } as never,
          { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
          db,
        );
        next['handlers'][JobName.AssetExtractMetadataQueueAll] = {
          jobName: JobName.AssetExtractMetadataQueueAll,
          queueName: caseQueue as QueueName,
          label: 'synthetic-metadata-selection',
          handler: async () => {
            const checkpoint = await next.prepareCheckpoint('selection', async () => {
              await artifacts.insertInto(checkpoints).values({ name: 'selection', requested: media }).execute();
              return { requested: media };
            });
            // A new facade must recover this committed setup, not insert it twice.
            if (queueExecution.getStore()!.claim.attempt === 1) throw new Error('interrupted producer fixture');
            await next.queueSelection(
              JobName.AssetExtractMetadata,
              db
                .selectFrom(
                  sql<{ id: string }>`(select generate_series(1, ${checkpoint.requested})::text id)`.as('selected'),
                )
                .select('id'),
            );
            return JobStatus.Success;
          },
        };
        for (const [position, name] of stages.entries()) {
          next['handlers'][name] = {
            jobName: name,
            queueName: caseQueue as QueueName,
            label: `synthetic-${name}`,
            handler: async (data) => {
              const { id } = data as { id: string };
              const execution = queueExecution.getStore()!;
              const index = Number(id);
              if (name === JobName.AssetGenerateThumbnails && index % 1000 === 0) throw new Error('poison fixture');
              if (name === JobName.SmartSearch && index % 499 === 0 && execution.claim.attempt === 1)
                throw new Error('transient fixture');
              await publishJobResult(async () => {
                // A duplicate acceptance fails the PK instead of silently hiding repeated publication.
                await artifacts
                  .insertInto(table)
                  .values({
                    id,
                    stage: name,
                    attempt: execution.claim.attempt,
                    output: `synthetic/${execution.claim.id}/${execution.claim.token}`,
                  })
                  .execute();
                const following = stages[position + 1];
                if (following) await next.queue({ name: following, data: { id } } as JobItem);
              });
              return JobStatus.Success;
            },
          };
        }
        return next;
      };
      let executor = makeExecutor();
      const runId = await executor.createRun('synthetic-four-stage-pipeline', { requested: media }, () =>
        executor.queue({ name: JobName.AssetExtractMetadataQueueAll, data: {} }),
      );
      await store.setConcurrency(caseQueue, concurrency);
      const readRun = async () => (await store.listRuns(100, 0)).find((run) => run.id === runId)!;
      expect(await readRun()).toMatchObject({ total: 0, enumerationDone: false, stageTotals: { total: 1 } });
      const scheduled = async () =>
        (
          await sql<{ count: number }>`select count(*)::int count from job
        where queue = ${caseQueue} and state in ('pending','waiting','active')`.execute(db)
        ).rows[0].count;
      let batches = 0;
      let replacements = 0;
      let maximumScheduled = 0;
      for (;;) {
        signal.throwIfAborted();
        if (heartbeatError) throw heartbeatError;
        expect(await store.feedManifest(caseQueue)).toBeLessThanOrEqual(250);
        activeClaims = await store.claim(caseQueue, batches % 2 ? caseWorkerA : caseWorkerB);
        maximumScheduled = Math.max(maximumScheduled, await scheduled());
        expect(maximumScheduled).toBeLessThanOrEqual(QUEUE_HIGH_WATER);
        expect(activeClaims.length).toBeLessThanOrEqual(concurrency);
        // The facade and store remain production code; only the four handlers are synthetic.
        await Promise.all(
          activeClaims.map(async (claim) => {
            const controller = new AbortController();
            controllers.add(controller);
            if (signal.aborted) controller.abort(signal.reason);
            try {
              await executor['execute'](claim, controller);
            } finally {
              controllers.delete(controller);
            }
          }),
        );
        signal.throwIfAborted();
        const completedProducer = activeClaims.some(
          (claim) => claim.name === JobName.AssetExtractMetadataQueueAll && claim.attempt === 2,
        );
        activeClaims = [];
        if (completedProducer) {
          expect(await readRun()).toMatchObject({
            total: media,
            enumerationDone: true,
            completed: 0,
            waiting: media,
            stageTotals: { total: media + 1, completed: 1 },
          });
          expect(await scheduled()).toBe(0); // the entire selection is still manifest-only
        }
        maximumScheduled = Math.max(maximumScheduled, await scheduled());
        expect(maximumScheduled).toBeLessThanOrEqual(QUEUE_HIGH_WATER);
        // Accelerate the retry clock only. No terminal states or item outcomes are fabricated.
        await sql`update job set "availableAt" = now() where queue = ${caseQueue} and state = 'pending' and attempt > 0`.execute(
          db,
        );
        const counts = await store.counts(caseQueue);
        const {
          rows: [backlog],
        } = await sql<{ count: number }>`select count(*)::int count from job_run_item
          where "runId" = ${runId}::uuid and "jobId" is null and state = 'pending'`.execute(db);
        if (counts.waiting + counts.active + counts.delayed + backlog.count === 0) break;
        batches++;
        if (batches === 1 || batches === 20) {
          executor = makeExecutor();
          replacements++;
        }
        if (batches > 1500) throw new Error('Pipeline stopped making bounded progress');
      }
      expect(replacements).toBe(2);
      const final = await readRun();
      expect(final).toMatchObject({
        state: 'completed_with_errors',
        enumerationDone: true,
        total: media,
        completed: media - poisoned,
        failed: poisoned,
        active: 0,
        waiting: 0,
        delayed: 0,
        retrying: 0,
        // every item's first two stages, the last two of those not poisoned, and the producer
        stageTotals: {
          total: 4 * media - 2 * poisoned + 1,
          completed: 4 * media - 3 * poisoned + 1,
          failed: poisoned,
        },
      });
      expect(final.finishedAt).not.toBeNull();
      const { rows: outputs } = await sql<{ stage: string; count: number }>`select stage, count(*)::int count
        from ${sql.id(table)} group by stage`.execute(db);
      expect(outputs).toEqual(
        expect.arrayContaining(
          stages.map((stage, index) => ({ stage, count: index === 0 ? media : media - poisoned })),
        ),
      );
      expect(outputs).toHaveLength(4);
      const { rows: edges } = await sql<{ stage: string; predecessor: string; count: number; invalid: number }>`
        select c.name stage, p.name predecessor, count(*)::int count,
          count(*) filter(where p.state != 'completed' or c."startedAt" < p."finishedAt"
            or c."rootItemKey" is distinct from p."rootItemKey")::int invalid
        from job c join job p on p.id = c."parentId" where c."runId" = ${runId}::uuid
        group by c.name, p.name`.execute(db);
      expect(edges).toEqual(
        expect.arrayContaining([
          { stage: stages[1], predecessor: stages[0], count: media, invalid: 0 },
          { stage: stages[2], predecessor: stages[1], count: media - poisoned, invalid: 0 },
          { stage: stages[3], predecessor: stages[2], count: media - poisoned, invalid: 0 },
        ]),
      );
      expect(edges).toHaveLength(3);
      expect(await artifacts.selectFrom(checkpoints).selectAll().execute()).toEqual([
        { name: 'selection', requested: media },
      ]);
      const {
        rows: [publications],
      } = await sql<{ total: number; outputs: number; retries: number }>`
        select count(*)::int total, count(distinct output)::int outputs,
          count(*) filter(where attempt = 2)::int retries from ${sql.id(table)}`.execute(db);
      expect(publications).toEqual({
        total: 4 * media - 3 * poisoned,
        outputs: 4 * media - 3 * poisoned,
        retries: transient,
      });
      const {
        rows: [attempts],
      } = await sql<{ maximum: number; retried: number }>`select max(attempt)::int maximum,
        count(*) filter (where attempt = 2)::int retried from job where "runId" = ${runId}::uuid`.execute(db);
      expect(attempts).toEqual({ maximum: 2, retried: 1 + poisoned + transient }); // producer + poison + transient ML
      const {
        rows: [poison],
      } = await sql<{ count: number }>`select count(*)::int count from ${sql.id(table)}
        where id::integer % 1000 = 0 and stage != ${JobName.AssetExtractMetadata}`.execute(db);
      expect(poison.count).toBe(0);
    } finally {
      clearInterval(heartbeat);
      try {
        await heartbeatBusy;
        await sql`drop table ${sql.id(checkpoints)}, ${sql.id(table)}`.execute(db);
      } finally {
        signal.removeEventListener('abort', abort);
        settled.resolve();
      }
    }
    // Whole-batch validation budget, not an application deadline. Stall/recovery deadlines
    // are asserted separately; a progressing 60,000-stage run can exceed 15 minutes locally.
  }, 900_000);

  it('fences a partitioned executor and defers retry until its actual stop is confirmed', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'queue-partition-'));
    const oldPath = join(folder, 'old-attempt');
    const worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');
      const fs=require('node:fs'); parentPort.postMessage('ready');
      parentPort.once('message',()=>{fs.writeFileSync(workerData,'late private output');parentPort.postMessage('prepared');});
      setInterval(()=>{},1000);`,
      { eval: true, workerData: oldPath },
    );
    try {
      await once(worker, 'message');
      await store.enqueue([intent()]);
      const [old] = await store.claim(queue, workerA);
      await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${old.id}::uuid`.execute(db);
      await store.recoverExpired();
      await sql`update job set "availableAt" = now() where id = ${old.id}::uuid`.execute(db);
      expect(await store.claim(queue, workerB)).toEqual([]);
      const prepared = once(worker, 'message');
      worker.postMessage('resume');
      await prepared;
      expect(await readFile(oldPath, 'utf8')).toBe('late private output');
      const adopt = vi.fn();
      expect(await store.complete(old, [intent()], adopt)).toBe(false);
      expect(adopt).not.toHaveBeenCalled();
      expect((await store.counts(queue)).waiting).toBe(0);
      expect(worker.threadId).not.toBe(-1);
      await worker.terminate();
      await recordStoppedAttempt(db, old.id, old.token);
      await store.recoverExpired();
      expect((await store.counts(queue)).delayed).toBe(1);
      await sql`update job set "availableAt" = now() where id = ${old.id}::uuid`.execute(db);
      const [replacement] = await store.claim(queue, workerB);
      expect(replacement).toMatchObject({ id: old.id, attempt: 2 });
      expect(await store.complete(replacement, [])).toBe(true);
    } finally {
      await worker.terminate();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('rolls back nested repository writes when the lease expires during publication', async () => {
    await store.enqueue([intent()]);
    const [claim] = await store.claim(queue, workerA);
    const adapted = publicationDatabase(db);
    await expect(
      store.complete(claim, [intent()], (tx) =>
        publicationTransaction.run(tx, async () => {
          await adapted.transaction().execute(async (nested) => {
            await sql`update job set error = 'must roll back', "leaseExpiresAt" = clock_timestamp() + interval '30 milliseconds'
          where id = ${claim.id}::uuid`.execute(nested);
            await sql`select pg_sleep(0.06)`.execute(nested);
          });
        }),
      ),
    ).rejects.toThrow('Publication lease expired');
    const {
      rows: [row],
    } = await sql<{
      state: string;
      error: string | null;
    }>`select state, error from job where id = ${claim.id}::uuid`.execute(db);
    expect(row).toEqual({ state: 'active', error: null });
    expect((await store.counts(queue)).waiting).toBe(0);
  });

  it('keeps the admitted destination on retry and fences admission from a lost claim', async () => {
    await store.enqueue([intent()]);
    const [claim] = await store.claim(queue, workerA);
    const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    const execution = {
      claim,
      signal: new AbortController().signal,
      progress: vi.fn(),
      progressUnits: 0,
      adoptions: [],
      followups: [],
      buffering: false,
    };
    await queueExecution.run(execution, async () => {
      expect(await repository.pinDestination('search', 'explicit-a')).toBe('explicit-a');
      expect(await repository.pinDestination('search', 'new-route-b')).toBe('explicit-a');
      await store.fail(claim, 'retry');
      await expect(repository.pinDestination('search', 'new-route-b')).rejects.toThrow('lost its claim');
    });
    await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
    const [retry] = await store.claim(queue, workerB);
    await queueExecution.run({ ...execution, claim: retry }, async () => {
      expect(await repository.pinDestination('search', 'new-route-b')).toBe('explicit-a');
    });
  });

  it('a poison parent settles unstarted descendants while other selected items continue', async () => {
    const runId = await store.createRun('dependency', {});
    await store.enqueue([intent({ runId, itemKey: 'poison', safeToRetry: false })]);
    const [parent] = await store.claim(queue, workerA);
    await store.enqueue([
      intent({ runId, itemKey: parent.itemKey!, name: 'child', parentId: parent.id }),
      intent({ runId, itemKey: 'healthy' }),
    ]);
    await store.finishEnumeration(runId);
    await store.fail(parent, 'poison');
    const {
      rows: [child],
    } = await sql<{ state: string }>`select state from job where "parentId" = ${parent.id}::uuid`.execute(db);
    expect(child.state).toBe('blocked');
    expect(await store.claim(queue, workerB)).toHaveLength(1);
  });
  it('settles superseded runs separately and dispatches the newest request after a terminal predecessor failure', async () => {
    const runs = await Promise.all([1, 2, 3].map(() => store.createRun('overlap', {})));
    const options = { deduplication: { id: 'overlap', keepLastIfActive: true } };
    await store.enqueue([intent({ options, safeToRetry: false, runId: runs[0], itemKey: 'asset' })]);
    const [first] = await store.claim(queue, workerA);
    await store.enqueue([intent({ options, runId: runs[1], itemKey: 'asset', data: { revision: 2 } })]);
    await store.enqueue([intent({ options, runId: runs[2], itemKey: 'asset', data: { revision: 3 } })]);
    for (const run of runs) {
      await store.finishEnumeration(run);
    }
    await store.fail(first, 'ambiguous predecessor');
    const states = async () =>
      (
        await sql<{ runId: string; state: string }>`select "runId", state from job_run_item
      where "runId" = any(${runs}::uuid[])`.execute(db)
      ).rows;
    expect(await states()).toEqual(
      expect.arrayContaining([
        { runId: runs[0], state: 'needs_attention' },
        { runId: runs[1], state: 'cancelled' },
        { runId: runs[2], state: 'pending' },
      ]),
    );
    const [latest] = await store.claim(queue, workerB);
    expect(latest.data).toEqual({ revision: 3 });
    await store.complete(latest, []);
    expect(await states()).toContainEqual({ runId: runs[2], state: 'completed' });
    expect(await store.claim(queue, workerA)).toEqual([]);
  });

  it('keeps a repeated stage in one run pending until its newest revision commits', async () => {
    const runId = await store.createRun('same-run', {});
    const options = { deduplication: { id: 'same-run', keepLastIfActive: true } };
    await store.enqueue([intent({ options, runId, itemKey: 'asset' })]);
    const [first] = await store.claim(queue, workerA);
    await store.enqueue([intent({ options, runId, itemKey: 'asset', data: { revision: 2 } })]);
    await store.finishEnumeration(runId);
    await store.complete(first, []);
    const [next] = await store.claim(queue, workerB);
    expect(next.id).toBe(first.id);
    expect(next.attempt).toBe(first.attempt + 1);
    expect(next.data).toEqual({ revision: 2 });
    expect(await store.complete(first, [])).toBe(false);
    await store.complete(next, []);
    const {
      rows: [run],
    } = await sql<{ finishedAt: Date }>`select "finishedAt" from job_run where id = ${runId}::uuid`.execute(db);
    expect(run.finishedAt).not.toBeNull();
  });
  it('reuses an immutable producer selection after restart while the source library changes', async () => {
    const runId = await store.createRun('selection-restart', {});
    await store.enqueue([intent({ runId, itemKey: 'producer' })]);
    const [claim] = await store.claim(queue, workerA);
    const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    repository['handlers'][JobName.AssetGenerateThumbnails] = {
      queueName: queue as QueueName,
      jobName: JobName.AssetGenerateThumbnails,
      label: 'fixture',
      handler: vi.fn(),
    };
    const later = randomUUID();
    const selection = db.selectFrom('job_worker').select('id').where('id', 'in', [workerA, workerB, later]);
    await queueExecution.run(
      {
        claim,
        signal: new AbortController().signal,
        progress: vi.fn(),
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      },
      async () => {
        await repository.queueSelection(JobName.AssetGenerateThumbnails, selection);
        await store.initialize([], later);
        await repository.queueSelection(JobName.AssetGenerateThumbnails, selection);
      },
    );
    const { rows } = await sql<{ itemKey: string }>`select "itemKey" from job_run_item
      where "runId" = ${runId}::uuid and stage = ${JobName.AssetGenerateThumbnails}`.execute(db);
    expect(rows.map((row) => row.itemKey).sort()).toEqual([workerA, workerB].sort());
  });
  it('carries required child stages into every run sharing a deduplicated parent', async () => {
    const firstRun = await store.createRun('shared-parent', {});
    const otherRun = await store.createRun('shared-parent', {});
    const options = { deduplication: { id: 'shared-parent' } };
    await store.enqueue([intent({ runId: firstRun, itemKey: 'asset', options })]);
    const [parent] = await store.claim(queue, workerA);
    await store.enqueue([intent({ runId: otherRun, itemKey: 'asset', options })]);
    await store.finishEnumeration(firstRun);
    await store.finishEnumeration(otherRun);
    await store.complete(parent, [
      intent({ name: 'required-ml', runId: firstRun, itemKey: 'asset', parentId: parent.id }),
    ]);
    const { rows: runs } = await sql<{
      id: string;
      stages: number;
      completed: number;
      pending: number;
      finishedAt: Date | null;
    }>`
      select r.id, r."finishedAt", count(*)::int stages,
        count(*) filter(where i.state = 'completed')::int completed,
        count(*) filter(where i.state in ('pending','waiting'))::int pending
      from job_run r join job_run_item i on i."runId" = r.id
      where r.id in (${firstRun}::uuid, ${otherRun}::uuid) group by r.id`.execute(db);
    for (const id of [firstRun, otherRun]) {
      expect(runs.find((run) => run.id === id)).toMatchObject({
        stages: 2,
        completed: 1,
        pending: 1,
        finishedAt: null,
      });
    }
  });

  it('does not replay unsafe side effects through a newer pending request after an ambiguous stop', async () => {
    const options = { deduplication: { id: 'unsafe-latest', keepLastIfActive: true } };
    await store.enqueue([intent({ options, safeToRetry: false })]);
    const [first] = await store.claim(queue, workerA);
    await store.enqueue([intent({ options, safeToRetry: false, data: { revision: 2 } })]);
    await store.fail(first, 'worker lost');
    expect(await store.claim(queue, workerB)).toEqual([]);
    const { rows } = await sql<{ state: string }>`select state from job where queue = ${queue}`.execute(db);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === 'needs_attention')).toBe(true);
  });
});
