import { createPostgres } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { freezeSelection, shareSelectionPage } from 'src/queue/manifest.js';
import { pruneQueueHistory } from 'src/queue/retention.js';
import { selectionLineageSource } from 'src/queue/selection-lineage.js';
import { SqlQueueStore, resetQueueAfterRestore } from 'src/queue/store.js';
import { QueueClaim, QueueIntent } from 'src/queue/types.js';
import { down, up } from 'src/schema/migrations/1791101500000-RetainSelectionLineage.js';
import {
  down as downLibrarySources,
  up as upLibrarySources,
} from 'src/schema/migrations/1791101600000-LibraryScanSources.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { SCALE_ITEMS, scaleIt } from 'test/medium/scale.js';
import { getKyselyDB } from 'test/utils.js';

it('retains downstream stages published before a late shared membership is copied', async () => {
  const db = await getKyselyDB();
  try {
    const store = new SqlQueueStore(db);
    const queue = `lineage-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([queue], worker);
    const runs = await Promise.all([1, 2].map(() => store.createRun('late-lineage', {})));
    const intent = (name: string): QueueIntent => ({
      queue,
      name,
      data: { id: '1' },
      safeToRetry: true,
      sensitive: false,
      deadlineMs: 600_000,
    });
    const producer = (runId: string): QueueIntent => ({
      ...intent('producer'),
      runId,
      itemKey: 'producer',
      options: { deduplication: { id: queue } },
    });
    const capture = (claim: QueueClaim) =>
      freezeSelection(db, intent('selected'), db.selectNoFrom(sql<string>`'1'::text`.as('id')), {
        claim,
        signal: new AbortController().signal,
        progress: () => {},
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      });
    await store.enqueue([producer(runs[0])]);
    const [first] = await store.claim(queue, worker);
    await capture(first);
    await store.enqueue([{ ...producer(runs[0]), options: { deduplication: { id: queue, keepLastIfActive: true } } }]);
    expect(await store.complete(first, [])).toBe(true);
    expect(await store.feedManifest(queue)).toBe(1);
    await store.setConcurrency(queue, 2);
    const claims = await store.claim(queue, worker);
    const replay = claims.find((claim) => claim.name === 'producer')!;
    const selected = claims.find((claim) => claim.name === 'selected')!;
    await capture(replay);
    await store.enqueue([producer(runs[1])]);
    expect(await store.complete(selected, [{ ...intent('downstream'), parentId: selected.id }])).toBe(true);
    expect(await store.complete(replay, [])).toBe(true);
    const summaries = await store.listRuns(10, 0);
    expect(summaries.find((run) => run.id === runs[1])).toMatchObject({
      total: 1,
      waiting: 1,
      finishedAt: null,
      stageTotals: { total: 3, waiting: 1 },
    });
  } finally {
    await db.destroy();
  }
});

describe('durable selected-job descendant lineage', () => {
  let db: Kysely<any>;
  beforeEach(async () => {
    db = await getKyselyDB();
  });
  afterEach(async () => db?.destroy());
  const lateShare = async (count = 1, ownerOrder?: 'first' | 'last') => {
    const store = new SqlQueueStore(db);
    const queue = `lineage-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([queue], worker);
    const runs = await Promise.all([1, 2].map(() => store.createRun('late-lineage', {})));
    if (ownerOrder) runs.sort();
    if (ownerOrder === 'last') runs.reverse();
    const intent = (name: string): QueueIntent => ({
      queue,
      name,
      data: { id: 'z' },
      safeToRetry: true,
      sensitive: false,
      deadlineMs: 600_000,
    });
    const producer = (runId: string): QueueIntent => ({
      ...intent('producer'),
      runId,
      itemKey: 'producer',
      options: { deduplication: { id: queue } },
    });
    const capture = (claim: QueueClaim) =>
      freezeSelection(
        db,
        intent('selected'),
        db
          .selectFrom(
            sql<{
              id: string;
            }>`(select 'a' || lpad(n::text, 4, '0') id from generate_series(1, ${count - 1}) n union all select 'z')`.as(
              'selected',
            ),
          )
          .select('id'),
        {
          claim,
          signal: new AbortController().signal,
          progress: () => {},
          progressUnits: 0,
          adoptions: [],
          followups: [],
          buffering: false,
        },
      );
    await store.enqueue([producer(runs[0])]);
    const [first] = await store.claim(queue, worker);
    await capture(first);
    await store.enqueue([{ ...producer(runs[0]), options: { deduplication: { id: queue, keepLastIfActive: true } } }]);
    await store.complete(first, []);
    while (await store.feedManifest(queue)) {
      /* only the fixed small fixture is admitted */
    }
    await sql`update job set "createdAt" = now() - interval '1 day' where name = 'selected' and "itemKey" = 'z'`.execute(
      db,
    );
    await store.setConcurrency(queue, 2);
    const claims = await store.claim(queue, worker);
    const replay = claims.find((claim) => claim.name === 'producer')!;
    const selected = claims.find((claim) => claim.name === 'selected')!;
    await capture(replay);
    await store.enqueue([producer(runs[1])]);
    const claimChild = async (name: string) => {
      await sql`update job set "createdAt" = now() - interval '2 days' where name = ${name} and state = 'pending'`.execute(
        db,
      );
      return (await store.claim(queue, worker))[0];
    };
    const drain = async () => {
      let pages = 0;
      while (await shareSelectionPage(db, { producerId: replay.id })) pages++;
      return pages;
    };
    return { store, queue, worker, runs, intent, replay, selected, claimChild, drain };
  };

  const controlConnection = async () => {
    const {
      rows: [database],
    } = await sql<{ name: string }>`select current_database() name`.execute(db);
    return new Kysely<any>({
      dialect: new PostgresJSDialect({
        postgres: createPostgres({
          connection: {
            connectionType: 'url',
            url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, database.name),
          },
          maxConnections: 2,
          statementTimeoutMs: 5000,
          lockTimeoutMs: 3000,
        }),
      }),
    });
  };

  const waitForQueueLock = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows } = await sql`select 1 from pg_stat_activity where datname = current_database()
        and pid != pg_backend_pid() and wait_event_type = 'Lock' and query like '%job_queue%'`.execute(db);
      if (rows.length > 0) return;
      await sleep(10);
    }
    throw new Error('Expected a publication/copy client waiting on the queue guard');
  };

  it('rolls back origins, inherited jobs and cursor acknowledgment together after an interrupted publication or copy', async () => {
    const f = await lateShare();
    await sql`create function reject_lineage_wakeup() returns trigger language plpgsql as $$
      begin if not new."copyComplete" then raise exception 'interrupted lineage wakeup'; end if; return new; end
    $$`.execute(db);
    await sql`create trigger reject_lineage_wakeup before update on job_selection_run for each row execute function reject_lineage_wakeup()`.execute(
      db,
    );
    const children = [
      { ...f.intent('child'), itemKey: '000-child', parentId: f.selected.id, options: { jobId: `${f.queue}/child` } },
    ];
    await expect(f.store.complete(f.selected, children)).rejects.toThrow('interrupted lineage wakeup');
    expect((await sql`select id from job where name = 'child'`.execute(db)).rows).toEqual([]);
    expect((await sql`select id from job_selection_lineage`.execute(db)).rows).toEqual([]);
    expect((await sql`select state, token from job where id = ${f.selected.id}::uuid`.execute(db)).rows).toEqual([
      { state: 'active', token: f.selected.token },
    ]);
    await sql`drop trigger reject_lineage_wakeup on job_selection_run`.execute(db);
    expect(await f.store.complete(f.selected, children)).toBe(true);
    await sql`create function reject_lineage_cursor() returns trigger language plpgsql as $$
      begin if new."lineageAfter" > old."lineageAfter" then raise exception 'interrupted lineage cursor'; end if; return new; end
    $$`.execute(db);
    await sql`create trigger reject_lineage_cursor before update on job_selection_run for each row execute function reject_lineage_cursor()`.execute(
      db,
    );
    await expect(shareSelectionPage(db, { producerId: f.replay.id })).rejects.toThrow('interrupted lineage cursor');
    expect(
      (
        await sql`select stage from job_run_item where "runId" = ${f.runs[1]}::uuid and "rootItemKey" is not null`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await sql`select "lineageAfter"::text, "copyComplete" from job_selection_run where "runId" = ${f.runs[1]}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ lineageAfter: '0', copyComplete: false }]);
    await sql`drop trigger reject_lineage_cursor on job_selection_run`.execute(db);
    await f.drain();
    expect((await sql`select id from job where name = 'child'`.execute(db)).rows).toHaveLength(1);
    expect((await sql`select id from job_selection_lineage`.execute(db)).rows).toHaveLength(1);
    expect(
      (await sql`select stage from job_run_item where "runId" = ${f.runs[1]}::uuid and stage = 'child'`.execute(db))
        .rows,
    ).toHaveLength(1);
  });

  it.each(['publication', 'copy'] as const)(
    'retains a future descendant when %s acquires the guard first',
    async (first) => {
      const f = await lateShare();
      const controlDb = await controlConnection();
      const control = new SqlQueueStore(controlDb);
      const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      const children = [
        {
          ...f.intent('child'),
          itemKey: '000-behind-root',
          parentId: f.selected.id,
          options: { jobId: `${f.queue}/child` },
        },
      ];
      let held: Promise<unknown> | undefined;
      let competing: Promise<unknown> | undefined;
      try {
        if (first === 'publication') {
          held = f.store.complete(f.selected, children, async () => {
            enter();
            await gate;
          });
          await entered;
          competing = shareSelectionPage(controlDb, { producerId: f.replay.id });
        } else {
          held = db.transaction().execute(async (tx) => {
            expect(await shareSelectionPage(tx, { producerId: f.replay.id })).toBe(true);
            enter();
            await gate;
          });
          await entered;
          competing = control.complete(f.selected, children);
        }
        await waitForQueueLock();
        release();
        await Promise.all([held, competing]);
        await f.drain();
        expect(
          (
            await sql`select "itemKey", state from job_run_item where "runId" = ${f.runs[1]}::uuid and stage = 'child'`.execute(
              db,
            )
          ).rows,
        ).toEqual([{ itemKey: '000-behind-root', state: 'pending' }]);
        expect((await sql`select id from job where name = 'child'`.execute(db)).rows).toHaveLength(1);
        expect((await sql`select id from job_selection_lineage`.execute(db)).rows).toHaveLength(1);
      } finally {
        release();
        await Promise.allSettled([held, competing]);
        await controlDb.destroy();
      }
    },
  );

  it('copies a child and grandchild whose keys arrive behind a partially advanced root cursor', async () => {
    const f = await lateShare(251);
    expect(await shareSelectionPage(db, { producerId: f.replay.id })).toBe(true);
    expect(
      (
        await sql`select "copyAfter", "copyComplete" from job_selection_run where "runId" = ${f.runs[1]}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ copyAfter: 'a0250', copyComplete: false }]);
    await f.store.complete(f.selected, [{ ...f.intent('child'), itemKey: '000-child', parentId: f.selected.id }]);
    const child = await f.claimChild('child');
    expect(child.name).toBe('child');
    await f.store.complete(child, [{ ...f.intent('grandchild'), itemKey: '000-before-child', parentId: child.id }]);
    expect(
      (
        await sql`select stage from job_run_item where "runId" = ${f.runs[1]}::uuid and stage in ('child','grandchild')`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
    // One root plus two descendants fit the remainder of the next 250-row transaction.
    expect(await f.drain()).toBe(1);
    await f.store.complete(f.replay, []);
    const { rows } = await sql`select "itemKey", "rootItemKey", stage, state from job_run_item
      where "runId" = ${f.runs[1]}::uuid and stage in ('child','grandchild') order by stage`.execute(db);
    expect(rows).toEqual([
      { itemKey: '000-child', rootItemKey: 'z', stage: 'child', state: 'completed' },
      { itemKey: '000-before-child', rootItemKey: 'z', stage: 'grandchild', state: 'pending' },
    ]);
    expect((await f.store.listRuns(10, 0)).find((run) => run.id === f.runs[1])).toMatchObject({
      total: 251,
      finishedAt: null,
      stageTotals: { total: 254 },
    });
  });

  it('reopens a finished copy cursor for future descendants without repeating publication or execution', async () => {
    const f = await lateShare();
    await f.drain();
    const adopt = vi.fn().mockResolvedValue(undefined);
    expect(
      await f.store.complete(
        f.selected,
        [{ ...f.intent('child'), itemKey: '000-child', parentId: f.selected.id }],
        adopt,
      ),
    ).toBe(true);
    expect(
      await f.store.complete(
        f.selected,
        [{ ...f.intent('child'), itemKey: '000-child', parentId: f.selected.id }],
        adopt,
      ),
    ).toBe(false);
    expect(adopt).toHaveBeenCalledOnce();
    expect(
      (await sql`select "copyComplete" from job_selection_run where "runId" = ${f.runs[1]}::uuid`.execute(db)).rows,
    ).toEqual([{ copyComplete: false }]);
    const child = await f.claimChild('child');
    await f.store.fail(child, 'retry once');
    await f.drain();
    await sql`update job set "availableAt" = now() where id = ${child.id}::uuid`.execute(db);
    const [retry] = await f.store.claim(f.queue, f.worker);
    expect(retry).toMatchObject({ id: child.id, attempt: 2 });
    await f.store.complete(retry, []);
    await f.store.complete(f.replay, []);
    expect((await sql`select id from job where name = 'child'`.execute(db)).rows).toHaveLength(1);
    expect((await sql`select id from job_selection_lineage`.execute(db)).rows).toHaveLength(1);
    for (const runId of f.runs)
      expect((await f.store.listRuns(10, 0)).find((run) => run.id === runId)).toMatchObject({
        total: 1,
        completed: 1,
        finishedAt: expect.any(Date),
        stageTotals: { total: 3, completed: 3 },
      });
  });

  it('copies at most 250 combined roots and descendants per visit and catches a behind-cursor grandchild', async () => {
    const f = await lateShare();
    const children = Array.from({ length: 260 }, (_, index) => ({
      ...f.intent('child'),
      itemKey: `child-${String(index).padStart(3, '0')}`,
      parentId: f.selected.id,
    }));
    await f.store.complete(f.selected, children);
    expect(await shareSelectionPage(db, { producerId: f.replay.id })).toBe(true);
    expect(
      (
        await sql<{ count: number }>`select count(*)::int count from job_run_item
      where "runId" = ${f.runs[1]}::uuid and "rootItemKey" is not null`.execute(db)
      ).rows[0].count,
    ).toBe(250);
    await sql`update job set "createdAt" = now() - interval '2 days' where "itemKey" = 'child-259'`.execute(db);
    const [lastChild] = await f.store.claim(f.queue, f.worker);
    expect(lastChild.itemKey).toBe('child-259');
    await f.store.complete(lastChild, [
      { ...f.intent('grandchild'), itemKey: '000-before-every-child', parentId: lastChild.id },
    ]);
    expect(await f.drain()).toBe(1);
    expect(
      (
        await sql<{ count: number }>`select count(*)::int count from job_run_item
      where "runId" = ${f.runs[1]}::uuid and "rootItemKey" is not null`.execute(db)
      ).rows[0].count,
    ).toBe(262);
    expect(
      (
        await sql`select "itemKey", state from job_run_item where "runId" = ${f.runs[1]}::uuid and stage = 'grandchild'`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ itemKey: '000-before-every-child', state: 'pending' }]);
    // Sharing copies membership only, never the execution or its attempt budget.
    expect(
      (
        await sql<{ count: number }>`select count(*)::int count from job where name in ('child','grandchild')`.execute(
          db,
        )
      ).rows[0].count,
    ).toBe(261);
  });

  it('retains pending lineage obligations through stopped-worker restore and preserves the retry budget', async () => {
    const f = await lateShare();
    await f.store.complete(f.selected, [{ ...f.intent('child'), itemKey: '000-child', parentId: f.selected.id }]);
    const child = await f.claimChild('child');
    await resetQueueAfterRestore(db);
    expect(await f.store.complete(child, [])).toBe(false);
    await f.drain();
    expect(
      (
        await sql`select "jobId", state from job_run_item where "runId" = ${f.runs[1]}::uuid and stage = 'child'`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ jobId: child.id, state: 'pending' }]);
    await sql`update job set "availableAt" = now() - interval '2 days' where id = ${child.id}::uuid`.execute(db);
    const [retry] = await f.store.claim(f.queue, f.worker, 1);
    expect(retry).toMatchObject({ id: child.id, attempt: 2 });
    expect((await sql`select id from job_selection_lineage`.execute(db)).rows).toHaveLength(1);
  });

  it('keeps descendant outcomes available after detailed terminal job history is pruned', async () => {
    const f = await lateShare();
    await f.store.complete(f.selected, [{ ...f.intent('child'), itemKey: '000-child', parentId: f.selected.id }]);
    const child = await f.claimChild('child');
    await f.store.complete(child, []);
    // Isolate the retention boundary: the late run has not copied the source's terminal child.
    await sql`update job_run set "finishedAt" = now(), "enumerationDone" = true where id = ${f.runs[0]}::uuid`.execute(
      db,
    );
    await sql`update job set "finishedAt" = now() - interval '8 days' where id = ${child.id}::uuid`.execute(db);
    expect(await pruneQueueHistory(db)).toBe(1);
    expect((await sql`select id from job where id = ${child.id}::uuid`.execute(db)).rows).toEqual([]);
    await f.drain();
    expect(
      (
        await sql`select "jobId", state, selection from job_run_item where "runId" = ${f.runs[1]}::uuid and stage = 'child'`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ jobId: null, state: 'completed', selection: {} }]);
    expect((await sql`select id from job_selection_lineage`.execute(db)).rows).toHaveLength(1);
  });

  it('preserves provable live ancestry across offline down/up replay', async () => {
    const f = await lateShare();
    await f.store.complete(f.selected, [{ ...f.intent('child'), itemKey: '000-child', parentId: f.selected.id }]);
    // Offline replay reverses the installed dependency order before restoring it forwards.
    await downLibrarySources(db);
    await down(db);
    expect(
      (await sql`select stage from job_run_item where "runId" = ${f.runs[1]}::uuid and stage = 'child'`.execute(db))
        .rows,
    ).toEqual([{ stage: 'child' }]);
    await up(db);
    await upLibrarySources(db);
    await f.drain();
    expect((await sql`select id from job_selection_lineage`.execute(db)).rows).toHaveLength(1);
    expect((await sql`select "libraryChildOrigin" from job_selection_lineage`.execute(db)).rows).toEqual([
      { libraryChildOrigin: false },
    ]);
    expect((await f.store.listRuns(10, 0)).find((run) => run.id === f.runs[1])).toMatchObject({
      finishedAt: null,
      stageTotals: { total: 3, waiting: 1 },
    });
  });

  it('refuses an already-pruned pre-protocol fixture whose ancestry is no longer provable', async () => {
    const f = await lateShare();
    await f.store.complete(f.selected, [{ ...f.intent('child'), itemKey: '000-child', parentId: f.selected.id }]);
    const child = await f.claimChild('child');
    await f.store.complete(child, []);
    await downLibrarySources(db);
    await down(db);
    await sql`update job_run_item set "jobId" = null where "jobId" = ${child.id}::uuid`.execute(db);
    await sql`delete from job where id = ${child.id}::uuid`.execute(db);
    await expect(up(db)).rejects.toThrow('Pre-protocol selection lineage cannot be proven');
  });

  it('refuses to infer pre-protocol ancestry merely from equal root keys', async () => {
    const f = await lateShare();
    await f.store.complete(f.selected, [{ ...f.intent('child'), itemKey: '000-child', parentId: f.selected.id }]);
    await downLibrarySources(db);
    await down(db);
    await sql`update job set "parentId" = null where name = 'child'`.execute(db);
    await expect(db.transaction().execute(up)).rejects.toThrow('without retained parent-job edges');
  });

  it('refuses to use one selection proof for a different selection sharing its physical child', async () => {
    const f = await lateShare();
    const otherQueue = `other-selection-${randomUUID()}`;
    await f.store.initialize([otherQueue]);
    const otherRun = await f.store.createRun('other-selection', {});
    await freezeSelection(
      db,
      { ...f.intent('other-selected'), queue: otherQueue },
      db.selectNoFrom(sql<string>`'z'::text`.as('id')),
      undefined,
      otherRun,
    );
    expect(await f.store.feedManifest(otherQueue)).toBe(1);
    const [other] = await f.store.claim(otherQueue, f.worker);
    const sharedChild = {
      ...f.intent('child'),
      itemKey: 'shared-child',
      options: { jobId: `${f.queue}/shared-child` },
    };
    await f.store.complete(f.selected, [{ ...sharedChild, parentId: f.selected.id }]);
    await f.store.complete(other, [{ ...sharedChild, parentId: other.id }]);
    expect((await sql`select id from job where name = 'child'`.execute(db)).rows).toHaveLength(1);
    expect((await sql`select "selectionId" from job_selection_lineage`.execute(db)).rows).toHaveLength(2);
    await downLibrarySources(db);
    await down(db);
    await expect(db.transaction().execute(up)).rejects.toThrow('without retained parent-job edges');
    expect((await sql`select to_regclass('job_selection_lineage') relation`.execute(db)).rows).toEqual([
      { relation: null },
    ]);
  });

  const deferredSharedChild = async (safeToRetry = true, ownerOrder?: 'first' | 'last') => {
    const f = await lateShare(1, ownerOrder);
    await f.drain();
    const queue = `deferred-child-${randomUUID()}`;
    await f.store.initialize([queue]);
    const priorRun = await f.store.createRun('prior-child', {});
    const options = { deduplication: { id: `${queue}/child`, keepLastIfActive: true } };
    await f.store.enqueue([
      { ...f.intent('child'), queue, runId: priorRun, itemKey: 'prior', rootItemKey: 'prior', safeToRetry, options },
    ]);
    const [prior] = await f.store.claim(queue, f.worker);
    const data = { id: 'z', revision: 2, destination: { id: 'pinned-destination', model: 'pinned-model' } };
    await f.store.complete(f.selected, [
      {
        ...f.intent('child'),
        queue,
        data,
        itemKey: 'shared-child',
        parentId: f.selected.id,
        safeToRetry,
        sensitive: !safeToRetry,
        options,
      },
    ]);
    expect((await sql`select id from job where queue = ${queue}`.execute(db)).rows).toHaveLength(1);
    expect(
      (
        await sql`select "runId", state, "jobId" from job_run_item where "runId" = any(${f.runs}::uuid[]) and stage = 'child' order by "runId"`.execute(
          db,
        )
      ).rows,
    ).toEqual(f.runs.toSorted().map((runId) => ({ runId, state: 'pending', jobId: null })));
    return { ...f, childQueue: queue, prior, options, data };
  };

  it.each([
    { order: 'first' as const, source: 'canonical', renewAlias: false },
    { order: 'last' as const, source: 'alias', renewAlias: false },
    { order: 'last' as const, source: 'alias with explicit renewal', renewAlias: true },
  ])('retires an active-predecessor deferred origin reused by its $source source', async ({ order, renewAlias }) => {
    const f = await deferredSharedChild(true, order);
    const copiedRun = await f.store.createRun('copied-before-deferred-replacement', {});
    await f.store.enqueue([
      { ...f.intent('producer'), runId: copiedRun, itemKey: 'producer', options: { deduplication: { id: f.queue } } },
    ]);
    await f.drain();
    const {
      rows: [origin],
    } = await sql<{ runId: string; itemKey: string; selectionId: string }>`
      select "runId", "itemKey", "selectionId" from job_selection_lineage where stage = 'child'`.execute(db);
    expect(origin.runId).toBe(f.runs.toSorted()[0]);
    expect(
      (
        await sql`select state, "latestPending"->>'runId' "latestRun" from job where id = ${f.prior.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ state: 'active', latestRun: f.runs[0] }]);
    const renewedRuns = renewAlias ? f.runs : [origin.runId];
    const oldRuns = [...f.runs, copiedRun].filter((runId) => !renewedRuns.includes(runId));
    const data = {
      id: 'z',
      revision: 3,
      destination: { id: 'deferred-replacement', model: 'pinned-replacement-model' },
    };
    await f.store.enqueue([
      {
        ...f.intent('child'),
        queue: f.childQueue,
        runId: origin.runId,
        itemKey: origin.itemKey,
        rootItemKey: 'z',
        options: f.options,
        data,
        memberships: renewAlias
          ? f.runs
              .filter((runId) => runId !== origin.runId)
              .map((runId) => ({ runId, itemKey: origin.itemKey, rootItemKey: 'z' }))
          : undefined,
      },
    ]);
    const assertOldCancelled = async () =>
      expect(
        (
          await sql`select "runId", state, "jobId" from job_run_item
      where "runId" = any(${oldRuns}::uuid[]) and stage = 'child' order by "runId"`.execute(db)
        ).rows,
      ).toEqual(oldRuns.toSorted().map((runId) => ({ runId, state: 'cancelled', jobId: null })));
    await assertOldCancelled();
    expect(
      (await sql`select id, state, "latestPending"->'data' data from job where queue = ${f.childQueue}`.execute(db))
        .rows,
    ).toEqual([{ id: f.prior.id, state: 'active', data }]);
    const lateRun = await f.store.createRun('copy-after-deferred-replacement', {});
    await f.store.enqueue([
      { ...f.intent('producer'), runId: lateRun, itemKey: 'producer', options: { deduplication: { id: f.queue } } },
    ]);
    expect(await f.store.complete(f.prior, [])).toBe(true);
    const [child] = await f.store.claim(f.childQueue, f.worker);
    expect(child).toMatchObject({ runId: origin.runId, attempt: 1, data });
    await assertOldCancelled();
    const adopt = vi.fn().mockResolvedValue(undefined);
    const followup = {
      ...f.intent('deferred-descendant'),
      queue: f.childQueue,
      itemKey: '000-deferred-descendant',
      parentId: child.id,
    };
    expect(await f.store.complete(child, [followup], adopt)).toBe(true);
    expect(await f.store.complete(child, [followup], adopt)).toBe(false);
    expect(adopt).toHaveBeenCalledOnce();
    const [descendant] = await f.store.claim(f.childQueue, f.worker);
    expect(descendant).toMatchObject({ name: 'deferred-descendant', attempt: 1 });
    await f.store.complete(descendant, []);
    await f.drain();
    oldRuns.push(lateRun);
    await assertOldCancelled();
    expect(
      (
        await sql`select "runId", state from job_run_item where stage = 'deferred-descendant' order by "runId"`.execute(
          db,
        )
      ).rows,
    ).toEqual(renewedRuns.toSorted().map((runId) => ({ runId, state: 'completed' })));
    expect((await sql`select id from job where queue = ${f.childQueue}`.execute(db)).rows).toHaveLength(3);
    expect(await f.store.claim(f.childQueue, f.worker)).toEqual([]);
    await f.store.complete(f.replay, []);
    expect(
      (
        await sql`select id from job_run where id = any(${[...renewedRuns, ...oldRuns]}::uuid[])
      and "finishedAt" is null`.execute(db)
      ).rows,
    ).toEqual([]);
    await sql`update job set "finishedAt" = now() - interval '8 days' where queue = ${f.childQueue}`.execute(db);
    for (let visit = 0; visit < 5; visit++) if ((await pruneQueueHistory(db)) === 0) break;
    expect((await sql`select id from job where id = ${child.id}::uuid`.execute(db)).rows).toEqual([]);
    const restoredRun = await f.store.createRun('retained-deferred-replacement', {});
    await sql`insert into job_selection_run("runId", "selectionId", "copyComplete")
      values (${restoredRun}::uuid, ${origin.selectionId}::uuid, false)`.execute(db);
    await f.drain();
    expect(
      (
        await sql`select state, "jobId", selection from job_run_item
      where "runId" = ${restoredRun}::uuid and stage = 'child'`.execute(db)
      ).rows,
    ).toEqual([{ state: 'cancelled', jobId: null, selection: {} }]);
    expect(
      (
        await sql`select stage from job_run_item where "runId" = ${restoredRun}::uuid
      and stage = 'deferred-descendant'`.execute(db)
      ).rows,
    ).toEqual([]);
  });

  it.each(['before replacement', 'after replacement', 'after descendants'] as const)(
    'keeps superseded requests detached when their history copies %s',
    async (copyAt) => {
      const f = await deferredSharedChild();
      expect(await f.store.complete(f.prior, [])).toBe(true);
      const lateRun = await f.store.createRun('replacement-late-history', {});
      await f.store.enqueue([
        { ...f.intent('producer'), runId: lateRun, itemKey: 'producer', options: { deduplication: { id: f.queue } } },
      ]);
      f.runs.push(lateRun);
      if (copyAt === 'before replacement') await f.drain();
      // Select the retained source deliberately: arbitrary UUID ordering must not hide the bug.
      const {
        rows: [origin],
      } = await sql<{
        runId: string;
        itemKey: string;
        selectionId: string;
      }>`select "runId", "itemKey", "selectionId" from job_selection_lineage
        where stage = 'child'`.execute(db);
      const oldRuns = f.runs.filter((runId) => runId !== origin.runId);
      const replacement = {
        id: 'z',
        revision: 3,
        destination: { id: 'replacement-destination', model: 'replacement-model' },
      };
      await f.store.enqueue([
        {
          ...f.intent('child'),
          queue: f.childQueue,
          runId: origin.runId,
          itemKey: origin.itemKey,
          rootItemKey: 'z',
          options: f.options,
          data: replacement,
        },
      ]);
      if (copyAt === 'after replacement') await f.drain();
      const assertDetached = async () => {
        const { rows } = await sql`select "runId", state, "jobId" from job_run_item
          where "runId" = any(${oldRuns}::uuid[]) and stage = 'child' order by "runId"`.execute(db);
        const copiedRuns = copyAt === 'after descendants' ? oldRuns.filter((runId) => runId !== lateRun) : oldRuns;
        expect(rows).toEqual(copiedRuns.toSorted().map((runId) => ({ runId, state: 'cancelled', jobId: null })));
      };
      await assertDetached();
      const [child] = await f.store.claim(f.childQueue, f.worker);
      expect(child).toMatchObject({ data: replacement, runId: origin.runId, attempt: 1 });
      await assertDetached();
      const adopt = vi.fn().mockResolvedValue(undefined);
      const followup = {
        ...f.intent('replacement-descendant'),
        queue: f.childQueue,
        itemKey: '000-replacement-descendant',
        parentId: child.id,
      };
      expect(await f.store.complete(child, [followup], adopt)).toBe(true);
      expect(await f.store.complete(child, [followup], adopt)).toBe(false);
      expect(adopt).toHaveBeenCalledOnce();
      await assertDetached();
      const [descendant] = await f.store.claim(f.childQueue, f.worker);
      expect(descendant).toMatchObject({ name: 'replacement-descendant', runId: origin.runId, attempt: 1 });
      await f.store.complete(descendant, []);
      await f.drain();
      await f.store.complete(f.replay, []);
      expect(
        (
          await sql`select "runId", state, "jobId" from job_run_item
        where "runId" = any(${oldRuns}::uuid[]) and stage = 'child' order by "runId"`.execute(db)
        ).rows,
      ).toEqual(oldRuns.toSorted().map((runId) => ({ runId, state: 'cancelled', jobId: null })));
      expect(
        (await sql`select "runId", state from job_run_item where stage = 'replacement-descendant'`.execute(db)).rows,
      ).toEqual([{ runId: origin.runId, state: 'completed' }]);
      expect((await sql`select id from job where queue = ${f.childQueue}`.execute(db)).rows).toHaveLength(3);
      expect(await f.store.claim(f.childQueue, f.worker)).toEqual([]);
      expect(
        (await sql`select id from job_run where id = any(${f.runs}::uuid[]) and "finishedAt" is null`.execute(db)).rows,
      ).toEqual([]);
      if (copyAt === 'after descendants') {
        await expect(db.transaction().execute(down)).rejects.toThrow(
          'Superseded selection lineage cannot be represented before migration150',
        );
        expect(
          (await sql`select superseded from job_selection_lineage where stage = 'child'`.execute(db)).rows,
        ).toEqual([{ superseded: true }]);
        await sql`update job set "finishedAt" = now() - interval '8 days' where queue = ${f.childQueue}`.execute(db);
        for (let visit = 0; visit < 5; visit++) if ((await pruneQueueHistory(db)) === 0) break;
        expect((await sql`select id from job where id = ${child.id}::uuid`.execute(db)).rows).toEqual([]);
        // A retained selection mapping restored after payload pruning still copies the old
        // cancellation; the replacement's retained completed source is not its entitlement.
        const restoredRun = await f.store.createRun('restored-cancelled-history', {});
        await sql`insert into job_selection_run("runId", "selectionId", "copyComplete")
          values (${restoredRun}::uuid, ${origin.selectionId}::uuid, false)`.execute(db);
        await f.drain();
        expect(
          (
            await sql`select state, "jobId", selection from job_run_item
          where "runId" = ${restoredRun}::uuid and stage = 'child'`.execute(db)
          ).rows,
        ).toEqual([{ state: 'cancelled', jobId: null, selection: {} }]);
        expect(
          (
            await sql`select stage from job_run_item where "runId" = ${restoredRun}::uuid
          and stage = 'replacement-descendant'`.execute(db)
          ).rows,
        ).toEqual([]);
      }
    },
  );

  it('rolls back origin supersession with a refused pending replacement', async () => {
    const f = await deferredSharedChild();
    await f.store.complete(f.prior, []);
    const {
      rows: [origin],
    } = await sql<{ runId: string; itemKey: string }>`select "runId", "itemKey"
      from job_selection_lineage where stage = 'child'`.execute(db);
    await sql`create function refuse_replacement() returns trigger language plpgsql as $$
      begin if new.data->>'revision' = '3' then raise exception 'replacement write refused'; end if; return new; end $$`.execute(
      db,
    );
    await sql`create trigger refuse_replacement before update of data on job
      for each row execute function refuse_replacement()`.execute(db);
    await expect(
      f.store.enqueue([
        {
          ...f.intent('child'),
          queue: f.childQueue,
          ...origin,
          rootItemKey: 'z',
          options: f.options,
          data: { ...f.data, revision: 3 },
        },
      ]),
    ).rejects.toThrow('replacement write refused');
    expect((await sql`select superseded from job_selection_lineage`.execute(db)).rows).toEqual([{ superseded: false }]);
    const [child] = await f.store.claim(f.childQueue, f.worker);
    expect(child.data).toEqual(f.data);
    await f.store.complete(child, []);
    expect(
      (
        await sql`select state, "jobId" from job_run_item
      where "runId" = any(${f.runs}::uuid[]) and stage = 'child'`.execute(db)
      ).rows,
    ).toEqual(f.runs.map(() => ({ state: 'completed', jobId: child.id })));
  });

  it('preserves explicitly renewed replacement memberships without granting them to an old selection copy', async () => {
    const f = await deferredSharedChild();
    await f.store.complete(f.prior, []);
    const {
      rows: [origin],
    } = await sql<{ runId: string; itemKey: string }>`select "runId", "itemKey"
      from job_selection_lineage where stage = 'child'`.execute(db);
    const lateRun = await f.store.createRun('not-renewed', {});
    await f.store.enqueue([
      { ...f.intent('producer'), runId: lateRun, itemKey: 'producer', options: { deduplication: { id: f.queue } } },
    ]);
    await f.drain();
    await f.store.complete(f.replay, []);
    const data = { ...f.data, revision: 3 };
    await f.store.enqueue([
      {
        ...f.intent('child'),
        queue: f.childQueue,
        ...origin,
        rootItemKey: 'z',
        options: f.options,
        data,
        memberships: f.runs
          .filter((runId) => runId !== origin.runId)
          .map((runId) => ({ runId, itemKey: origin.itemKey, rootItemKey: 'z' })),
      },
    ]);
    expect(
      (await sql`select id from job_run where id = any(${f.runs}::uuid[]) and "finishedAt" is not null`.execute(db))
        .rows,
    ).toEqual([]);
    const [child] = await f.store.claim(f.childQueue, f.worker);
    expect(child).toMatchObject({ data, attempt: 1 });
    expect(
      (
        await sql`select state, "jobId" from job_run_item
      where "runId" = any(${f.runs}::uuid[]) and stage = 'child'`.execute(db)
      ).rows,
    ).toEqual(f.runs.map(() => ({ state: 'active', jobId: child.id })));
    await f.store.complete(child, [{ ...f.intent('renewed-descendant'), queue: f.childQueue, parentId: child.id }]);
    await f.drain();
    const [descendant] = await f.store.claim(f.childQueue, f.worker);
    await f.store.complete(descendant, []);
    expect(
      (
        await sql`select "runId", state from job_run_item where stage = 'renewed-descendant' order by "runId"`.execute(
          db,
        )
      ).rows,
    ).toEqual(f.runs.toSorted().map((runId) => ({ runId, state: 'completed' })));
    expect(
      (
        await sql`select state, "jobId" from job_run_item where "runId" = ${lateRun}::uuid and stage = 'child'`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ state: 'cancelled', jobId: null }]);
    expect((await sql`select id from job where name = 'renewed-descendant'`.execute(db)).rows).toHaveLength(1);
  });

  it('settles known and later copied deferred memberships after unconfirmed executor stop without replay', async () => {
    const f = await deferredSharedChild();
    const lateRun = await f.store.createRun('unconfirmed-late-history', {});
    await f.store.enqueue([
      { ...f.intent('producer'), runId: lateRun, itemKey: 'producer', options: { deduplication: { id: f.queue } } },
    ]);
    await f.drain();
    f.runs.push(lateRun);
    await f.store.complete(f.replay, []);
    // Correct keys with mismatched identities and an unrelated attempt are not stopped proof.
    await sql`insert into system_metadata(key, value) values
      (${'frameleaf-attempt-evidence:' + f.prior.token}, ${JSON.stringify({ jobId: randomUUID(), stoppedAt: Date.now() })}::text::jsonb),
      (${'frameleaf-worker-stopped:' + f.worker}, ${JSON.stringify({ workerId: randomUUID(), stoppedAt: Date.now() })}::text::jsonb),
      (${'frameleaf-attempt-evidence:' + randomUUID()}, ${JSON.stringify({ jobId: f.prior.id, stoppedAt: Date.now() })}::text::jsonb)`.execute(
      db,
    );
    await sql`update job set "leaseExpiresAt" = clock_timestamp() - interval '1 second' where id = ${f.prior.id}::uuid`.execute(
      db,
    );
    await f.store.recoverExpired();
    expect(
      (
        await sql`select state, "latestPending" is not null deferred from job where id = ${f.prior.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ state: 'active', deferred: true }]);
    await sql`update job set "leaseExpiresAt" = clock_timestamp() - interval '31 seconds' where id = ${f.prior.id}::uuid`.execute(
      db,
    );
    await f.store.recoverExpired();
    expect(
      (
        await sql`select "runId", state, "jobId" from job_run_item
      where "runId" = any(${f.runs}::uuid[]) and stage = 'child' order by "runId"`.execute(db)
      ).rows,
    ).toEqual(f.runs.toSorted().map((runId) => ({ runId, state: 'needs_attention', jobId: null })));
    expect(
      (await sql`select id, state, token, "latestPending", attempt from job where queue = ${f.childQueue}`.execute(db))
        .rows,
    ).toEqual([{ id: f.prior.id, state: 'needs_attention', token: null, latestPending: null, attempt: 1 }]);
    expect(
      (await sql`select id from job_run where id = any(${f.runs}::uuid[]) and "finishedAt" is null`.execute(db)).rows,
    ).toEqual([]);
    expect(await f.store.retryFailed(f.childQueue)).toBe(0);
    expect(await f.store.claim(f.childQueue, f.worker)).toEqual([]);
    expect(await f.store.complete(f.prior, [])).toBe(false);
    await f.store.recoverExpired();
    expect((await sql`select token from job_attempt where "jobId" = ${f.prior.id}::uuid`.execute(db)).rows).toEqual([
      { token: f.prior.token },
    ]);
  });

  it.each(['publish', 'supersede', 'clear', 'restore', 'unsafe'] as const)(
    'propagates %s after a third run copied a deferred child behind the original membership list',
    async (action) => {
      const f = await deferredSharedChild(action !== 'unsafe');
      const lateRun = await f.store.createRun('later-deferred-share', {});
      await f.store.enqueue([
        { ...f.intent('producer'), runId: lateRun, itemKey: 'producer', options: { deduplication: { id: f.queue } } },
      ]);
      await f.drain();
      f.runs.push(lateRun);
      expect(
        (
          await sql`select state, "jobId" from job_run_item where "runId" = ${lateRun}::uuid and stage = 'child'`.execute(
            db,
          )
        ).rows,
      ).toEqual([{ state: 'pending', jobId: null }]);
      let expected: string;
      switch (action) {
        case 'publish': {
          await f.store.complete(f.prior, []);
          const [child] = await f.store.claim(f.childQueue, f.worker);
          await f.store.complete(child, []);
          expected = 'completed';

          break;
        }
        case 'supersede': {
          const nextRun = await f.store.createRun('replacement', {});
          await f.store.enqueue([
            {
              ...f.intent('child'),
              queue: f.childQueue,
              runId: nextRun,
              itemKey: 'replacement',
              rootItemKey: 'replacement',
              options: f.options,
            },
          ]);
          expected = 'cancelled';

          break;
        }
        case 'clear': {
          await f.store.fail(f.prior, 'stopped retry');
          await f.store.clear(f.childQueue, ['pending', 'waiting']);
          expected = 'cancelled';

          break;
        }
        case 'restore': {
          await resetQueueAfterRestore(db);
          expected = 'needs_attention';

          break;
        }
        default: {
          await f.store.fail(f.prior, 'ambiguous external effect');
          expected = 'needs_attention';
        }
      }
      expect(
        (
          await sql`select state from job_run_item where "runId" = any(${f.runs}::uuid[]) and stage = 'child'`.execute(
            db,
          )
        ).rows,
      ).toEqual(f.runs.map(() => ({ state: expected })));
    },
  );

  it('publishes a deferred latest request with one execution, pinned data and one retry budget for all inherited runs', async () => {
    const f = await deferredSharedChild();
    expect(await f.store.complete(f.prior, [])).toBe(true);
    const [child] = await f.store.claim(f.childQueue, f.worker);
    expect(child).toMatchObject({ data: f.data, attempt: 1 });
    expect(
      (
        await sql`select "jobId", state from job_run_item where "runId" = any(${f.runs}::uuid[]) and stage = 'child'`.execute(
          db,
        )
      ).rows,
    ).toEqual([
      { jobId: child.id, state: 'active' },
      { jobId: child.id, state: 'active' },
    ]);
    await f.store.fail(child, 'one shared retry');
    await sql`update job set "availableAt" = now() where id = ${child.id}::uuid`.execute(db);
    const [retry] = await f.store.claim(f.childQueue, f.worker);
    expect(retry).toMatchObject({ id: child.id, data: f.data, attempt: 2 });
    const adopt = vi.fn().mockResolvedValue(undefined);
    expect(await f.store.complete(retry, [], adopt)).toBe(true);
    expect(await f.store.complete(retry, [], adopt)).toBe(false);
    expect(adopt).toHaveBeenCalledOnce();
    expect((await sql`select id from job where queue = ${f.childQueue}`.execute(db)).rows).toHaveLength(2);
    expect(
      (await sql`select state from job_run_item where "runId" = any(${f.runs}::uuid[]) and stage = 'child'`.execute(db))
        .rows,
    ).toEqual([{ state: 'completed' }, { state: 'completed' }]);
  });

  it('applies the existing restore attention policy to every deferred latest membership', async () => {
    const f = await deferredSharedChild();
    await resetQueueAfterRestore(db);
    expect(await f.store.complete(f.prior, [])).toBe(false);
    expect(
      (
        await sql`select state, "jobId" from job_run_item where "runId" = any(${f.runs}::uuid[]) and stage = 'child'`.execute(
          db,
        )
      ).rows,
    ).toEqual([
      { state: 'needs_attention', jobId: null },
      { state: 'needs_attention', jobId: null },
    ]);
    await sql`update job set "availableAt" = now() where id = ${f.prior.id}::uuid`.execute(db);
    const [restored] = await f.store.claim(f.childQueue, f.worker);
    expect(restored).toMatchObject({ id: f.prior.id, attempt: 2 });
    await f.store.complete(restored, []);
    expect(await f.store.claim(f.childQueue, f.worker)).toEqual([]);
    expect((await sql`select id, "latestPending" from job where queue = ${f.childQueue}`.execute(db)).rows).toEqual([
      { id: f.prior.id, latestPending: null },
    ]);
  });

  it.each(['supersede', 'clear'] as const)(
    'cancels every deferred shared membership when the latest request is %s',
    async (action) => {
      const f = await deferredSharedChild();
      if (action === 'supersede') {
        const nextRun = await f.store.createRun('replacement', {});
        await f.store.enqueue([
          {
            ...f.intent('child'),
            queue: f.childQueue,
            runId: nextRun,
            itemKey: 'replacement',
            rootItemKey: 'replacement',
            options: f.options,
          },
        ]);
      } else {
        await f.store.fail(f.prior, 'retry remains stopped with latest pending');
        await f.store.clear(f.childQueue, ['pending', 'waiting']);
      }
      expect(
        (
          await sql`select state, "jobId" from job_run_item where "runId" = any(${f.runs}::uuid[]) and stage = 'child'`.execute(
            db,
          )
        ).rows,
      ).toEqual([
        { state: 'cancelled', jobId: null },
        { state: 'cancelled', jobId: null },
      ]);
    },
  );

  it('keeps every unsafe deferred membership at attention after an unsuccessful predecessor', async () => {
    const f = await deferredSharedChild(false);
    await f.store.fail(f.prior, 'ambiguous external effect');
    expect(
      (
        await sql`select state, selection from job_run_item where "runId" = any(${f.runs}::uuid[]) and stage = 'child'`.execute(
          db,
        )
      ).rows,
    ).toEqual([
      { state: 'needs_attention', selection: {} },
      { state: 'needs_attention', selection: {} },
    ]);
    expect(await f.store.claim(f.childQueue, f.worker)).toEqual([]);
  });

  it('keeps an explicit separate-run followup outside inherited membership adoption', async () => {
    const f = await lateShare();
    await f.drain();
    const separateRun = await f.store.createRun('separate-intent', {});
    await f.store.complete(f.selected, [
      {
        ...f.intent('child'),
        runId: separateRun,
        itemKey: 'separate',
        rootItemKey: 'separate',
        parentId: f.selected.id,
      },
    ]);
    expect((await sql`select "runId", "rootItemKey" from job_run_item where stage = 'child'`.execute(db)).rows).toEqual(
      [{ runId: separateRun, rootItemKey: 'separate' }],
    );
    expect((await sql`select id from job_selection_lineage`.execute(db)).rows).toEqual([]);
  });

  scaleIt('copies %i retained descendants in bounded pages with responsive control work', 0.24, async () => {
    const f = await lateShare();
    const controlDb = await controlConnection();
    const control = new SqlQueueStore(controlDb);
    const queue = `lineage-control-${randomUUID()}`;
    await control.initialize([queue]);
    try {
      const {
        rows: [selection],
      } = await sql<{ id: string }>`select id from job_selection where "runId" = ${f.runs[0]}::uuid`.execute(db);
      // Seed retained outcomes, not media executions. Each actual copy below uses the production
      // protocol and the unchanged 5s statement/3s lock budget on a separate two-connection client.
      for (let offset = 0; offset < SCALE_ITEMS; offset += 5000) {
        await sql`with retained as (
          insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, state)
          select ${f.runs[0]}::uuid, 'history-' || lpad(n::text, 6, '0'), 'z', 'child', ${f.queue}, '{}'::jsonb, 'completed'
          from generate_series(${offset + 1}::int, ${offset + 5000}::int) n returning "runId", "itemKey", stage
        ) insert into job_selection_lineage("selectionId", "runId", "itemKey", stage)
          select ${selection.id}::uuid, "runId", "itemKey", stage from retained`.execute(controlDb);
      }
      // One source now belongs to a completed replacement; its old entitlement is cancelled.
      await sql`update job_selection_lineage set superseded = true where id = ${SCALE_ITEMS}`.execute(controlDb);
      await sql`analyze job_selection_lineage`.execute(db);
      await sql`analyze job_run_item`.execute(db);
      type Plan = {
        'Actual Rows': number;
        'Actual Loops': number;
        'Rows Removed by Filter'?: number;
        'Relation Name'?: string;
        'Index Name'?: string;
        Plans?: Plan[];
      };
      const examined = (p: Plan, relation?: string): number =>
        (p['Relation Name'] && (!relation || p['Relation Name'] === relation)
          ? (p['Actual Rows'] + (p['Rows Removed by Filter'] ?? 0)) * p['Actual Loops']
          : 0) + (p.Plans ?? []).reduce((total, child) => total + examined(child, relation), 0);
      // Migration160 adds a header check excluding library-child sources. Keep its work separate
      // from the unchanged <=250 lineage rows plus <=250 source-item lookups, never hide a scan.
      expect((await sql`select count(*)::int count from job_selection`.execute(controlDb)).rows).toEqual([
        { count: 1 },
      ]);
      const assertBoundedPlan = (plan: Plan) => {
        const descendantRows = examined(plan, 'job_selection_lineage') + examined(plan, 'job_run_item');
        const selectionRows = examined(plan, 'job_selection');
        expect(descendantRows).toBeLessThanOrEqual(500);
        expect(selectionRows).toBeLessThanOrEqual(1);
        expect(examined(plan)).toBe(descendantRows + selectionRows);
        return { descendantRows, selectionRows };
      };
      // Calibrate the counter against filtered rows and repeated lookups: a broad lineage scan
      // still exceeds the descendant budget even when it emits only one row.
      expect(
        examined(
          {
            'Relation Name': 'job_selection_lineage',
            'Actual Rows': 1,
            'Rows Removed by Filter': 250_000,
            'Actual Loops': 2,
          },
          'job_selection_lineage',
        ),
      ).toBe(500_002);
      const { rows: plans } = await sql<{ 'QUERY PLAN': [{ Plan: Plan }] }>`explain (analyze, buffers, format json)
        ${selectionLineageSource(selection.id, '499750')}`.execute(controlDb);
      const { descendantRows: tailRows, selectionRows: tailSelectionRows } = assertBoundedPlan(
        plans[0]['QUERY PLAN'][0].Plan,
      );
      expect(JSON.stringify(plans)).toContain('Index Scan');
      const { rows: firstPlans } = await sql<{
        'QUERY PLAN': [{ Plan: Plan }];
      }>`explain (analyze, buffers, format json)
        ${selectionLineageSource(selection.id, '0')}`.execute(controlDb);
      const { descendantRows: firstRows, selectionRows: firstSelectionRows } = assertBoundedPlan(
        firstPlans[0]['QUERY PLAN'][0].Plan,
      );
      const { rows: emptyPlans } = await sql<{
        'QUERY PLAN': [{ Plan: Plan }];
      }>`explain (analyze, buffers, format json)
        ${selectionLineageSource(selection.id, String(SCALE_ITEMS))}`.execute(controlDb);
      const { descendantRows: emptyTailRows, selectionRows: emptyTailSelectionRows } = assertBoundedPlan(
        emptyPlans[0]['QUERY PLAN'][0].Plan,
      );
      expect(emptyTailRows).toBe(0);
      expect(emptyTailSelectionRows).toBe(0);
      const {
        rows: [before],
      } = await sql<{ count: number }>`select count(*)::int count from job where queue = ${f.queue}`.execute(db);
      const started = performance.now();
      let pages = 0;
      let maxPageMs = 0;
      let maxControlMs = 0;
      let maxCopied = 0;
      let previous = 0;
      let latestCursor = 0;
      const probe = async () => {
        const probeStarted = performance.now();
        await control.heartbeat(f.worker, [f.replay, f.selected]);
        await control.enqueue([{ ...f.intent('unrelated'), queue }]);
        const [claim] = await control.claim(queue, f.worker);
        expect(claim).toBeDefined();
        expect(await control.complete(claim, [])).toBe(true);
        maxControlMs = Math.max(maxControlMs, performance.now() - probeStarted);
        expect(maxControlMs).toBeLessThan(1000);
      };
      for (let visit = 0; visit < SCALE_ITEMS / 250 + 2; visit++) {
        const pageStarted = performance.now();
        const [copied] = await Promise.all([
          shareSelectionPage(controlDb, { producerId: f.replay.id }),
          visit % 25 === 0 ? probe() : Promise.resolve(),
        ]);
        maxPageMs = Math.max(maxPageMs, performance.now() - pageStarted);
        if (!copied) break;
        pages++;
        const {
          rows: [cursor],
        } = await sql<{
          after: number;
          root: string;
          complete: boolean;
        }>`select "lineageAfter"::int "after", "copyAfter" root, "copyComplete" complete
          from job_selection_run where "runId" = ${f.runs[1]}::uuid`.execute(controlDb);
        const copiedCount = cursor.after + (cursor.root === 'z' ? 1 : 0);
        maxCopied = Math.max(maxCopied, copiedCount - previous);
        expect(copiedCount - previous).toBeGreaterThan(0);
        expect(copiedCount - previous).toBeLessThanOrEqual(250);
        previous = copiedCount;
        latestCursor = cursor.after;
        if (cursor.complete) break;
      }
      expect(pages).toBe(SCALE_ITEMS / 250 + 1);
      expect(latestCursor).toBe(SCALE_ITEMS);
      const {
        rows: [after],
      } = await sql<{ count: number }>`select count(*)::int count from job where queue = ${f.queue}`.execute(db);
      expect(after).toEqual(before);
      expect(
        (
          await sql`select count(*)::int count from job_run_item where "runId" = ${f.runs[1]}::uuid and stage = 'child'`.execute(
            db,
          )
        ).rows,
      ).toEqual([{ count: SCALE_ITEMS }]);
      expect(
        (
          await sql`select state, "jobId", selection from job_run_item
        where "runId" = ${f.runs[1]}::uuid and "itemKey" = ${`history-${String(SCALE_ITEMS).padStart(6, '0')}`} and stage = 'child'`.execute(
            controlDb,
          )
        ).rows,
      ).toEqual([{ state: 'cancelled', jobId: null, selection: {} }]);
      // This new origin is lexically before every retained child, after the durable cursor reached its tail.
      expect(
        await control.complete(f.selected, [
          {
            ...f.intent('future'),
            itemKey: '000-future',
            parentId: f.selected.id,
            options: { jobId: `${f.queue}/future` },
          },
        ]),
      ).toBe(true);
      expect(await shareSelectionPage(controlDb, { producerId: f.replay.id })).toBe(true);
      expect(
        (
          await sql`select "itemKey", state from job_run_item where "runId" = ${f.runs[1]}::uuid and stage = 'future'`.execute(
            db,
          )
        ).rows,
      ).toEqual([{ itemKey: '000-future', state: 'pending' }]);
      expect((await sql`select id from job where name = 'future'`.execute(db)).rows).toHaveLength(1);
      process.stdout.write(
        `${JSON.stringify({ retainedDescendants: SCALE_ITEMS, pages, maxCopied, maxPageMs, maxControlMs, firstRows, tailRows, emptyTailRows, firstSelectionRows, tailSelectionRows, emptyTailSelectionRows, copyMs: performance.now() - started, statementTimeoutMs: 5000, lockTimeoutMs: 3000, mediaExecutions: 0 })}\n`,
      );
    } finally {
      await controlDb.destroy();
    }
  });
});
