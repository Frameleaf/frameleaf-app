import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { listRunItems, listRuns, observeQueueRun, RUN_OUTCOMES } from 'src/queue/run-query.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<any>;
beforeAll(async () => {
  db = (await getKyselyDB()) as unknown as Kysely<any>;
});
afterAll(async () => {
  await db?.destroy();
});
beforeEach(async () => {
  await sql`truncate job_attempt, job, job_run_item, job_run, job_worker, job_queue cascade`.execute(db);
  await sql`insert into job_queue(name) values ('test'), ('paused')`.execute(db);
  await sql`update job_queue set paused = true where name = 'paused'`.execute(db);
  await sql`insert into job_worker(id) values (${randomUUID()}::uuid)`.execute(db);
});
const run = async (enumerationDone = true) => {
  const id = randomUUID();
  await sql`insert into job_run(id, kind, selection, "enumerationDone", "createdAt")
    values (${id}::uuid, 'test', '{"mediaNames":["private-name"]}', ${enumerationDone}, now() - interval '5 minutes')`.execute(
    db,
  );
  return id;
};
const stage = async (runId: string, root: string | null, name: string, state: string, queue = 'test') => {
  const key = randomUUID();
  await sql`insert into job_run_item("runId", "rootItemKey", "itemKey", stage, queue, state, selection)
    values (${runId}::uuid, ${root}, ${key}, ${name}, ${queue}, ${state}, '{"id":"private-asset-id"}')`.execute(db);
  return key;
};
const job = async (
  runId: string,
  itemKey: string,
  name: string,
  options: { state?: string; delay?: boolean; retry?: boolean; dependency?: boolean; parentId?: string } = {},
) => {
  const id = randomUUID();
  const state = options.state ?? 'pending';
  const token = state === 'active' ? randomUUID() : null;
  await sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey", state, token,
    "availableAt", attempt, "dependencyReason", "parentId", "createdAt")
    values (${id}::uuid, 'test', ${name}, '{"filename":"private-name"}', true, false, 1000, ${runId}::uuid, ${itemKey}, ${state}, ${token}::uuid,
    now() + ${options.delay ? 60 : -1} * interval '1 minute', ${options.retry ? 1 : 0},
    ${options.dependency ? 'destination-unavailable' : null}, ${options.parentId ?? null}::uuid, now() - interval '5 minutes')`.execute(
    db,
  );
  await sql`update job_run_item set "jobId" = ${id}::uuid where "runId" = ${runId}::uuid and "itemKey" = ${itemKey} and stage = ${name}`.execute(
    db,
  );
  return id;
};

it('counts 15,000 selected roots once despite multiple face subjects, stages and a coordinator', async () => {
  const id = await run();
  await sql`insert into job_run_item("runId", "rootItemKey", "itemKey", stage, queue, state, selection)
    select ${id}::uuid, 'asset-' || a, 'face-' || a || '-' || f, 'FaceRecognition', 'test', 'completed', '{}'
    from generate_series(1,15000) a cross join generate_series(1,4) f`.execute(db);
  await sql`insert into job_run_item("runId", "rootItemKey", "itemKey", stage, queue, state, selection)
    select ${id}::uuid, 'asset-' || a, 'asset-' || a, 'Thumbnail', 'test', 'completed', '{}'
    from generate_series(1,15000) a`.execute(db);
  await stage(id, null, 'Coordinator', 'completed');
  const [summary] = await listRuns(db, 25, 0);
  expect(summary).toMatchObject({ total: 15000, completed: 15000, failed: 0, state: 'completed' });
  expect(summary.stageTotals).toMatchObject({ total: 75001, completed: 75001 });
  expect(RUN_OUTCOMES.reduce((sum, outcome) => sum + summary[outcome], 0)).toBe(summary.total);
  const first = await listRunItems(db, id, 25, 0);
  const next = await listRunItems(db, id, 25, 25);
  expect(first).toHaveLength(25);
  expect(new Set([...first!, ...next!].map((item) => item.id)).size).toBe(50);
  expect(first![0].stageTotals.total).toBe(5);
  expect(JSON.stringify([summary, first])).not.toMatch(
    /asset-|face-|private-name|private-asset-id|selection|rootItemKey|itemKey/,
  );
}, 30_000);

it('keeps mixed failures nonterminal and mutually exclusive until every stage settles', async () => {
  const id = await run();
  await stage(id, 'same-asset', 'Thumbnail', 'failed');
  const key = await stage(id, 'same-asset', 'FaceRecognition', 'active');
  await job(id, key, 'FaceRecognition', { state: 'active' });
  await stage(id, 'failed-asset', 'Thumbnail', 'failed');
  await stage(id, 'attention-asset', 'Thumbnail', 'needs_attention');
  await stage(id, 'cancelled-asset', 'Thumbnail', 'cancelled');
  await stage(id, 'completed-asset', 'Thumbnail', 'completed');
  const [summary] = await listRuns(db, 25, 0);
  expect(summary).toMatchObject({
    total: 5,
    active: 1,
    failed: 1,
    needsAttention: 1,
    cancelled: 1,
    completed: 1,
    state: 'running',
    finishedAt: null,
  });
  expect(summary.stageTotals.failed).toBe(2);
  expect(RUN_OUTCOMES.reduce((sum, outcome) => sum + summary[outcome], 0)).toBe(5);
  await sql`update job set state = 'completed', token = null, "finishedAt" = now() where name = 'FaceRecognition'`.execute(
    db,
  );
  await sql`update job_run_item set state = 'completed' where stage = 'FaceRecognition'`.execute(db);
  expect((await listRuns(db, 25, 0))[0]).toMatchObject({ active: 0, failed: 2, state: 'completed_with_errors' });
});

it('keeps pending work distinct from delayed retries, pauses and dependency waits', async () => {
  const id = await run();
  await stage(id, 'paused', 'Pause', 'pending', 'paused');
  await stage(id, 'waiting', 'Wait', 'pending');
  const delayed = await stage(id, 'delayed', 'Delay', 'pending');
  await job(id, delayed, 'Delay', { delay: true });
  const retry = await stage(id, 'retry', 'Retry', 'waiting');
  await job(id, retry, 'Retry', { retry: true });
  const dependency = await stage(id, 'dependency', 'Dependency', 'pending');
  await job(id, dependency, 'Dependency', { dependency: true, delay: true, retry: true });
  await stage(id, 'prerequisite-failed', 'Dependent', 'blocked');
  const [summary] = await listRuns(db, 25, 0);
  expect(summary).toMatchObject({ total: 6, paused: 1, waiting: 1, delayed: 1, retrying: 1, blocked: 1, failed: 1 });
  expect(summary.reasons).toContain('dependency_unavailable');
  expect(summary.reasons).toContain('destination-unavailable');
  expect(RUN_OUTCOMES.reduce((sum, outcome) => sum + summary[outcome], 0)).toBe(summary.total);
  expect(summary.state).not.toMatch(/completed|cancelled/);
});

it('warns only for dispatchable old backlog and preserves delayed or paused reasons without a worker', async () => {
  const id = await run();
  const key = await stage(id, 'waiting', 'Wait', 'pending');
  await job(id, key, 'Wait');
  expect((await listRuns(db, 25, 0))[0].noDispatchBacklog).toBe(true);
  await sql`update job_queue set paused = true`.execute(db);
  expect((await listRuns(db, 25, 0))[0]).toMatchObject({ state: 'paused', noDispatchBacklog: false });
  await sql`update job_queue set paused = false`.execute(db);
  await sql`update job set "availableAt" = now() + interval '1 hour'`.execute(db);
  await sql`delete from job_worker`.execute(db);
  expect((await listRuns(db, 25, 0))[0]).toMatchObject({ state: 'delayed', noDispatchBacklog: false });
  expect(await observeQueueRun(db, 'test')).toMatchObject({
    delayed: 1,
    noDispatchBacklog: false,
    workerAvailable: false,
  });
});

it('does not complete an empty run before enumeration and returns undefined for a missing inspector run', async () => {
  await run(false);
  expect((await listRuns(db, 25, 0))[0].state).toBe('running');
  expect(await listRunItems(db, randomUUID(), 25, 0)).toBeUndefined();
});
