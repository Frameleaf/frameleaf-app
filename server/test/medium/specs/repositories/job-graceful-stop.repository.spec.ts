import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { JobName } from 'src/enum.js';
import { publishJobResult, queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueClaim } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { getKyselyDB } from 'test/utils.js';

/** Real PostgreSQL claims; supervisor process termination is covered separately in sql-queue.spec. */
describe('JobRepository graceful stop', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });
  beforeEach(async () => {
    queue = `shutdown-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });
  afterAll(async () => db?.destroy());

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };
  const start = async (handler: () => Promise<void>, safeToRetry = true) => {
    await store.enqueue([
      {
        queue,
        name: JobName.AssetGenerateThumbnails,
        data: {},
        safeToRetry,
        sensitive: false,
        deadlineMs: QUEUE_TIMING.opaqueDeadline,
      },
    ]);
    const [claim] = await store.claim(queue, worker);
    expect(claim).toBeDefined();
    const started = deferred();
    const repository = new JobRepository(
      {} as never,
      {} as never,
      {
        emit: async () => {
          started.resolve();
          await handler();
        },
      } as never,
      { setContext: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      db,
    );
    const abort = new AbortController();
    const finished = repository['execute'](claim, abort).finally(() => repository['active'].delete(claim.id));
    repository['active'].set(claim.id, { abort, finished });
    await started.promise;
    return { repository, claim, finished, abort };
  };
  const state = async (claim: QueueClaim) => {
    const { rows } = await sql<{ state: string; token: string | null; attempt: number; delayed: boolean }>`
      SELECT state, token, attempt, "availableAt" > now() AS delayed FROM job WHERE id = ${claim.id}::uuid`.execute(db);
    return rows[0];
  };

  it('lets a short job commit before closing its workers', async () => {
    const adopted = vi.fn();
    const job = await start(async () => {
      await sleep(30);
      await publishJobResult(() => {
        adopted();
        return Promise.resolve();
      });
    });
    await job.repository.stopWorkers(1000);
    await job.finished;
    expect(await state(job.claim)).toMatchObject({ state: 'completed' });
    expect(adopted).toHaveBeenCalledOnce();
  });

  it('cancels cooperative work and schedules exactly one safe delayed retry', async () => {
    const job = await start(async () => {
      await sleep(60_000, undefined, { signal: queueExecution.getStore()!.signal });
    });
    await job.repository.stopWorkers(0);
    await job.finished;
    expect(await state(job.claim)).toMatchObject({ state: 'pending', token: null, attempt: 1, delayed: true });
    expect(await store.claim(queue, worker)).toEqual([]);
    // Advance only the retry availability to avoid a thirty-second test sleep.
    await sql`UPDATE job SET "availableAt" = now() WHERE id = ${job.claim.id}::uuid`.execute(db);
    const [retry] = await store.claim(queue, worker);
    expect(retry.attempt).toBe(2);
    await store.fail(retry, 'second cancellation');
    expect(await state(retry)).toMatchObject({ state: 'failed', attempt: 2 });
    expect(await store.claim(queue, worker)).toEqual([]);
  });

  it('retains a live uncooperative claim and rejects its late publication after cancellation', async () => {
    const release = deferred();
    const adopted = vi.fn();
    const job = await start(async () => {
      await release.promise;
      await publishJobResult(() => {
        adopted();
        return Promise.resolve();
      });
    });
    try {
      await job.repository.stopWorkers(0);
      expect(job.abort.signal.aborted).toBe(true);
      expect(await state(job.claim)).toMatchObject({ state: 'active', token: job.claim.token });
      expect(await store.claim(queue, worker)).toEqual([]);
    } finally {
      release.resolve();
      await job.finished;
    }
    expect(adopted).not.toHaveBeenCalled();
    expect(await state(job.claim)).toMatchObject({ state: 'pending', attempt: 1 });
  });

  it('does not replay an unsafe effect after cancellation', async () => {
    const job = await start(async () => {
      await sleep(60_000, undefined, { signal: queueExecution.getStore()!.signal });
    }, false);
    await job.repository.stopWorkers(0);
    await job.finished;
    expect(await state(job.claim)).toMatchObject({ state: 'needs_attention', token: null });
    expect(await store.claim(queue, worker)).toEqual([]);
  });
});
