import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueIntent } from 'src/queue/types.js';
import { getKyselyDB } from 'test/utils.js';

/** Approved design (2026-11-04): Start now, Retry and Run on one item act on one job of a queue. */
describe('PostgreSQL queue: one job at a time', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  const intent = (id: string): QueueIntent => ({
    queue,
    name: 'single-stage',
    data: { id },
    safeToRetry: true,
    sensitive: false,
    deadlineMs: QUEUE_TIMING.opaqueDeadline,
  });
  const jobIds = async () => {
    const { rows } = await sql<{ id: string; item: string }>`select id, data->>'id' item from job
      where queue = ${queue} order by "createdAt", id`.execute(db);
    return Object.fromEntries(rows.map(({ id, item }) => [item, id]));
  };
  const stateOf = async (id: string) => {
    const { rows } = await sql<{ state: string }>`select state from job where id = ${id}::uuid`.execute(db);
    return rows[0]?.state;
  };

  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });
  beforeEach(async () => {
    queue = `single-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
    await store.enqueue(['a', 'b', 'c'].map((id) => intent(id)));
  });
  afterAll(async () => db?.destroy());

  it('claims a job started by hand first, even while its queue is paused', async () => {
    const ids = await jobIds();
    await store.pause(queue, true);
    expect(await store.claim(queue, worker)).toEqual([]);

    expect(await store.startNow(queue, ids.c)).toBe(true);
    const claims = await store.claim(queue, worker);
    expect(claims.map(({ id }) => id)).toEqual([ids.c]);
    // Only that one: the rest wait for Resume.
    expect(await stateOf(ids.a)).not.toBe('active');
    expect(await store.claim(queue, worker)).toEqual([]);
  });

  it('runs a job started by hand beyond the queue’s concurrency, then the rest in their order', async () => {
    await store.setConcurrency(queue, 1);
    const [first] = await store.claim(queue, worker);
    expect(await store.claim(queue, worker)).toEqual([]);
    // Jobs queued together share a timestamp, so which one ran first is not fixed: start another.
    const [waiting, other] = Object.values(await jobIds()).filter((id) => id !== first.id);

    expect(await store.startNow(queue, waiting)).toBe(true);
    expect((await store.claim(queue, worker)).map(({ id }) => id)).toEqual([waiting]);
    expect(await stateOf(other)).not.toBe('active');
  });

  it('starts only a job that is still waiting to run in that queue', async () => {
    const [claim] = await store.claim(queue, worker, 1);
    const waiting = Object.values(await jobIds()).find((id) => id !== claim.id) as string;
    expect(await store.startNow(queue, claim.id)).toBe(false);
    expect(await store.startNow(`${queue}-other`, waiting)).toBe(false);
    expect(await store.startNow(queue, randomUUID())).toBe(false);
  });

  it('retries one failed job and leaves the other failed ones as they are', async () => {
    const ids = await jobIds();
    await sql`update job set state = 'failed', "finishedAt" = now(), error = 'boom'
      where id = any(${[ids.a, ids.b]}::uuid[])`.execute(db);

    expect(await store.retryFailed(queue, ids.b)).toBe(1);
    expect(await stateOf(ids.b)).toBe('pending');
    expect(await stateOf(ids.a)).toBe('failed');
    // A job that has not failed is not put back.
    expect(await store.retryFailed(queue, ids.c)).toBe(0);
  });

  it('finds the job still waiting to run on one item', async () => {
    const ids = await jobIds();
    expect(await store.findWaitingJob(queue, 'single-stage', 'b')).toBe(ids.b);
    expect(await store.findWaitingJob(queue, 'single-stage', 'missing')).toBeUndefined();
    expect(await store.findWaitingJob(queue, 'other-stage', 'b')).toBeUndefined();
  });
});
