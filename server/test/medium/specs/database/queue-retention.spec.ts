import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { pruneQueueHistory } from 'src/queue/retention.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { SCALE_ITEMS } from 'test/medium/scale.js';
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
        deadlineMs: 600_000,
        ...(name === 'unfinished' && { runId, itemKey: name, rootItemKey: name }),
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
      { queue, name: 'child', data: {}, safeToRetry: true, sensitive: false, deadlineMs: 600_000, parentId: parent.id },
    ]);

    expect(await pruneQueueHistory(db)).toBe(0);
    expect(
      (await sql<{ count: number }>`select count(*)::int count from job where queue = ${queue}`.execute(db)).rows[0]
        .count,
    ).toBe(6);
  });

  it('advances past an ineligible prefix with microsecond timestamps and revisits it after children disappear', async () => {
    await sql`insert into job(id,queue,name,data,state,"safeToRetry","deadlineMs","finishedAt")
      select md5('parent:' || n)::uuid,${queue},'parent','{}','completed',true,600000,
        '2026-01-01 00:00:00.123456+00'::timestamptz from generate_series(1,750) n`.execute(db);
    await sql`insert into job(id,queue,name,data,state,"safeToRetry","deadlineMs","parentId")
      select md5('child:' || n)::uuid,${queue},'child','{}','pending',true,600000,
        md5('parent:' || n)::uuid from generate_series(1,750) n`.execute(db);
    await sql`insert into job(id,queue,name,data,state,"safeToRetry","deadlineMs","finishedAt")
      select md5('tail:' || n)::uuid,${queue},'tail','{}','completed',true,600000,
        '2026-01-02 00:00:00.123456+00'::timestamptz from generate_series(1,10) n`.execute(db);

    const positions = new Set<string>();
    for (let page = 0; page < 3; page++) {
      expect(await pruneQueueHistory(db)).toBe(0);
      const { rows } = await sql<{ id: string; precise: boolean }>`select value->>'id' as id,
        (value->>'finishedAt')::timestamptz='2026-01-01 00:00:00.123456+00'::timestamptz as precise
        from system_metadata where key='frameleaf-queue-retention-cursor'`.execute(db);
      expect(rows[0].precise).toBe(true);
      positions.add(rows[0].id);
    }
    expect(positions.size).toBe(3);
    expect(await pruneQueueHistory(db)).toBe(10);
    await sql`delete from job where queue=${queue} and name='child'`.execute(db);
    for (let page = 0; page < 3; page++) expect(await pruneQueueHistory(db)).toBe(250);
    expect(await pruneQueueHistory(db)).toBe(0);
    expect((await sql`select id from job where queue=${queue}`.execute(db)).rows).toEqual([]);
  });

  it('rolls the candidate cursor back when deletion fails and retries that same page', async () => {
    await store.enqueue([
      { queue, name: 'rollback', data: {}, safeToRetry: true, sensitive: false, deadlineMs: 600_000 },
    ]);
    await sql`update job set state='completed',"finishedAt"=now()-interval '40 days' where queue=${queue}`.execute(db);
    await sql`create function retention_failure() returns trigger language plpgsql as $$
      begin raise exception 'retention deletion failure'; end $$`.execute(db);
    await sql`create trigger retention_failure before delete on job for each row execute function retention_failure()`.execute(
      db,
    );
    await expect(pruneQueueHistory(db)).rejects.toThrow('retention deletion failure');
    expect(
      (await sql`select key from system_metadata where key='frameleaf-queue-retention-cursor'`.execute(db)).rows,
    ).toEqual([]);
    expect((await sql`select id from job where queue=${queue}`.execute(db)).rows).toHaveLength(1);
    await sql`drop trigger retention_failure on job`.execute(db);
    await sql`drop function retention_failure()`.execute(db);
    expect(await pruneQueueHistory(db)).toBe(1);
  });

  it('finishes a fixed traversal while new completed work arrives and revisits earlier blocked parents', async () => {
    await sql`insert into job(id,queue,name,data,state,"safeToRetry","deadlineMs","finishedAt")
      select md5('parent:' || n)::uuid,${queue},'parent','{}','completed',true,600000,
        '2026-01-01'::timestamptz from generate_series(1,250) n`.execute(db);
    await sql`insert into job(id,queue,name,data,state,"safeToRetry","deadlineMs","parentId")
      select md5('child:' || n)::uuid,${queue},'child','{}','pending',true,600000,
        md5('parent:' || n)::uuid from generate_series(1,250) n`.execute(db);
    const arrive = async (page: number) => {
      await sql`insert into job(id,queue,name,data,state,"safeToRetry","deadlineMs","finishedAt")
        select md5(${page}::text || ':' || n)::uuid,${queue},'arrival','{}','completed',true,600000,
          '2026-01-02'::timestamptz + ${page} * interval '1 day' from generate_series(1,250) n`.execute(db);
    };
    await arrive(0);
    expect(await pruneQueueHistory(db)).toBe(0);
    await arrive(1);
    expect(await pruneQueueHistory(db)).toBe(250);
    await sql`delete from job where queue=${queue} and name='child'`.execute(db);
    await arrive(2);
    expect(await pruneQueueHistory(db)).toBe(0);
    expect(await pruneQueueHistory(db)).toBe(250);
    expect((await sql`select id from job where queue=${queue} and name='parent'`.execute(db)).rows).toEqual([]);
    expect((await sql`select id from job where queue=${queue}`.execute(db)).rows).toHaveLength(500);
  });

  it.each([SCALE_ITEMS / 10, SCALE_ITEMS])(
    'bounds candidate work with %i ineligible retained parents',
    async (size) => {
      // Seed retained history, not executed media. Only two actual cleanup visits run here.
      await sql`insert into job(id,queue,name,data,state,"safeToRetry","deadlineMs","finishedAt")
        select md5('parent:' || n)::uuid,${queue},'parent','{}','completed',true,600000,
          '2026-01-01 00:00:00.123456+00'::timestamptz from generate_series(1,${size}) n`.execute(db);
      await sql`insert into job(id,queue,name,data,state,"safeToRetry","deadlineMs","parentId")
        select md5('child:' || n)::uuid,${queue},'child','{}','pending',true,600000,
          md5('parent:' || n)::uuid from generate_series(1,${size}) n`.execute(db);
      await sql`analyze job`.execute(db);
      const { rows: databases } = await sql<{ name: string }>`select current_database() name`.execute(db);
      const queries: CompiledQuery[] = [];
      const observed = new Kysely({
        ...getKyselyConfig({
          connectionType: 'url',
          url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, databases[0].name),
        }),
        log: (event) => {
          if (event.level === 'query') queries.push(event.query);
        },
      });
      type Plan = {
        'Relation Name'?: string;
        'Actual Rows': number;
        'Actual Loops': number;
        'Rows Removed by Filter'?: number;
        Plans?: Plan[];
      };
      const examined = (node: Plan): number =>
        (node['Relation Name']
          ? (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops']
          : 0) + (node.Plans ?? []).reduce((sum, child) => sum + examined(child), 0);
      const explain = async (query: CompiledQuery) => {
        const { rows } = await db.executeQuery<{ 'QUERY PLAN': [{ Plan: Plan }] }>(
          CompiledQuery.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, [...query.parameters]),
        );
        return examined(rows[0]['QUERY PLAN'][0].Plan);
      };
      try {
        await db.transaction().execute(async (locker) => {
          // SKIP LOCKED must not turn the page limit into a scan of every locked parent.
          await sql`select count(*) from (select id from job where queue=${queue} and name='parent' for update) locked`.execute(
            locker,
          );
          expect(await pruneQueueHistory(observed)).toBe(0);
          expect(await pruneQueueHistory(observed)).toBe(0);
          const firstPage = queries.find(({ sql }) => sql.includes('select id, "finishedAt"::text from job'))!;
          expect(await explain(firstPage)).toBeLessThanOrEqual(250);
          const locks = queries.filter(
            ({ sql }) => sql.includes('select id from job') && sql.includes('for update skip locked'),
          );
          expect(locks).toHaveLength(2);
          for (const lock of locks) expect(await explain(lock)).toBeLessThanOrEqual(250);
        });
        const pages = queries.filter(({ sql }) => sql.includes('select id, "finishedAt"::text from job'));
        expect(pages).toHaveLength(2);
        for (const page of pages) expect(await explain(page)).toBeLessThanOrEqual(250);
        // The prior eligibility-first selector must exceed the same physical-work budget.
        const unbounded = sql`select j.id from job j
          where j.state in ('completed','failed','cancelled','blocked') and j."latestPending" is null
            and j."finishedAt" < now()-interval '30 days'
            and not exists(select 1 from job child where child."parentId"=j.id)
          order by j."finishedAt",j.id limit 250`.compile(db);
        expect(await explain(unbounded)).toBeGreaterThanOrEqual(size);
        const { rows } = await sql<{ count: number }>`select count(*)::int count from job where queue=${queue}`.execute(
          db,
        );
        expect(rows[0].count).toBe(size * 2);
      } finally {
        await observed.destroy();
      }
    },
    120_000,
  );

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
