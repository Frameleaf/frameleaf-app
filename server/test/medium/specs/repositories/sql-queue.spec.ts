import { Kysely, sql } from 'kysely';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MessageChannel } from 'node:worker_threads';
import { Worker } from 'node:worker_threads';
import type { JobItem } from 'src/types.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { publishJobDiagnostic, publishJobResult, queueExecution } from 'src/queue/context.js';
import { SqlQueueStore, resetQueueAfterRestore } from 'src/queue/store.js';
import { superviseQueueWorker } from 'src/queue/supervisor.js';
import { publicationDatabase, publicationTransaction } from 'src/queue/transaction.js';
import { QUEUE_TIMING, QueueIntent } from 'src/queue/types.js';
import { QueueWatchdog, monitorQueueProgress } from 'src/queue/watchdog.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BaseService } from 'src/services/base.service.js';
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
      let executor: JobRepository;
      executor = new JobRepository(
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

  it.skipIf(spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0)(
    'detects a real FFmpeg progress stall, terminates its executor, then accepts exactly one replacement',
    async () => {
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
        parentPort.on('message', ({port})=>{parentPort.postMessage({type:'queue-watchdog-port',port},[port]);
        parentPort.postMessage({type:'ready'}); while(true) {} });`,
        { eval: true, workerData: ffmpeg.pid },
      );
      superviseQueueWorker(worker);
      const workerExit = once(worker, 'exit');
      const { port1, port2 } = new MessageChannel();
      const ready = new Promise<void>((resolve) =>
        worker.on('message', (m) => {
          if (m.type === 'ready') resolve();
        }),
      );
      worker.postMessage({ port: port1 }, [port1]);
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
        expect(cancelled).toBe(true);
        // Advance only database lease/retry time after real process death. No terminal states are injected.
        await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${claim.id}::uuid`.execute(
          db,
        );
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
    },
    15000,
  );

  it('rejects prepared media when its original path changes before acceptance', async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    let executor: JobRepository;
    const adopted = vi.fn();
    executor = new JobRepository(
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
          await publishJobResult(async () => {
            adopted();
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

  it('retries a killed safe worker once and fences its late output and follow-up intents', async () => {
    await store.enqueue([intent()]);
    const [first] = await store.claim(queue, workerA);
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

  it('executes 15,000 immutable selected items through bounded producers, handlers, publication and retries', async () => {
    const table = `queue_fixture_${randomUUID().replaceAll('-', '')}`;
    await sql`create table ${sql.id(table)} (id text not null, stage text not null, primary key(id, stage))`.execute(
      db,
    );
    try {
      const artifacts = publicationDatabase(db);
      let executor: JobRepository;
      const makeExecutor = () => {
        const next: JobRepository = new JobRepository(
          {} as never,
          {} as never,
          { emit: async (_event: string, _queue: string, item: JobItem) => next.run(item) } as never,
          { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
          db,
        );
        for (const name of [JobName.AssetGenerateThumbnails, JobName.SmartSearch]) {
          next['handlers'][name] = {
            jobName: name,
            queueName: queue as QueueName,
            label: 'bounded-fixture',
            handler: async (data) => {
              const { id } = data as { id: string };
              const execution = queueExecution.getStore()!;
              const index = Number(id);
              // Real executor failures exercise the one-retry budget, without setting terminal SQL state.
              if (name === JobName.AssetGenerateThumbnails && index % 1000 === 0) {
                throw new Error('poison fixture');
              }
              if (name === JobName.SmartSearch && index % 499 === 0 && execution.claim.attempt === 1) {
                throw new Error('transient fixture');
              }
              await publishJobResult(async () => {
                await artifacts.insertInto(table).values({ id, stage: name }).execute();
                if (name === JobName.AssetGenerateThumbnails) {
                  await next.queue({ name: JobName.SmartSearch, data: { id } });
                }
              });
              return JobStatus.Success;
            },
          };
        }
        return next;
      };
      executor = makeExecutor();
      const runId = await executor.createRun('pipeline-fixture', { requested: 15_000 }, async () => {
        await executor.queueSelection(
          JobName.AssetGenerateThumbnails,
          db.selectFrom(sql<{ id: string }>`(select generate_series(1, 15000)::text id)`.as('selected')).select('id'),
        );
      });
      await store.setConcurrency(queue, 64);
      let batches = 0;
      let maximumReady = 0;
      for (;;) {
        const claims = await store.claim(queue, batches % 2 ? workerA : workerB);
        const {
          rows: [ready],
        } = await sql<{ count: number }>`select count(*)::int count from job
          where queue = ${queue} and state in ('waiting','active')`.execute(db);
        maximumReady = Math.max(maximumReady, ready.count);
        expect(claims.length).toBeLessThanOrEqual(64);
        await Promise.all(claims.map((claim) => executor['execute'](claim, new AbortController())));
        // Advance only retry availability. Every outcome still goes through the production executor.
        await sql`update job set "availableAt" = now() where queue = ${queue} and state = 'pending'
          and attempt > 0`.execute(db);
        const counts = await store.counts(queue);
        if (counts.waiting + counts.active + counts.delayed === 0) {
          break;
        }
        if (++batches === 20) {
          executor = makeExecutor();
        } // replace the execution facade mid-run
        if (batches > 1000) {
          throw new Error('Pipeline stopped making bounded progress');
        }
      }
      expect(maximumReady).toBeLessThanOrEqual(1000);
      const {
        rows: [artifactsCount],
      } = await sql<{ count: number }>`select count(*)::int count from ${sql.id(table)}`.execute(db);
      expect(artifactsCount.count).toBe(29_970);
      const final = (await store.listRuns(100, 0)).find((run) => run.id === runId)!;
      expect(final.state).toBe('failed');
      const {
        rows: [roots],
      } = await sql<{
        count: number;
      }>`select count(distinct "rootItemKey")::int count from job_run_item where "runId" = ${runId}::uuid`.execute(db);
      expect(roots.count).toBe(15_000);
      expect(final.finishedAt).not.toBeNull();
      const {
        rows: [attempts],
      } = await sql<{ maximum: number; retried: number }>`select max(attempt)::int maximum,
        count(*) filter (where attempt = 2)::int retried from job where "runId" = ${runId}::uuid`.execute(db);
      expect(attempts.maximum).toBe(2);
      expect(attempts.retried).toBeGreaterThan(15);
    } finally {
      await sql`drop table ${sql.id(table)}`.execute(db);
    }
  }, 900_000);

  it('rejects a late publication from a real still-running partitioned executor', async () => {
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
      const [replacement] = await store.claim(queue, workerB);
      expect(await store.complete(replacement, [])).toBe(true);
      const prepared = once(worker, 'message');
      worker.postMessage('resume');
      await prepared;
      expect(await readFile(oldPath, 'utf8')).toBe('late private output');
      const adopt = vi.fn();
      expect(await store.complete(old, [intent()], adopt)).toBe(false);
      expect(adopt).not.toHaveBeenCalled();
      expect((await store.counts(queue)).waiting).toBe(0);
      expect(worker.threadId).not.toBe(-1); // safety does not assume the remote executor stopped
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
    const runs = await store.listRuns(100, 0);
    for (const id of [firstRun, otherRun]) {
      expect(runs.find((run) => run.id === id)).toMatchObject({ total: 2, completed: 1, waiting: 1, finishedAt: null });
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
