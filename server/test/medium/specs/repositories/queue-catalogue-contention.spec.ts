import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { queueTurnstileKey } from 'src/queue/catalogue.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueIntent } from 'src/queue/types.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { getKyselyDB } from 'test/utils.js';

// FL-1172: a library import failed ~1,400 items with "canceling statement due to lock timeout" (55P03). Every wait
// was on job_queue: completions and coordinator visits lock the whole catalogue, while enqueues and claims lock one
// queue at a time. No holder was older than 0.16 s; the waits came from the convoy. This runs that mix the way several
// worker processes do (each its own pool with the production 5 s lock_timeout, one publication at a time) and requires
// every completion to commit.
const PROCESSES = 4;
const ENQUEUERS = 6;
const COMPLETIONS = 10;
const HOLD = 0.06;

const isLockContention = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && ['55P03', '40P01'].includes(String(error.code));

describe('queue catalogue contention', () => {
  let db: Kysely<any>;
  const pools: Kysely<any>[] = [];
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.destroy()));
    await db?.destroy();
  });

  it('commits every completion while enqueues, claims and coordinator visits contend for the queues', async () => {
    const {
      rows: [{ name }],
    } = await sql<{ name: string }>`select current_database() name`.execute(db);
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = `/${name}`;
    const suffix = randomUUID().slice(0, 8);
    const queues = [0, 1, 2, 3].map((index) => `contention-${suffix}-${index}`);
    const intent = (queue: string): QueueIntent => ({
      queue,
      name: 'thumbnail',
      data: { id: randomUUID() },
      safeToRetry: true,
      sensitive: false,
      deadlineMs: QUEUE_TIMING.opaqueDeadline,
    });
    const setup = new SqlQueueStore(db);
    await setup.initialize(queues);
    for (const queue of queues) {
      await setup.setConcurrency(queue, COMPLETIONS);
      await setup.enqueue(Array.from({ length: COMPLETIONS }, () => intent(queue)));
    }

    // Claimed before the contention starts: a claim skips a locked queue row, which is not what this measures.
    const processes = [];
    for (let index = 0; index < PROCESSES; index++) {
      const pool = new Kysely<any>(getKyselyConfig({ connectionType: 'url', url: url.href }));
      pools.push(pool);
      const store = new SqlQueueStore(pool);
      const workerId = randomUUID();
      await store.initialize([], workerId);
      const claims = await store.claim(queues[index % queues.length], workerId, COMPLETIONS);
      expect(claims).toHaveLength(COMPLETIONS);
      processes.push({ index, pool, store, workerId, claims, pending: new Set(claims) });
    }

    const errors = { complete: [] as unknown[], enqueue: 0, coordinator: 0 };
    const completeMs: number[] = [];
    let running = true;
    const startedAt = Date.now();

    const background = processes.flatMap(({ index, pool, store, workerId, pending }) => [
      // Handlers enqueue outside publication: one queue row, held for an ordinary short transaction.
      ...Array.from({ length: ENQUEUERS }, async (_, offset) => {
        while (running) {
          try {
            await pool.transaction().execute(async (tx) => {
              await store.enqueue([intent(queues[(index + offset) % queues.length])], tx as Kysely<any>);
              await sql`select pg_sleep(${HOLD})`.execute(tx);
            });
          } catch (error) {
            if (!isLockContention(error)) throw error;
            errors.enqueue++;
          }
        }
      }),
      // The coordinator renews its leases and visits every queue in turn (sharing, then manifest feeding).
      (async () => {
        while (running) {
          await store.heartbeat(
            workerId,
            [...pending].map(({ id, token }) => ({ id, token })),
          );
          for (const queue of queues) {
            try {
              await store.feedManifest(queue);
            } catch (error) {
              if (!isLockContention(error)) throw error;
              errors.coordinator++;
            }
          }
        }
      })(),
    ]);

    // One publication at a time per process (QueueAdmission(1)), each a short adoption plus a follow-up.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await Promise.all(
      processes.map(async ({ index, store, claims, pending }) => {
        for (const claim of claims) {
          const begin = Date.now();
          try {
            const accepted = await store.complete(claim, [intent(queues[(index + 1) % queues.length])], async (tx) => {
              await sql`select pg_sleep(${HOLD})`.execute(tx);
            });
            expect(accepted).toBe(true);
          } catch (error) {
            // The production executor fails this claim (spending a retry); recovery is not under test here.
            errors.complete.push(error);
          } finally {
            pending.delete(claim);
            completeMs.push(Date.now() - begin);
          }
        }
      }),
    );
    const elapsed = Date.now() - startedAt;
    running = false;
    await Promise.all(background);

    const sorted = completeMs.toSorted((a, b) => a - b);
    console.info(
      `catalogue contention: ${completeMs.length} completions in ${elapsed} ms, ` +
        `p50 ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms; ` +
        `complete errors ${errors.complete.length}, enqueue lock errors ${errors.enqueue}, ` +
        `coordinator lock errors ${errors.coordinator}`,
    );
    expect(errors.complete.map((error) => (error as { code?: string }).code ?? String(error))).toEqual([]);
    const { rows } = await sql<{ count: number }>`select count(*)::int count from job
      where queue = any(${queues}::text[]) and state = 'completed'`.execute(db);
    expect(rows[0].count).toBe(PROCESSES * COMPLETIONS);
  }, 180_000);

  it('waits out a catalogue held past the lock timeout without failing the job or spending its retry', async () => {
    const store = new SqlQueueStore(db);
    const queue = `held-${randomUUID()}`;
    const workerId = randomUUID();
    await store.initialize([queue], workerId);
    await store.enqueue([
      {
        queue,
        name: 'thumbnail',
        data: {},
        safeToRetry: true,
        sensitive: false,
        deadlineMs: QUEUE_TIMING.opaqueDeadline,
      },
    ]);
    const [claim] = await store.claim(queue, workerId);

    // Another publication keeps the catalogue for longer than the pool's 5 s lock_timeout.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const holding = new Promise<void>((resolve) => (taken = resolve));
    const holder = db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(${queueTurnstileKey})`.execute(tx);
      taken();
      await held;
    });
    await holding;
    const releaseAt = setTimeout(release, 6500);
    const begin = Date.now();
    try {
      await expect(store.complete(claim, [])).resolves.toBe(true);
    } finally {
      clearTimeout(releaseAt);
      release();
      await holder;
    }
    expect(Date.now() - begin).toBeGreaterThanOrEqual(6000);
    const {
      rows: [job],
    } = await sql<{ state: string; attempt: number; base: number }>`select state, attempt, "retryBaseAttempt" base
      from job where id = ${claim.id}::uuid`.execute(db);
    expect(job).toEqual({ state: 'completed', attempt: 1, base: 0 });
    const { rows: attempts } = await sql<{ outcome: string }>`select outcome from job_attempt
      where "jobId" = ${claim.id}::uuid`.execute(db);
    expect(attempts).toEqual([{ outcome: 'completed' }]);
  }, 60_000);
});
