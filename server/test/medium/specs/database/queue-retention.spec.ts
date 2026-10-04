import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { pruneQueueHistory } from 'src/queue/retention.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { getKyselyDB } from 'test/utils.js';

describe('bounded PostgreSQL queue history', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  beforeEach(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    queue = `retention-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('prunes at most 250 jobs per sweep and retains every media item outcome after attempt payloads are gone', async () => {
    const runId = await store.createRun('retention-fixture', {});
    await sql`insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, state, "jobId")
      select ${runId}::uuid, n::text, n::text, 'thumbnail', ${queue}, '{"source":"private-path"}'::jsonb,
        'completed', gen_random_uuid() from generate_series(1,503) n`.execute(db);
    await sql`insert into job(id, queue, name, data, state, "safeToRetry", "deadlineMs", attempt,
      "runId", "itemKey", "rootItemKey", "finishedAt")
      select "jobId", queue, stage, selection, state, true, 600000, 1, "runId", "itemKey", "rootItemKey", now() - interval '40 days'
      from job_run_item where "runId" = ${runId}::uuid`.execute(db);
    await sql`insert into job_attempt("jobId", attempt, token, "workerId", outcome, "finishedAt")
      select id, 1, gen_random_uuid(), ${worker}::uuid, 'completed', now() - interval '40 days' from job where queue = ${queue}`.execute(
      db,
    );
    await store.finishEnumeration(runId);

    expect(await pruneQueueHistory(db)).toBe(250);
    expect(await pruneQueueHistory(db)).toBe(250);
    expect(await pruneQueueHistory(db)).toBe(3);
    expect(await pruneQueueHistory(db)).toBe(0);
    const {
      rows: [outcomes],
    } = await sql<{ total: number; completed: number; payloads: number; linked: number }>`select count(*)::int total,
      count(*) filter(where state = 'completed')::int completed,
      count(*) filter(where selection <> '{}'::jsonb)::int payloads,
      count(*) filter(where "jobId" is not null)::int linked from job_run_item where "runId" = ${runId}::uuid`.execute(
      db,
    );
    expect(outcomes).toEqual({ total: 503, completed: 503, payloads: 0, linked: 0 });
    expect((await sql<{ count: number }>`select count(*)::int count from job_attempt`.execute(db)).rows[0].count).toBe(
      0,
    );
  });

  it('retains unfinished runs, active work, needs-attention work and parents of surviving children', async () => {
    const runId = await store.createRun('unfinished', {});
    await store.enqueue(
      ['parent', 'active', 'attention', 'unfinished', 'fresh'].map((name) => ({
        queue,
        name,
        data: {},
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 600000,
        ...(name === 'unfinished' ? { runId, itemKey: name, rootItemKey: name } : {}),
      })),
    );
    await sql`update job set state = case when name = 'attention' then 'needs_attention' else 'completed' end,
      "finishedAt" = now() - interval '40 days' where queue = ${queue} and name <> 'active'`.execute(db);
    await sql`update job set "finishedAt" = now() where queue = ${queue} and name = 'fresh'`.execute(db);
    const [active] = await store.claim(queue, worker);
    expect(active.name).toBe('active');
    const {
      rows: [parent],
    } = await sql<{ id: string }>`select id from job where queue = ${queue} and name = 'parent'`.execute(db);
    await store.enqueue([
      { queue, name: 'child', data: {}, safeToRetry: true, sensitive: false, deadlineMs: 600000, parentId: parent.id },
    ]);

    expect(await pruneQueueHistory(db)).toBe(0);
    expect(
      (await sql<{ count: number }>`select count(*)::int count from job where queue = ${queue}`.execute(db)).rows[0]
        .count,
    ).toBe(6);
  });

  it('installs vacuum settings on the frequently updated queue tables', async () => {
    const { rows } = await sql<{ relname: string; reloptions: string[] }>`select relname, reloptions from pg_class
      where oid in ('public.job'::regclass, 'public.job_attempt'::regclass, 'public.job_worker'::regclass,
        'public.job_run_item'::regclass)`.execute(db);
    expect(rows).toHaveLength(4);
    for (const row of rows)
      expect(row.reloptions).toEqual(
        expect.arrayContaining([
          'autovacuum_vacuum_scale_factor=0.02',
          'autovacuum_analyze_scale_factor=0.05',
          'autovacuum_vacuum_threshold=50',
          'autovacuum_analyze_threshold=50',
        ]),
      );
  });
});
