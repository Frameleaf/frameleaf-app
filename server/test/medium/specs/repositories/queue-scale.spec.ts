import { CompiledQuery, Kysely, type QueryResult, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { listRunItems, listRuns } from 'src/queue/run-query.js';
import { unfinishedQueueItems } from 'src/queue/selection-state.js';
import { SqlQueueStore, settleRunQuery } from 'src/queue/store.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { SCALE_ITEMS } from 'test/medium/scale.js';
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

// Attribution only: EXPLAIN work is separate from the facade throughput receipt.
const mutationPlansEnabled = process.env.FRAMELEAF_QUEUE_PLANS === '1';
type MutationLabel = 'claim-page' | 'item-state-sync' | 'lineage-mirror';
type MutationProbe = {
  scenario: 'full-manifest' | 'tail' | 'late-copy';
  transition: 'claim' | 'complete';
  seen: Set<MutationLabel>;
};
const planNodeTypes = new Set([
  'ModifyTable',
  'Nested Loop',
  'Hash Join',
  'Merge Join',
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'BitmapAnd',
  'BitmapOr',
  'Hash',
  'Materialize',
  'Memoize',
  'Result',
  'Aggregate',
  'Limit',
  'Append',
  'CTE Scan',
  'Subquery Scan',
  'Sort',
  'Unique',
  'Gather',
  'Gather Merge',
]);

describe('large durable queue query work', () => {
  let db: Kysely<any>;
  let mutationProbe: MutationProbe | undefined;
  let retainedRoots = 0;
  const captured: CompiledQuery[] = [];
  beforeAll(async () => {
    const original = await getKyselyDB();
    const { rows } = await sql<{ name: string }>`select current_database() name`.execute(original);
    await original.destroy();
    const config = getKyselyConfig({
      connectionType: 'url',
      url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name),
    });
    let observedDialect = config.dialect;
    if (mutationPlansEnabled) {
      const dialect = config.dialect;
      const driver = dialect.createDriver();
      const acquire = driver.acquireConnection.bind(driver);
      driver.acquireConnection = async () => {
        const connection = await acquire();
        const execute = connection.executeQuery.bind(connection);
        connection.executeQuery = async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
          const probe = mutationProbe;
          const text = query.sql.trimStart();
          const label: MutationLabel | undefined = text.startsWith("update job set state = 'active', token =")
            ? 'claim-page'
            : text.startsWith('update job_run_item i set state = j.state from job j')
              ? 'item-state-sync'
              : text.startsWith('update job_run_item shadow') && text.includes('join job_selection_lineage origin')
                ? 'lineage-mirror'
                : undefined;
          if (!probe || !label || probe.seen.has(label)) return execute<R>(query);
          probe.seen.add(label); // At most three statements per claim, two per completion.
          let plan: { Plan: PlanNode; 'Planning Time': number; 'Execution Time': number };
          try {
            await execute(CompiledQuery.raw('SAVEPOINT queue_mutation_plan'));
            try {
              const result = await execute<{
                'QUERY PLAN': [typeof plan];
              }>(CompiledQuery.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, [...query.parameters]));
              plan = result.rows[0]['QUERY PLAN'][0];
            } finally {
              await execute(CompiledQuery.raw('ROLLBACK TO SAVEPOINT queue_mutation_plan'));
              await execute(CompiledQuery.raw('RELEASE SAVEPOINT queue_mutation_plan'));
            }
          } catch {
            // A PostgreSQL diagnostic can contain resolved values; preserve only a fixed failure label.
            throw new Error(`Queue mutation plan probe failed: ${label}`);
          }
          const result = await execute<R>(query);
          const allNodes = nodes(plan.Plan);
          console.info(
            'queue-mutation-plan',
            JSON.stringify({
              mode: 'actual-mutation-plans',
              retainedRoots,
              scenario: probe.scenario,
              transition: probe.transition,
              label,
              fingerprint: createHash('sha256')
                .update(query.sql.replaceAll(/'(?:''|[^'])*'/g, "'?'"))
                .digest('hex')
                .slice(0, 16),
              planningMs: plan['Planning Time'],
              executionMs: plan['Execution Time'],
              examined: examined(plan.Plan),
              buffers: plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks'],
              returnedRows: result.rows.length,
              nodeCount: allNodes.length,
              nodes: allNodes.slice(0, 64).map((node) => ({
                type: planNodeTypes.has(node['Node Type']) ? node['Node Type'] : 'Other',
                rows: node['Actual Rows'],
                loops: node['Actual Loops'],
                filtered: node['Rows Removed by Filter'] ?? 0,
                joinFiltered: node['Rows Removed by Join Filter'] ?? 0,
                hits: node['Shared Hit Blocks'] ?? 0,
                reads: node['Shared Read Blocks'] ?? 0,
              })),
            }),
          );
          // A useful mirror must still update after EXPLAIN; otherwise its mutation leaked past rollback.
          expect(result.rows.length).toBe(plan.Plan['Actual Rows']);
          return result;
        };
        return connection;
      };
      observedDialect = {
        createDriver: () => driver,
        createAdapter: () => dialect.createAdapter(),
        createIntrospector: (database) => dialect.createIntrospector(database),
        createQueryCompiler: () => dialect.createQueryCompiler(),
      };
    }
    db = new Kysely({
      ...config,
      dialect: observedDialect,
      log: (event) => {
        if (event.level === 'query') captured.push(event.query);
      },
    });
  });
  afterAll(async () => db?.destroy());

  const probeMutation = async <T>(
    scenario: MutationProbe['scenario'],
    transition: MutationProbe['transition'],
    work: () => Promise<T>,
  ) => {
    if (!mutationPlansEnabled) return work();
    const probe: MutationProbe = { scenario, transition, seen: new Set() };
    mutationProbe = probe;
    try {
      const result = await work();
      expect(probe.seen.size).toBe(transition === 'claim' ? 3 : 2);
      return result;
    } finally {
      mutationProbe = undefined;
    }
  };

  // A work budget is about the statement, not about how small the fixture is: on a ledger of a few
  // thousand rows PostgreSQL reads the whole table because that is cheapest, and the same statement
  // would then pass or fail with the table size instead of with its own shape. The budgets are
  // therefore measured with sequential and bitmap scans priced out, which leaves the planner the
  // ordered index paths the statement can actually use. A statement that has no bounded index path
  // still reads the table (PostgreSQL only penalises those scans) and still fails its budget.
  const explain = (query: CompiledQuery, wholeTableScans = false) =>
    db.transaction().execute(async (tx) => {
      if (!wholeTableScans) {
        await sql`set local enable_seqscan = off`.execute(tx);
        await sql`set local enable_bitmapscan = off`.execute(tx);
      }
      const result = await tx.executeQuery<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        CompiledQuery.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, [...query.parameters]),
      );
      return result.rows[0]['QUERY PLAN'][0].Plan;
    });

  it.each([(SCALE_ITEMS * 2) / 5, SCALE_ITEMS])(
    'bounds actual tail work with %i retained roots and four stages',
    async (size) => {
      retainedRoots = size;
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
      if (mutationPlansEnabled) {
        // One retained descendant origin per root; these are seeded history, not executed handlers.
        await sql`update job_selection set "capturedAt"=now() where id=${selectionId}::uuid`.execute(db);
        await sql`insert into job_selection_lineage("selectionId","runId","itemKey",stage)
          select ${selectionId}::uuid,"runId","itemKey",stage from job_run_item
          where "runId"=${runId}::uuid and stage='stage-1'`.execute(db);
        await sql`analyze job_selection_lineage`.execute(db);
      }
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
      if (mutationPlansEnabled) {
        // One actual root while the rest are still cold exposes plans hidden by an empty tail.
        const cold = await probeMutation('full-manifest', 'claim', () => store.claim(queue, worker, 1));
        expect(cold.length).toBe(1);
        expect(await probeMutation('full-manifest', 'complete', () => store.complete(cold[0], []))).toBe(true);
      }
      // Seed the retained terminal state; this deliberately does not simulate media execution.
      await sql`update job set state='completed', "finishedAt"=now() where queue=${queue} and state in ('pending','waiting')`.execute(
        db,
      );
      await sql`update job_run_item set state='completed' where "runId"=${runId}::uuid
        and stage='stage-0' and "itemKey" <= ${String(size - 250).padStart(8, '0')}`.execute(db);
      await sql`vacuum analyze job`.execute(db);
      await sql`vacuum analyze job_run_item`.execute(db);
      captured.length = 0;

      expect(await store.feedManifest(queue)).toBe(250);
      const claims = await probeMutation('tail', 'claim', () => store.claim(queue, worker));
      expect(claims).toHaveLength(10);
      for (const [index, claim] of claims.entries()) {
        expect(
          await (index === 0
            ? probeMutation('tail', 'complete', () => store.complete(claim, []))
            : store.complete(claim, [])),
        ).toBe(true);
      }
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
        // Plan-only output excludes even the legacy redacted expressions; all work gates still run.
        if (!mutationPlansEnabled) {
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
        }
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
      // A busy run can outpace ANALYZE while its ready buffer stays bounded. Seed retained
      // outcomes rather than executing media, and retain the pre-completion ledger statistics.
      await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"jobId",state)
        select ${runId}::uuid,lpad(n::text,8,'0'),lpad(n::text,8,'0'),'growth',${queue},'{}',
          md5(${runId} || ':growth:' || n::text)::uuid,'pending' from generate_series(1,10000) n`.execute(db);
      await sql`insert into job(id,queue,name,data,"safeToRetry",sensitive,"deadlineMs",state,"runId","itemKey","rootItemKey")
        select md5(${runId} || ':growth:' || n::text)::uuid,${queue},'growth','{}',true,false,60000,
          case when n<=1000 then 'pending' else 'completed' end,${runId}::uuid,lpad(n::text,8,'0'),lpad(n::text,8,'0')
        from generate_series(1,10000) n`.execute(db);
      await sql`analyze job_run_item`.execute(db);
      await sql`update job_run_item set state='completed' where "runId"=${runId}::uuid
        and stage='growth' and "itemKey">lpad('1000',8,'0')`.execute(db);
      const beforeGrowth = captured.length;
      await store.finishEnumeration(runId);
      const growthProof = captured
        .slice(beforeGrowth)
        .find((query) => query.sql.includes('select candidate.id from unnest'));
      expect(growthProof).toBeDefined();
      const growthPlan = await explain(growthProof!);
      expect(examined(growthPlan), `live proof examined rows with stale statistics at ${size}`).toBeLessThanOrEqual(
        100,
      );
      expect(
        growthPlan['Shared Hit Blocks'] + growthPlan['Shared Read Blocks'],
        `live proof buffers at ${size}`,
      ).toBeLessThanOrEqual(100);
      expect(
        (await sql<{ finishedAt: Date | null }>`select "finishedAt" from job_run where id=${runId}::uuid`.execute(db))
          .rows[0].finishedAt,
      ).toBeNull();
      if (mutationPlansEnabled) {
        // A copied deferred descendant can precede its owner's execution assignment. Seed that
        // valid retained state, plus a deliberately detached cancelled copy, beside the same history.
        const probeQueue = `plan-${randomUUID()}`;
        const [owner, shared, cancelled] = [randomUUID(), randomUUID(), randomUUID()];
        const source = randomUUID();
        await store.initialize([probeQueue]);
        await sql`insert into job_run(id,kind,selection,"enumerationDone")
          select id,'plan-lineage','{}',true from unnest(${[owner, shared, cancelled]}::uuid[]) id`.execute(db);
        await sql`insert into job_selection(id,"runId",stage,queue,"safeToRetry",sensitive,"deadlineMs",state,"capturedAt")
          values (${source}::uuid,${owner}::uuid,'root',${probeQueue},true,false,60000,'ready',now())`.execute(db);
        await sql`insert into job_selection_run("runId","selectionId","copyComplete")
          select id,${source}::uuid,true from unnest(${[owner, shared, cancelled]}::uuid[]) id`.execute(db);
        await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId",state)
          select id,'root','root','root',${probeQueue},'{}',${source}::uuid,
            case when id=${cancelled}::uuid then 'cancelled' else 'completed' end
          from unnest(${[owner, shared, cancelled]}::uuid[]) id`.execute(db);
        await store.enqueue([
          {
            queue: probeQueue,
            name: 'child',
            data: {},
            runId: owner,
            itemKey: 'child',
            rootItemKey: 'root',
            safeToRetry: true,
            sensitive: false,
            deadlineMs: 60_000,
          },
        ]);
        await sql`insert into job_selection_lineage("selectionId","runId","itemKey",stage)
          values (${source}::uuid,${owner}::uuid,'child','child')`.execute(db);
        await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,state)
          select id,'child','root','child',${probeQueue},'{}',case when id=${cancelled}::uuid then 'cancelled' else 'pending' end
          from unnest(${[shared, cancelled]}::uuid[]) id`.execute(db);
        const copied = await probeMutation('late-copy', 'claim', () => store.claim(probeQueue, worker));
        expect(copied.length).toBe(1);
        expect(
          (
            await sql`select count(*) filter(where state='active')::int active,
            count(*) filter(where state='cancelled' and "jobId" is null)::int detached
            from job_run_item where "runId"=any(${[owner, shared, cancelled]}::uuid[]) and stage='child'`.execute(db)
          ).rows,
        ).toEqual([{ active: 2, detached: 1 }]);
        expect(await probeMutation('late-copy', 'complete', () => store.complete(copied[0], []))).toBe(true);
        expect(
          (
            await sql`select count(*) filter(where state='completed')::int completed,
            count(*) filter(where state='cancelled' and "jobId" is null)::int detached
            from job_run_item where "runId"=any(${[owner, shared, cancelled]}::uuid[]) and stage='child'`.execute(db)
          ).rows,
        ).toEqual([{ completed: 2, detached: 1 }]);
      }
    },
    180_000,
  );
});
