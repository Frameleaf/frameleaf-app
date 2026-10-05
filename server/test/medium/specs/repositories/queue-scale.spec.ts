import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { listRunItems, listRuns } from 'src/queue/run-query.js';
import { unfinishedQueueItems } from 'src/queue/selection-state.js';
import { SqlQueueStore, settleRunQuery } from 'src/queue/store.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Alias?: string;
  'Parent Relationship'?: string;
  'Index Cond'?: string;
  Filter?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Join Filter'?: number;
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
  Plans?: PlanNode[];
};
// Plan expressions include resolved bind literals; never print selected IDs or payload constants.
const redactPlanExpression = (value?: string) => value?.replaceAll(/'(?:''|[^'])*'/g, "'?'");
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap((child) => nodes(child))];
const examined = (plan: PlanNode) =>
  nodes(plan)
    .filter((node) => node['Relation Name'] || node['Node Type'] === 'CTE Scan')
    .reduce(
      (sum, node) =>
        sum +
        (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Join Filter'] ?? 0)) *
          node['Actual Loops'],
      0,
    );

describe('large durable queue query work', () => {
  let db: Kysely<any>;
  const captured: CompiledQuery[] = [];
  beforeAll(async () => {
    const original = await getKyselyDB();
    const { rows } = await sql<{ name: string }>`select current_database() name`.execute(original);
    await original.destroy();
    db = new Kysely({
      ...getKyselyConfig({
        connectionType: 'url',
        url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name),
      }),
      log: (event) => {
        if (event.level === 'query') captured.push(event.query);
      },
    });
  });
  afterAll(async () => db?.destroy());

  const explain = async (query: CompiledQuery) => {
    const result = await db.executeQuery<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
      CompiledQuery.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, [...query.parameters]),
    );
    return result.rows[0]['QUERY PLAN'][0].Plan;
  };

  it.each([50_000, 500_000])(
    'bounds actual tail work with %i retained roots and four stages',
    async (size) => {
      // These are seeded retained outcomes, not a claim that synthetic media was executed.
      // Only the tail claims below use production admission, fencing and completion.
      await sql`truncate job_attempt, job, job_run_item, job_selection, job_run, job_worker, job_queue cascade`.execute(
        db,
      );
      const store = new SqlQueueStore(db);
      const queue = `scale-${randomUUID()}`;
      const worker = randomUUID();
      const runId = randomUUID();
      const selectionId = randomUUID();
      await store.initialize([queue], worker);
      await store.setConcurrency(queue, 10);
      await sql`insert into job_run(id,kind,selection,"enumerationDone")
      values (${runId}::uuid,'scale','{}',true)`.execute(db);
      await sql`insert into job_selection(id,"runId",stage,queue,"safeToRetry",sensitive,"deadlineMs",state)
      values (${selectionId}::uuid,${runId}::uuid,'stage-0',${queue},true,false,60000,'ready')`.execute(db);
      await sql`insert into job_selection_run("runId","selectionId","copyComplete")
        values (${runId}::uuid,${selectionId}::uuid,true)`.execute(db);
      await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId","jobId",state)
        select ${runId}::uuid,lpad(n::text,8,'0'),lpad(n::text,8,'0'),'stage-' || s,${queue},
          jsonb_build_object('id',lpad(n::text,8,'0')),case when s=0 then ${selectionId}::uuid end,
          case when s=1 then md5(${runId} || ':' || n::text)::uuid end,
          case when s=0 then 'pending' else 'completed' end
        from generate_series(1,${size}) n cross join generate_series(0,3) s`.execute(db);
      await sql`insert into job(id,queue,name,data,"safeToRetry",sensitive,"deadlineMs",state,"finishedAt","runId","itemKey","rootItemKey")
        select md5(${runId} || ':' || n::text)::uuid,${queue},'stage-1','{}',true,false,60000,'completed',now(),
          ${runId}::uuid,lpad(n::text,8,'0'),lpad(n::text,8,'0')
        from generate_series(1,${size}) n`.execute(db);
      for (const table of ['job', 'job_run_item', 'job_selection', 'job_run']) {
        await sql`analyze ${sql.id(table)}`.execute(db);
      }
      captured.length = 0;

      // Exercise the full pending manifest as well as its almost-finished tail. Only a page may
      // be read/sorted, even when every selected root still needs its first stage admitted.
      expect(await store.feedManifest(queue)).toBe(250);
      const initialPage = captured.find((query) => query.sql.includes('select i.*, s."safeToRetry"'))!;
      expect(initialPage).toBeDefined();
      expect(
        examined(await explain(initialPage)),
        `initial admission examined rows at ${size} roots`,
      ).toBeLessThanOrEqual(1000);
      // Seed the retained terminal state; this deliberately does not simulate media execution.
      await sql`update job set state='completed', "finishedAt"=now() where queue=${queue} and state='pending'`.execute(
        db,
      );
      await sql`update job_run_item set state='completed' where "runId"=${runId}::uuid
        and stage='stage-0' and "itemKey" <= ${String(size - 250).padStart(8, '0')}`.execute(db);
      await sql`vacuum analyze job_run_item`.execute(db);
      captured.length = 0;

      expect(await store.feedManifest(queue)).toBe(250);
      const claims = await store.claim(queue, worker);
      expect(claims).toHaveLength(10);
      for (const claim of claims) expect(await store.complete(claim, [])).toBe(true);
      const page = await listRunItems(db, runId, 5, 0);
      expect(page).toHaveLength(5);
      expect(page?.every((item) => item.outcome === 'completed' && item.stageTotals.total === 4)).toBe(true);

      // A terminal change in a different queue must not walk retained history or other parents.
      const failureQueue = `failure-${queue}`;
      await store.initialize([failureQueue]);
      await store.enqueue([
        { queue: failureQueue, name: 'unsafe', data: {}, safeToRetry: false, sensitive: false, deadlineMs: 60_000 },
      ]);
      const [failed] = await store.claim(failureQueue, worker);
      await store.enqueue([
        {
          queue: failureQueue,
          name: 'dependent',
          data: {},
          parentId: failed.id,
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 60_000,
        },
      ]);
      await sql`analyze job`.execute(db);
      expect(await store.fail(failed, 'known failure')).toBe(true);
      expect((await sql`select state from job where "parentId"=${failed.id}::uuid`.execute(db)).rows).toEqual([
        { state: 'blocked' },
      ]);
      const beforeUnfinished = captured.length;
      expect(await store.hasUnfinishedWork(queue)).toBe(true);
      // Capture this public operation directly rather than depending on its predicate's SQL spelling.
      expect(captured).toHaveLength(beforeUnfinished + 1);
      const unfinished = captured[beforeUnfinished];
      const expectedUnfinished = sql`select ${unfinishedQueueItems(queue)} unfinished`.compile(db);
      expect(unfinished).toMatchObject({ sql: expectedUnfinished.sql, parameters: expectedUnfinished.parameters });

      const queries = [...captured];
      const capacity = queries.find((query) => query.sql.includes("count(*) filter (where state = 'active')"))!;
      const preflight = queries.find((query) => query.sql.includes('select candidate.id from unnest'))!;
      // Measure the actual full production statement even when the sufficient live-work proof
      // avoids it during these tail publications. Do not replace its former failing budget.
      const settle = settleRunQuery([runId]).compile(db);
      const mirror = queries.find((query) => query.sql.includes('update job_run_item i set "jobId" = source.'))!;
      const inspection = queries.find((query) => query.sql.includes('selected."rootItemKey") id'))!;
      const dependency = queries.find((query) => query.sql.includes('with recursive blocked as'))!;
      for (const [name, query, budget, bufferBudget] of [
        ['capacity', capacity, 2000, 500],
        ['settlement preflight', preflight, 100, 100],
        ['settlement', settle, 100, 100],
        ['membership mirror', mirror, 3000, 25_000],
        ['root inspection', inspection, 1000, 1000],
        ['failure closure', dependency, 100, 100],
        ['queue completion', unfinished, 100, 100],
      ] as const) {
        expect(query, `${name} must exercise a production query`).toBeDefined();
        const plan = await explain(query);
        console.info(
          JSON.stringify({
            size,
            name,
            examined: examined(plan),
            buffers: plan['Shared Hit Blocks'] + plan['Shared Read Blocks'],
            indexes: nodes(plan).flatMap((node) => (node['Index Name'] ? [node['Index Name']] : [])),
            // Attribute a failed work bound without dumping the entire plan or any item identities.
            scans: nodes(plan)
              .filter((node) => node['Relation Name'] || node['Node Type'] === 'CTE Scan')
              .map((node) => ({
                relation: node['Relation Name'] ?? node['Node Type'],
                index: node['Index Name'],
                alias: node.Alias,
                relationship: node['Parent Relationship'],
                indexCondition: redactPlanExpression(node['Index Cond']),
                filter: redactPlanExpression(node.Filter),
                rows: node['Actual Rows'],
                filtered: node['Rows Removed by Filter'] ?? 0,
                joinFiltered: node['Rows Removed by Join Filter'] ?? 0,
                loops: node['Actual Loops'],
              })),
          }),
        );
        expect(examined(plan), `${name} examined rows at ${size} retained roots`).toBeLessThanOrEqual(budget);
        expect(
          plan['Shared Hit Blocks'] + plan['Shared Read Blocks'],
          `${name} buffers at ${size} retained roots`,
        ).toBeLessThanOrEqual(bufferBudget);
      }
      // A full-history capacity query must fail the same structural budget even on a fast/cached DB.
      const unbounded = sql`select count(*) filter(where state='active') from job where queue=${queue}`.compile(db);
      expect(examined(await explain(unbounded))).toBeGreaterThanOrEqual(size);
      const { rows: remaining } = await sql<{ count: number }>`select count(*)::int count from job_run_item
      where "runId"=${runId}::uuid and state in ('pending','waiting','active')`.execute(db);
      expect(remaining[0].count).toBe(240);
      expect(
        (await sql`select id from job_run where id=${runId}::uuid and "finishedAt" is not null`.execute(db)).rows,
      ).toEqual([]);
      // Calibrate the intentionally exact aggregate separately from bounded execution queries.
      // This fixture does not claim a full UI latency or process-memory acceptance result.
      const summaryStarted = performance.now();
      const summaries = await listRuns(db, 10, 0);
      process.stdout.write(
        `${JSON.stringify({ size, phase: 'exact-run-summary', durationMs: performance.now() - summaryStarted })}\n`,
      );
      expect(summaries.find(({ id }) => id === runId)).toMatchObject({
        total: size,
        completed: size - 240,
        waiting: 240,
        stageTotals: { total: size * 4, completed: size * 4 - 240, waiting: 240 },
      });
    },
    180_000,
  );
});
