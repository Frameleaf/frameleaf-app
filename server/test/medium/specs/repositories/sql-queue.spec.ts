import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueIntent } from 'src/queue/types.js';
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

  it('keeps 15,000 immutable selected items accounted for across mixed terminal outcomes and dependency stages', async () => {
    const runId = await store.createRun('mixed', { requested: 15_000 });
    await store.enqueue(Array.from({ length: 15_000 }, (_, index) => intent({ runId, itemKey: String(index) })));
    await store.finishEnumeration(runId);
    const [claim] = await store.claim(queue, workerA);
    await store.complete(claim, [intent({ name: 'ml', runId, itemKey: claim.itemKey!, parentId: claim.id })]);
    const {
      rows: [ready],
    } = await sql<{
      count: number;
    }>`select count(*)::int count from job where queue = ${queue} and state in ('waiting','active')`.execute(db);
    expect(ready.count).toBeLessThanOrEqual(1000);
    const open = (await store.listRuns(100, 0)).find((run) => run.id === runId)!;
    expect(open.total).toBe(15_001);
    expect(open.finishedAt).toBeNull();
    // Persisted outcomes from many workers: accounting must include every row, not a bounded job-list page.
    await sql`update job_run_item set state = case when "itemKey"::int % 13 = 0 then 'failed' else 'completed' end where "runId" = ${runId}::uuid`.execute(
      db,
    );
    await store.finishEnumeration(runId);
    const final = (await store.listRuns(100, 0)).find((run) => run.id === runId)!;
    expect(final.total).toBe(15_001);
    expect(final.completed + final.failed).toBe(15_001);
    expect(final.failed).toBeGreaterThan(1000);
    expect(final.state).toBe('failed');
    expect(final.finishedAt).not.toBeNull();
  }, 180_000);

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
});
