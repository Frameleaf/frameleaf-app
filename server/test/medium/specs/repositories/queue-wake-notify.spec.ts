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

    // let the enqueue's own notifications arrive first
    await new Promise((resolve) => setTimeout(resolve, 200));
    notes.length = 0;
    expect(await store.wakeDeferred([claim.id], 'locked-key-unavailable')).toBe(1);
    await vi.waitFor(() => expect(notes).toHaveLength(1));

    notes.length = 0;
    expect(await store.wakeDeferred([claim.id], 'locked-key-unavailable')).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(notes).toEqual([]);
  });
});
