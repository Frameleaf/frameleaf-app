import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { retryLockContention } from 'src/queue/catalogue.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueClaim, QueueIntent } from 'src/queue/types.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1265: completions are no longer published one at a time through a global lock. */
describe('queue completion concurrency', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  const intent = (extra: Partial<QueueIntent>): QueueIntent => ({
    queue,
    name: 'AssetGenerateThumbnails',
    data: { id: randomUUID() },
    safeToRetry: true,
    sensitive: false,
    deadlineMs: QUEUE_TIMING.opaqueDeadline,
    ...extra,
  });
  const claimAll = async (count: number, runId: string) => {
    await store.setConcurrency(queue, count);
    await store.enqueue(
      Array.from({ length: count }, (_, index) =>
        intent({ runId, itemKey: `item-${index}`, rootItemKey: `item-${index}` }),
      ),
    );
    const claims = await store.claim(queue, worker, count);
    expect(claims).toHaveLength(count);
    return claims;
  };

  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    await sql`create table completion_domain (id integer primary key, value integer not null default 0)`.execute(db);
    await sql`insert into completion_domain (id) values (1), (2)`.execute(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    queue = `completion-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });

  it('commits eight completions of one run side by side, each with its follow-up', async () => {
    const count = 8;
    const runId = await store.createRun('AssetGenerateThumbnailsQueueAll', {});
    const claims = await claimAll(count, runId);
    // Every adoption waits until all of them are inside their transactions: serialized completions never get there.
    const inside = Promise.withResolvers<void>();
    let entered = 0;
    const followup = (claim: QueueClaim) =>
      intent({
        queue: `${queue}-next`,
        name: 'SmartSearch',
        runId,
        itemKey: claim.itemKey!,
        rootItemKey: claim.itemKey,
      });
    const results = await Promise.all(
      claims.map((claim) =>
        store.complete(claim, [followup(claim)], async () => {
          if (++entered === count) inside.resolve();
          await inside.promise;
        }),
      ),
    );
    expect(results).toEqual(Array.from({ length: count }, () => true));
    const { rows } = await sql<{ queue: string; state: string; count: number }>`select queue, state, count(*)::int count
      from job where "runId" = ${runId}::uuid group by queue, state order by queue`.execute(db);
    expect(rows).toEqual([
      { queue, state: 'completed', count },
      { queue: `${queue}-next`, state: 'pending', count },
    ]);
  });

  it('runs a completion that lost a deadlock again, so neither its domain write nor its follow-up is lost', async () => {
    const runId = await store.createRun('AssetGenerateThumbnailsQueueAll', {});
    const [first, second] = await claimAll(2, runId);
    const bothLocked = Promise.withResolvers<void>();
    let locked = 0;
    let attempts = 0;
    // Each adoption takes one domain row, waits for the other, then wants the other's row: one of them deadlocks.
    const complete = (claim: QueueClaim, own: number, other: number) =>
      retryLockContention(undefined, () =>
        store.complete(
          claim,
          [intent({ queue: `${queue}-next`, name: 'SmartSearch', runId, itemKey: claim.itemKey! })],
          async (tx) => {
            attempts++;
            await sql`update completion_domain set value = value + 1 where id = ${own}`.execute(tx);
            if (++locked === 2) bothLocked.resolve();
            await bothLocked.promise;
            await sql`update completion_domain set value = value + 1 where id = ${other}`.execute(tx);
          },
        ),
      );
    await sql`update completion_domain set value = 0`.execute(db);
    expect(await Promise.all([complete(first, 1, 2), complete(second, 2, 1)])).toEqual([true, true]);
    expect(attempts).toBe(3);
    const { rows: domain } = await sql<{ value: number }>`select value from completion_domain order by id`.execute(db);
    expect(domain).toEqual([{ value: 2 }, { value: 2 }]);
    const { rows } = await sql<{ count: number }>`select count(*)::int count from job
      where queue = ${`${queue}-next`} and "runId" = ${runId}::uuid`.execute(db);
    expect(rows).toEqual([{ count: 2 }]);
  });
});
