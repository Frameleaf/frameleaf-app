import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { freezeSelection } from 'src/queue/manifest.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueIntent } from 'src/queue/types.js';
import { getKyselyDB } from 'test/utils.js';

describe('bounded queue settlement and durable dependencies', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  const intent = (extra: Partial<QueueIntent> = {}): QueueIntent => ({
    queue,
    name: 'metadata',
    data: {},
    safeToRetry: true,
    sensitive: false,
    deadlineMs: 60_000,
    ...extra,
  });
  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });
  beforeEach(async () => {
    queue = `bounded-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });
  afterAll(async () => db?.destroy());

  it('keeps paused unadmitted selections and empty in-progress enumeration unfinished', async () => {
    expect(await store.hasUnfinishedWork(queue)).toBe(false);
    const runId = await freezeSelection(
      db,
      intent(),
      db.selectFrom(sql<{ id: string }>`(select 'one'::text id)`.as('selected')).select('id'),
    );
    await store.pause(queue, true);
    expect((await store.counts(queue)).waiting).toBe(0);
    expect(await store.hasUnfinishedWork(queue)).toBe(true);
    await sql`update job_run_item set state='cancelled' where "runId"=${runId}::uuid`.execute(db);
    await sql`update job_selection set state='enumerating' where "runId"=${runId}::uuid`.execute(db);
    expect(await store.hasUnfinishedWork(queue)).toBe(true);
    await sql`update job_selection set state='needs_attention' where "runId"=${runId}::uuid`.execute(db);
    expect(await store.hasUnfinishedWork(queue)).toBe(false);
  });

  it('settles every shared run only after the accepted downstream stage completes', async () => {
    const runs = [await store.createRun('first', {}), await store.createRun('shared', {})];
    for (const runId of runs) {
      await store.enqueue([
        intent({ runId, itemKey: 'asset', rootItemKey: 'asset', options: { deduplication: { id: 'shared-root' } } }),
      ]);
      await store.finishEnumeration(runId);
    }
    const [parent] = await store.claim(queue, worker);
    expect(
      await store.complete(parent, [intent({ name: 'thumbnail', options: { deduplication: { id: 'shared-child' } } })]),
    ).toBe(true);
    expect(
      (await sql`select id from job_run where id=any(${runs}::uuid[]) and "finishedAt" is not null`.execute(db)).rows,
    ).toEqual([]);
    const [child] = await store.claim(queue, worker);
    expect(await store.complete(child, [])).toBe(true);
    const { rows } = await sql<{ runId: string; completed: number; roots: number }>`select "runId",
      count(*) filter(where state='completed')::int completed,count(distinct "rootItemKey")::int roots
      from job_run_item where "runId"=any(${runs}::uuid[]) group by "runId"`.execute(db);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.completed === 2 && row.roots === 1)).toBe(true);
    expect(
      (await sql`select id from job_run where id=any(${runs}::uuid[]) and "finishedAt" is not null`.execute(db)).rows,
    ).toHaveLength(2);
  });

  it('settles shared descendant memberships even when their failed ancestor has no run', async () => {
    await store.enqueue([intent({ safeToRetry: false })]);
    const [parent] = await store.claim(queue, worker);
    const runs = [await store.createRun('first-child', {}), await store.createRun('shared-child', {})];
    for (const runId of runs) {
      await store.enqueue([
        intent({
          runId,
          itemKey: 'child',
          rootItemKey: 'asset',
          parentId: parent.id,
          options: { deduplication: { id: 'dependent-child' } },
        }),
      ]);
      await store.finishEnumeration(runId);
    }
    const {
      rows: [child],
    } = await sql<{ id: string }>`select id from job where queue=${queue} and "parentId"=${parent.id}::uuid`.execute(
      db,
    );
    await store.enqueue([
      intent({ runId: runs[1], name: 'later-stage', itemKey: 'grandchild', rootItemKey: 'asset', parentId: child.id }),
    ]);
    expect(await store.fail(parent, 'unsafe ancestor stopped')).toBe(true);
    const { rows } = await sql<{ state: string; count: number }>`select state,count(*)::int count from job_run_item
      where "runId"=any(${runs}::uuid[]) group by state`.execute(db);
    expect(rows).toEqual([{ state: 'blocked', count: 3 }]);
    expect(
      (await sql`select id from job_run where id=any(${runs}::uuid[]) and "finishedAt" is not null`.execute(db)).rows,
    ).toHaveLength(2);
  });
});
