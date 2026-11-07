import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { QUEUE_CHANNEL } from 'src/queue/notifications.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1265: waking a Locked-key deferral tells the claim loops, so the job runs now, not at their next scan. */
describe('waking deferred jobs', () => {
  let db: Kysely<DB>;
  let store: SqlQueueStore;
  let listener: postgres.Sql;
  const notes: string[] = [];
  /** The notifications sent so far: PostgreSQL delivers them in commit order, so a marker sent now arrives after them. */
  const drain = async () => {
    const marker = randomUUID();
    await sql`select pg_notify(${QUEUE_CHANNEL}, ${marker})`.execute(db);
    await vi.waitFor(() => expect(notes).toContain(marker));
    return notes.splice(0).filter((note) => note !== marker);
  };

  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    const {
      rows: [{ name }],
    } = await sql<{ name: string }>`select current_database() name`.execute(db);
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = `/${name}`;
    listener = postgres(url.href, { max: 1 });
    await listener.listen(QUEUE_CHANNEL, (payload) => {
      notes.push(payload);
    });
  });
  afterAll(async () => {
    await listener?.end({ timeout: 1 });
    await db?.destroy();
  });

  it('notifies the claim loops when it wakes a job, and not when nothing waits', async () => {
    const queue = `wake-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([queue], worker);
    await store.enqueue([
      { queue, name: 'fixture', data: {}, safeToRetry: true, sensitive: false, deadlineMs: 600_000 },
    ]);
    const [claim] = await store.claim(queue, worker);
    expect(await store.defer(claim, 'locked-key-unavailable')).toBe(true);

    // Wakes go out shortly after the call, outside its transaction, so wait past the coalescing delay.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
    await settle();
    await drain();
    expect(await store.wakeDeferred([claim.id], 'locked-key-unavailable')).toBe(1);
    await settle();
    expect(await drain()).toEqual(['']);
    expect(await store.wakeDeferred([claim.id], 'locked-key-unavailable')).toBe(0);
    await settle();
    expect(await drain()).toEqual([]);
  });
});
