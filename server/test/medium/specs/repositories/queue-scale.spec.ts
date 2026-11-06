import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { SqlQueueStore } from 'src/queue/store.js';
import { SCALE_ITEMS, scaleIt } from 'test/medium/scale.js';
import { getKyselyDB } from 'test/utils.js';

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
};
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap((child) => nodes(child))];
/** Rows the plan read from tables and indexes, filtered ones included. */
const examined = (plan: PlanNode) =>
  nodes(plan)
    .filter((node) => node['Relation Name'])
    .reduce(
      (sum, node) => sum + (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'],
      0,
    );

/** FL-1265: a queue with a large backlog and as large a held import reads only a claim page. */
describe('large queue claim work', () => {
  let db: Kysely<any>;
  const captured: CompiledQuery[] = [];

  beforeAll(async () => {
    db = await getKyselyDB(undefined, (event) => {
      if (event.level === 'query') captured.push(event.query);
    });
  });
  afterAll(async () => {
    await db.destroy();
  });

  /** EXPLAIN ANALYZE of a captured statement, rolled back so it changes nothing. */
  const explain = async (query: CompiledQuery): Promise<PlanNode> => {
    let plan: PlanNode | undefined;
    await db
      .transaction()
      .execute(async (tx) => {
        const { rows } = await tx.executeQuery<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
          CompiledQuery.raw(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, [...query.parameters]),
        );
        plan = rows[0]['QUERY PLAN'][0].Plan;
        throw new Error('rollback');
      })
      .catch((error: Error) => {
        if (error.message !== 'rollback') throw error;
      });
    return plan!;
  };

  scaleIt('claims a page from %i waiting and %i held jobs without reading the rest', 2, async () => {
    const store = new SqlQueueStore(db);
    const queue = `scale-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([queue], worker);
    await store.setConcurrency(queue, 250);
    const [ready, held] = [randomUUID(), randomUUID()];
    await sql`insert into job_run(id, kind, selection, "enumerationDone") values
      (${ready}::uuid, 'scale-ready', '{}', true),
      (${held}::uuid, 'immich-import-derived', '{"holds":{"held":"setup"}}', true)`.execute(db);
    // Seeded rows, not executed media: the claim, held filter and page read are production SQL.
    await sql`insert into job(id, queue, name, data, "safeToRetry", "deadlineMs", "availableAt", "createdAt", "runId", "itemKey", "rootItemKey")
      select gen_random_uuid(), ${queue}, case when held then 'held' else 'ready' end, '{}', true, 60000,
        case when held then 'infinity'::timestamptz else now() - interval '1 hour' end,
        now() - interval '2 hours' + n * interval '1 millisecond',
        case when held then ${held}::uuid else ${ready}::uuid end, n::text, n::text
      from generate_series(1, ${SCALE_ITEMS}) n cross join (values (true), (false)) h(held)`.execute(db);
    await sql`analyze job`.execute(db);

    captured.length = 0;
    const claims = await store.claim(queue, worker);
    expect(claims).toHaveLength(250);
    expect(claims.every(({ name }) => name === 'ready')).toBe(true);
    const page = captured.find((query) => query.sql.includes(`"availableAt" <= now()`))!;
    expect(page).toBeDefined();
    expect(examined(await explain(page)), `claim rows read beside ${2 * SCALE_ITEMS} jobs`).toBeLessThanOrEqual(2000);

    // Only held work left: waiting for the queue ignores it without walking it.
    await sql`update job set state = 'completed', token = null, "finishedAt" = now()
      where queue = ${queue} and name = 'ready'`.execute(db);
    await sql`vacuum analyze job`.execute(db);
    captured.length = 0;
    expect(await store.hasUnfinishedWork(queue, false)).toBe(false);
    expect(examined(await explain(captured[0])), 'held work skipped by the unfinished-work probe').toBeLessThanOrEqual(
      100,
    );
    expect(await store.hasUnfinishedWork(queue)).toBe(true);
    expect(await store.claim(queue, worker)).toEqual([]);
  });
});
