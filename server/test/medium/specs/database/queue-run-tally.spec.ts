import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { aggregateRun, getRun, listRuns, readSurroundings, summarizeRunFailures } from 'src/queue/run-query.js';
import { finishRuns, refreshRunCounts } from 'src/queue/run-summary.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1656: a large unfinished run is read from the tally the coordinator stores, never by counting its jobs. */
describe('stored counts of an unfinished run', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queues: string[];
  let worker: string;
  const statements: string[] = [];
  /** the statements that count a run's jobs (`tallyRun`) */
  const counting = () => statements.filter((text) => /group by "rootItemKey"|group by name, state/.test(text));

  beforeEach(async () => {
    db = await getKyselyDB(undefined, (event) => void statements.push(event.query.sql));
    store = new SqlQueueStore(db);
    queues = ['thumbs', 'search', 'faces', 'ocr'].map((name) => `${name}-${randomUUID()}`);
    worker = randomUUID();
    await store.initialize(queues, worker);
  });
  afterEach(async () => {
    await db.destroy();
  });

  const HOLDS = { Faces: 'parked', Ocr: 'paused' };
  /**
   * 40 photos through four stages in every state a run's counts tell apart: finished, failed, stopped for a look,
   * cancelled, blocked, running, waiting, waiting out a retry, put off for a dependency, a parked and a paused stage,
   * plus two tasks that belong to no photo.
   */
  const seed = async (holds: Record<string, string> = HOLDS) => {
    const runId = await store.createRun('tally-fixture', { holds });
    await sql`insert into job(id, queue, name, data, state, "safeToRetry", "deadlineMs", "runId", "itemKey", "rootItemKey",
        "startedAt", "finishedAt", token, "workerId", "leaseExpiresAt", "dependencyReason", attempt, "availableAt")
      select gen_random_uuid(), (${queues}::text[])[k], (array['Thumbs','Search','Faces','Ocr'])[k], '{}', s.state, true,
        600000, ${runId}::uuid, i || '/' || k, case when i <= 40 then 'photo-' || i end,
        case when s.state <> 'pending' then now() - interval '1 minute' end,
        case when s.state not in ('pending','active') then now() - interval '30 seconds' end,
        case when s.state = 'active' then gen_random_uuid() end,
        case when s.state = 'active' then ${worker}::uuid end,
        case when s.state = 'active' then now() + interval '1 minute' end,
        case when s.state = 'pending' and k = 2 and i % 4 = 0 then 'source-unavailable' end,
        case when s.state = 'pending' and k = 2 and i % 4 = 1 then 2 else 0 end,
        case when s.state = 'pending' and k = 2 and i % 4 = 1 then now() + interval '1 hour' else now() end
      from generate_series(1, 42) i cross join generate_series(1, 4) k
      cross join lateral (select case
        when k = 1 then (array['completed','completed','failed','needs_attention','cancelled','blocked','active'])[1 + i % 7]
        when k = 2 and i % 5 = 0 then 'completed'
        else 'pending' end state) s
      where i <= 40 or k = 1`.execute(db);
    await store.finishEnumeration(runId);
    return runId;
  };
  const header = async (runId: string) => {
    const {
      rows: [run],
    } = await sql<{
      id: string;
      holds: unknown;
      live: unknown;
    }>`select id, selection->'holds' holds, summary->'live' live
      from job_run where id = ${runId}::uuid`.execute(db);
    return run;
  };
  /** As the coordinator's sweep does, for a run of any size. */
  const tally = (now?: () => number) => refreshRunCounts(db, { from: 0, now });

  it('reads the same counts from the stored tally as from counting the jobs, whatever is held or switched', async () => {
    const runId = await seed();
    expect(await tally()).toEqual([runId]);
    const stored = await header(runId);
    expect(stored.live).toMatchObject({ v: 1 });

    const compare = async () => {
      const around = await readSurroundings(db);
      const { holds } = await header(runId);
      for (const retries of [false, true]) {
        const counted = await aggregateRun(db, { id: runId, holds }, around, false, retries);
        const read = await aggregateRun(db, { id: runId, holds, live: stored.live }, around, false, retries);
        expect(read).toEqual(counted);
      }
      return aggregateRun(db, { id: runId, holds, live: stored.live }, around, false, true);
    };

    const held = await compare();
    expect(held.countsPhotos).toBe(true);
    // the parked stage's 40 pending tasks are left out; the paused stage holds its photos
    expect(held.stageTotals.total).toBe(42 + 40 + 40);
    expect(held.stageTotals.paused).toBe(40);
    expect(held.stageTotals.blocked).toBeGreaterThan(0);
    expect(held.held).toBeGreaterThan(0);
    expect(held.dependencyReasons).toEqual(['source-unavailable']);

    // holds and queue switches change after the count: the stored tally still reads as a fresh count does
    await sql`update job_run set selection = '{"holds":{"Search":"setup"}}' where id = ${runId}::uuid`.execute(db);
    expect((await compare()).stageTotals.total).toBe(42 + 40 + 40 + 40);
    await sql`update job_run set selection = '{"holds":{}}' where id = ${runId}::uuid`.execute(db);
    await sql`update job_queue set paused = true where name = ${queues[2]}`.execute(db);
    await sql`update job_queue set "closedUntil" = now() + interval '1 hour' where name = ${queues[3]}`.execute(db);
    const switched = await compare();
    expect(switched.pausedQueues).toEqual([queues[2]]);
    expect(switched.stageTotals.delayed).toBe(40);

    // the retry probe: with nothing running and few tasks live, the ones waiting out a retry say so
    await sql`update job_queue set paused = false, "closedUntil" = null`.execute(db);
    await sql`update job set state = 'completed', token = null, "finishedAt" = now() where "runId" = ${runId}::uuid
      and state = 'active'`.execute(db);
    expect(await tally(() => Date.now() + 3_600_000)).toEqual([runId]);
    stored.live = (await header(runId)).live;
    expect((await compare()).stageTotals.retrying).toBe(8);
  });

  it('answers Activity without counting the run again, and keeps Activity as it was', async () => {
    const runId = await seed();
    const before = await getRun(db, runId);
    const listed = (await listRuns(db, 25, 0)).find((run) => run.id === runId);
    expect(counting().length).toBeGreaterThan(0);

    await tally();
    statements.length = 0;
    expect(await getRun(db, runId)).toEqual(before);
    expect((await listRuns(db, 25, 0)).find((run) => run.id === runId)).toEqual(listed);
    expect(before).toMatchObject({ countsPhotos: true, state: 'paused', leftOver: expect.any(Number) });
    expect(counting()).toEqual([]);
    // no statement of the poll reads the run's jobs by state in bulk either
    expect(statements.filter((text) => /count\(\*\)/.test(text) && !/state = 'active'/.test(text))).toEqual([]);
  });

  it('shows what is running now on a stored tally', async () => {
    const runId = await seed({});
    await sql`update job set state = 'completed', token = null, "finishedAt" = now() where "runId" = ${runId}::uuid
      and state = 'active'`.execute(db);
    await tally();
    expect(await getRun(db, runId)).toMatchObject({ state: 'waiting', stageTotals: { active: 0 } });

    const { total } = (await getRun(db, runId))!.stageTotals;
    await sql`update job set state = 'active', token = gen_random_uuid(), "workerId" = ${worker}::uuid,
        "startedAt" = now(), "leaseExpiresAt" = now() + interval '1 minute'
      where id in (select id from job where "runId" = ${runId}::uuid and state = 'pending' and name = 'Ocr' limit 3)`.execute(
      db,
    );
    expect(await getRun(db, runId)).toMatchObject({ state: 'running', stageTotals: { active: 3, total } });
  });

  it('counts a tallied run again when it is due, at once after a change by hand, and never a small or finished one', async () => {
    const runId = await seed({});
    // a small run is counted when it is read
    expect(await refreshRunCounts(db)).toEqual([]);
    expect((await header(runId)).live).toBeNull();

    expect(await tally()).toEqual([runId]);
    // just counted: not again
    expect(await tally()).toEqual([]);
    // something of it is running: again once it has rested
    expect(await tally(() => Date.now() + 20_000)).toEqual([runId]);

    // Try again on its failures: the stored counts are from before, so it is counted at the next visit
    const [{ cause }] = await summarizeRunFailures(db, runId);
    expect(await store.retryRunFailures(runId, cause)).toBeGreaterThan(0);
    expect(await tally()).toEqual([runId]);
    expect(await tally()).toEqual([]);

    // finished: the summary is the run's counts, and the tally is gone with it
    await sql`update job set state = 'completed', token = null, "finishedAt" = now(), "dependencyReason" = null
      where "runId" = ${runId}::uuid and state in ('pending','active')`.execute(db);
    expect(await finishRuns(db, 10)).toBe(1);
    expect(await tally(() => Date.now() + 3_600_000)).toEqual([]);
    const finished = await getRun(db, runId);
    expect(finished).toMatchObject({ state: 'completed_with_errors', waiting: 0, active: 0 });
    expect((await header(runId)).live).toBeNull();
  });
});
