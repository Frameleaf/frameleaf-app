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
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** Real PostgreSQL races and rollback tests. Runs in the hosted medium suite, never on the operator Mac. */
describe('PostgreSQL queue', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let workerA: string;
  let workerB: string;
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
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });
  beforeEach(async () => {
    queue = `test-${randomUUID()}`;
    workerA = randomUUID();
    workerB = randomUUID();
    await store.initialize([queue], workerA);
    await store.initialize([], workerB);
  });

  it('restores safe work within its existing retry budget and never independently resumes operation jobs', async () => {
    await store.setConcurrency(queue, 3);
    await store.enqueue([
      intent({ data: { kind: 'safe' } }),
      intent({ safeToRetry: false, data: { kind: 'unsafe' } }),
      intent({ data: { kind: 'operation', operationId: randomUUID() } }),
    ]);
    const claims = await store.claim(queue, workerA);
    expect(claims).toHaveLength(3);
    await resetQueueAfterRestore(db);
    await resetQueueAfterRestore(db); // resumed recovery must be idempotent
    const { rows } = await sql<{ kind: string; state: string; token: string | null; attempt: number }>`select
      data->>'kind' kind, state, token, attempt from job where queue = ${queue}`.execute(db);
    expect(rows).toEqual(
      expect.arrayContaining([
        { kind: 'safe', state: 'pending', token: null, attempt: 1 },
        { kind: 'unsafe', state: 'needs_attention', token: null, attempt: 1 },
        { kind: 'operation', state: 'needs_attention', token: null, attempt: 1 },
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

  it('executes 15,000 selected media through synthetic metadata, thumbnail, video and ML stages via the production facade', async () => {
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
            workerA,
            activeClaims.filter((claim) => claim.workerId === workerA),
          ),
          store.heartbeat(
            workerB,
            activeClaims.filter((claim) => claim.workerId === workerB),
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
    try {
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
          queueName: queue as QueueName,
          label: 'synthetic-metadata-selection',
          handler: async () => {
            const checkpoint = await next.prepareCheckpoint('selection', async () => {
              await artifacts.insertInto(checkpoints).values({ name: 'selection', requested: 15_000 }).execute();
              return { requested: 15_000 };
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
            queueName: queue as QueueName,
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
      const runId = await executor.createRun('synthetic-four-stage-pipeline', { requested: 15_000 }, () =>
        executor.queue({ name: JobName.AssetExtractMetadataQueueAll, data: {} }),
      );
      await store.setConcurrency(queue, concurrency);
      const readRun = async () => (await store.listRuns(100, 0)).find((run) => run.id === runId)!;
      expect(await readRun()).toMatchObject({ total: 0, enumerationDone: false, stageTotals: { total: 1 } });
      const scheduled = async () =>
        (
          await sql<{ count: number }>`select count(*)::int count from job
        where queue = ${queue} and state in ('pending','waiting','active')`.execute(db)
        ).rows[0].count;
      let batches = 0;
      let replacements = 0;
      let maximumScheduled = 0;
      for (;;) {
        if (heartbeatError) throw heartbeatError;
        expect(await store.feedManifest(queue)).toBeLessThanOrEqual(250);
        activeClaims = await store.claim(queue, batches % 2 ? workerA : workerB);
        maximumScheduled = Math.max(maximumScheduled, await scheduled());
        expect(maximumScheduled).toBeLessThanOrEqual(QUEUE_HIGH_WATER);
        expect(activeClaims.length).toBeLessThanOrEqual(concurrency);
        // The facade and store remain production code; only the four handlers are synthetic.
        await Promise.all(activeClaims.map((claim) => executor['execute'](claim, new AbortController())));
        const completedProducer = activeClaims.some(
          (claim) => claim.name === JobName.AssetExtractMetadataQueueAll && claim.attempt === 2,
        );
        activeClaims = [];
        if (completedProducer) {
          expect(await readRun()).toMatchObject({
            total: 15_000,
            enumerationDone: true,
            completed: 0,
            waiting: 15_000,
            stageTotals: { total: 15_001, completed: 1 },
          });
          expect(await scheduled()).toBe(0); // the entire selection is still manifest-only
        }
        maximumScheduled = Math.max(maximumScheduled, await scheduled());
        expect(maximumScheduled).toBeLessThanOrEqual(QUEUE_HIGH_WATER);
        // Accelerate the retry clock only. No terminal states or item outcomes are fabricated.
        await sql`update job set "availableAt" = now() where queue = ${queue} and state = 'pending' and attempt > 0`.execute(
          db,
        );
        const counts = await store.counts(queue);
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
        total: 15_000,
        completed: 14_985,
        failed: 15,
        active: 0,
        waiting: 0,
        delayed: 0,
        retrying: 0,
        stageTotals: { total: 59_971, completed: 59_956, failed: 15 },
      });
      expect(final.finishedAt).not.toBeNull();
      const { rows: outputs } = await sql<{ stage: string; count: number }>`select stage, count(*)::int count
        from ${sql.id(table)} group by stage`.execute(db);
      expect(outputs).toEqual(
        expect.arrayContaining(stages.map((stage, index) => ({ stage, count: index === 0 ? 15_000 : 14_985 }))),
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
          { stage: stages[1], predecessor: stages[0], count: 15_000, invalid: 0 },
          { stage: stages[2], predecessor: stages[1], count: 14_985, invalid: 0 },
          { stage: stages[3], predecessor: stages[2], count: 14_985, invalid: 0 },
        ]),
      );
      expect(edges).toHaveLength(3);
      expect(await artifacts.selectFrom(checkpoints).selectAll().execute()).toEqual([
        { name: 'selection', requested: 15_000 },
      ]);
      const {
        rows: [publications],
      } = await sql<{ total: number; outputs: number; retries: number }>`
        select count(*)::int total, count(distinct output)::int outputs,
          count(*) filter(where attempt = 2)::int retries from ${sql.id(table)}`.execute(db);
      expect(publications).toEqual({ total: 59_955, outputs: 59_955, retries: 30 });
      const {
        rows: [attempts],
      } = await sql<{ maximum: number; retried: number }>`select max(attempt)::int maximum,
        count(*) filter (where attempt = 2)::int retried from job where "runId" = ${runId}::uuid`.execute(db);
      expect(attempts).toEqual({ maximum: 2, retried: 46 }); // producer +15 poison +30 transient ML
      const {
        rows: [poison],
      } = await sql<{ count: number }>`select count(*)::int count from ${sql.id(table)}
        where id::integer % 1000 = 0 and stage != ${JobName.AssetExtractMetadata}`.execute(db);
      expect(poison.count).toBe(0);
    } finally {
      clearInterval(heartbeat);
      await heartbeatBusy;
      await sql`drop table ${sql.id(checkpoints)}, ${sql.id(table)}`.execute(db);
    }
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
