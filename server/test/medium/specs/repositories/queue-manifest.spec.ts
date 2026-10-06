import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { pruneQueueHistory } from 'src/queue/retention.js';
import { unfinishedAdmittedRunItems, unfinishedRunItems } from 'src/queue/selection-state.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_HIGH_WATER, QUEUE_LOW_WATER, QUEUE_TIMING, QueueClaim } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { getKyselyDB } from 'test/utils.js';

describe('durable bounded selection manifests', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let repository: JobRepository;
  let queue: string;
  let worker: string;
  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });
  beforeEach(async () => {
    queue = `manifest-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
    repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    repository['handlers'][JobName.AssetGenerateThumbnails] = {
      queueName: queue as QueueName,
      jobName: JobName.AssetGenerateThumbnails,
      label: 'fixture',
      handler: vi.fn(),
    };
  });
  afterAll(async () => db?.destroy());
  const producer = (runId?: string) => ({
    queue,
    name: 'enumerate',
    data: {},
    safeToRetry: true,
    sensitive: false,
    deadlineMs: QUEUE_TIMING.opaqueDeadline,
    runId,
    itemKey: runId ? 'producer' : undefined,
    options: { deduplication: { id: queue } },
  });
  const freeze = (claim: QueueClaim, count = 1250) =>
    queueExecution.run(
      {
        claim,
        signal: new AbortController().signal,
        progress: vi.fn(),
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      },
      () =>
        repository.queueSelection(
          JobName.AssetGenerateThumbnails,
          db
            .selectFrom(sql<{ id: string }>`(select generate_series(1, ${count})::text id)`.as('selected'))
            .select('id'),
        ),
    );
  const available = (claim: QueueClaim) =>
    sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
  const manifest = (runId: string) =>
    sql<{ selected: number; unscheduled: number; attention: number }>`select count(*)::int selected,
    count(*) filter(where i."jobId" is null and i.state = 'pending' and s.state in ('ready','enumerating'))::int unscheduled,
    count(*) filter(where i.state = 'needs_attention' or (i."jobId" is null and i.state = 'pending' and s.state = 'needs_attention'))::int attention
    from job_run_item i join job_selection s on s.id = i."selectionId"
    where i."runId" = ${runId}::uuid`
      .execute(db)
      .then(({ rows }) => rows[0]);
  const snapshotRunId = async () => {
    const { rows } = await sql<{ runId: string }>`select "runId" from job_selection where queue = ${queue}`.execute(db);
    expect(rows).toHaveLength(1);
    return rows[0].runId;
  };

  it('persists database-only producer checkpoints once across a new retry claim', async () => {
    await store.enqueue([producer()]);
    const [first] = await store.claim(queue, worker);
    const prepare = vi.fn().mockResolvedValue([{ ownerId: randomUUID(), id: randomUUID() }]);
    const checkpoint = (claim: QueueClaim) =>
      queueExecution.run(
        {
          claim,
          signal: new AbortController().signal,
          progress: vi.fn(),
          progressUnits: 0,
          adoptions: [],
          followups: [],
          buffering: false,
        },
        () => repository.prepareCheckpoint('pet-runs', prepare),
      );
    const original = await checkpoint(first);
    await store.fail(first, 'producer interrupted');
    await available(first);
    const [retry] = await store.claim(queue, worker);
    expect(await checkpoint(retry)).toEqual(original);
    expect(prepare).toHaveBeenCalledOnce();
    await expect(checkpoint(first)).rejects.toThrow('lost its claim');
  });

  it('freezes per-item producer data into the ledger and forwards it to admitted execution', async () => {
    await repository.queueSelection(
      JobName.AssetGenerateThumbnails,
      db
        .selectFrom(
          sql<{
            id: string;
            data: object;
          }>`(select 'asset-a'::text id, '{"runId":"pet-run","ownerId":"owner-a"}'::jsonb data)`.as('selected'),
        )
        .select(['id', 'data']),
      { options: { enabled: false, values: [null, 'source'] } },
    );
    const runId = await snapshotRunId();
    expect(await store.feedManifest(queue)).toBe(1);
    const [claim] = await store.claim(queue, worker);
    expect(claim.runId).toBe(runId);
    const expected = {
      id: 'asset-a',
      runId: 'pet-run',
      ownerId: 'owner-a',
      options: { enabled: false, values: [null, 'source'] },
    };
    expect(claim.data).toEqual(expected);
    const { rows } = await sql`select selection, jsonb_typeof(selection) as type from job_run_item
      where "runId" = ${runId}::uuid`.execute(db);
    expect(rows).toEqual([{ selection: expected, type: 'object' }]);
  });

  it('reuses the exact nightly snapshot on a fresh claim after a crashed no-runId producer', async () => {
    await store.enqueue([producer()]);
    const [first] = await store.claim(queue, worker);
    expect(first.runId).toBeNull();
    await freeze(first);
    const originalRun = first.runId!;
    expect(await manifest(originalRun)).toMatchObject({ selected: 1250, unscheduled: 1250 });
    expect(await store.feedManifest(queue)).toBe(0); // unaccepted snapshot cannot execute
    await recordStoppedAttempt(db, first.id, first.token);
    await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${first.id}::uuid`.execute(db);
    await store.recoverExpired();
    await available(first);
    const [retry] = await store.claim(queue, worker);
    expect(retry.runId).toBe(originalRun);
    expect(retry.attempt).toBe(2);
    await freeze(retry, 1500); // library grew; retry must keep its original snapshot
    expect(await manifest(originalRun)).toMatchObject({ selected: 1250, unscheduled: 1250 });
    await store.complete(retry, []);
    expect(await store.feedManifest(queue)).toBe(250);
    expect(await manifest(originalRun)).toMatchObject({ selected: 1250, unscheduled: 1000 });
    const { rows } = await sql`select id from job_selection where "producerId" = ${first.id}::uuid`.execute(db);
    expect(rows).toHaveLength(1);
  });

  it('shares a frozen bulk snapshot with runs attached both before and after enumeration', async () => {
    const runs = await Promise.all([1, 2, 3].map(() => store.createRun('overlap', {})));
    await store.enqueue([producer(runs[0]), producer(runs[1])]);
    const [claim] = await store.claim(queue, worker);
    await freeze(claim, 12);
    await store.enqueue([producer(runs[2])]);
    await store.complete(claim, []);
    for (const run of runs) expect(await manifest(run)).toMatchObject({ selected: 12, unscheduled: 12 });
    expect(await store.feedManifest(queue)).toBe(12);
    const {
      rows: [scheduled],
    } = await sql<{ jobs: number; memberships: number }>`select
      count(distinct "jobId")::int jobs, count(*)::int memberships from job_run_item
      where "runId" = any(${runs}::uuid[]) and "selectionId" is not null`.execute(db);
    expect(scheduled).toEqual({ jobs: 12, memberships: 36 });
    await store.setConcurrency(queue, 12);
    for (const child of await store.claim(queue, worker)) await store.complete(child, []);
    const { rows } = await sql<{
      finishedAt: Date | null;
      enumerationDone: boolean;
    }>`select "finishedAt", "enumerationDone"
      from job_run where id = any(${runs}::uuid[])`.execute(db);
    expect(rows.every((row) => row.enumerationDone && row.finishedAt !== null)).toBe(true);
  });

  it('closes exhausted enumeration truthfully and an explicit retry reopens the same snapshot', async () => {
    await store.enqueue([producer()]);
    const [first] = await store.claim(queue, worker);
    await freeze(first);
    await store.fail(first, 'interrupted producer');
    await available(first);
    const [second] = await store.claim(queue, worker);
    await freeze(second, 2000);
    await store.fail(second, 'exhausted producer');
    expect(await manifest(first.runId!)).toEqual({ selected: 1250, unscheduled: 0, attention: 1250 });
    const readRun = () =>
      sql<{ finishedAt: Date | null; enumerationDone: boolean }>`select "finishedAt", "enumerationDone"
      from job_run where id = ${first.runId}::uuid`
        .execute(db)
        .then(({ rows }) => rows[0]);
    expect(await readRun()).toMatchObject({ enumerationDone: true, finishedAt: expect.any(Date) });
    const exhausted = (await store.listRuns(100, 0)).find((run) => run.id === first.runId)!;
    expect(exhausted).toMatchObject({
      state: 'completed_with_errors',
      total: 1250,
      needsAttention: 1250,
      stageTotals: { total: 1251, failed: 1, needsAttention: 1250 },
    });
    expect(await store.feedManifest(queue)).toBe(0);
    expect(await store.retryFailed(queue)).toBe(1);
    expect(await readRun()).toEqual({ enumerationDone: false, finishedAt: null });
    const [manual] = await store.claim(queue, worker);
    await freeze(manual, 2500);
    await store.complete(manual, []);
    expect(await manifest(first.runId!)).toEqual({ selected: 1250, unscheduled: 1250, attention: 0 });
    expect(await store.feedManifest(queue)).toBe(250);
  });

  it('counts two face stages as one selected media item using the projected root identity', async () => {
    await repository.queueSelection(
      JobName.AssetGenerateThumbnails,
      db
        .selectFrom(
          sql<{
            id: string;
            rootItemKey: string;
          }>`(select id, root as "rootItemKey" from (values ('face-a', 'asset-a'), ('face-b', 'asset-a')) f(id, root))`.as(
            'selected',
          ),
        )
        .select(['id', 'rootItemKey']),
    );
    const runId = await snapshotRunId();
    const {
      rows: [counts],
    } = await sql<{ media: number; stages: number }>`select count(distinct "rootItemKey")::int media,
      count(*)::int stages from job_run_item where "runId" = ${runId}::uuid`.execute(db);
    expect(counts).toEqual({ media: 1, stages: 2 });
    expect((await store.listRuns(100, 0)).find((run) => run.id === runId)).toMatchObject({
      total: 1,
      waiting: 1,
      stageTotals: { total: 2, waiting: 2 },
    });
  });

  it('keeps cold and delayed work unfinished, then resolves stale and pruned completed ledgers', async () => {
    await repository.queueSelection(
      JobName.AssetGenerateThumbnails,
      db.selectFrom(sql<{ id: string }>`(select unnest(array['one','two']) id)`.as('selected')).select('id'),
    );
    const runId = await snapshotRunId();
    const pending = async () =>
      (
        await sql<{ admitted: boolean; full: boolean }>`select
        ${unfinishedAdmittedRunItems(sql<string>`${runId}::uuid`)} admitted,
        ${unfinishedRunItems(sql<string>`${runId}::uuid`)} full`.execute(db)
      ).rows[0];
    // No admitted execution is not sufficient to declare an unmaterialized selection complete.
    expect(await pending()).toEqual({ admitted: false, full: true });
    await store.finishEnumeration(runId);
    expect((await store.listRuns(100, 0)).find((run) => run.id === runId)?.finishedAt).toBeNull();
    expect(await store.feedManifest(queue)).toBe(2);
    await store.setConcurrency(queue, 1);
    const [first] = await store.claim(queue, worker);
    // Claim promotes the admitted siblings to waiting before taking its one active slot.
    const { rows: delayed } = await sql<{ id: string }>`update job set "availableAt"=now()+interval '1 hour'
      where queue=${queue} and state in ('pending','waiting') returning id`.execute(db);
    expect(delayed).toHaveLength(1);
    await store.pause(queue, true);
    expect(await store.complete(first, [])).toBe(true);
    expect(await pending()).toEqual({ admitted: true, full: true });
    expect((await store.listRuns(100, 0)).find((run) => run.id === runId)?.finishedAt).toBeNull();
    await store.pause(queue, false);
    expect(await store.claim(queue, worker)).toEqual([]);
    await sql`update job set "availableAt"=now() where id=${delayed[0].id}::uuid
      and state in ('pending','waiting')`.execute(db);
    const [last] = await store.claim(queue, worker);
    expect(await store.complete(last, [])).toBe(true);
    expect(await pending()).toEqual({ admitted: false, full: false });
    expect((await store.listRuns(100, 0)).find((run) => run.id === runId)).toMatchObject({
      state: 'completed',
      completed: 2,
      finishedAt: expect.any(Date),
    });
    // Shared/retained membership can lag its actual executor. Preserve the terminal-job override.
    await sql`update job_run_item set state='pending' where "jobId"=${last.id}::uuid`.execute(db);
    expect(await pending()).toEqual({ admitted: false, full: false });
    // Real retention must keep completed outcomes after payload/job identity is gone.
    await sql`update job set "finishedAt"=now()-interval '8 days' where queue=${queue}`.execute(db);
    expect(await pruneQueueHistory(db)).toBe(2);
    expect(await pending()).toEqual({ admitted: false, full: false });
    expect((await store.listRuns(100, 0)).find((run) => run.id === runId)).toMatchObject({
      state: 'completed',
      completed: 2,
      stageTotals: { total: 2, completed: 2 },
    });
  });

  it('leaves excess items manifest-only, honors pause and refills between the watermarks in bounded transactions', async () => {
    await repository.queueSelection(
      JobName.AssetGenerateThumbnails,
      db.selectFrom(sql<{ id: string }>`(select generate_series(1, 15000)::text id)`.as('selected')).select('id'),
    );
    const runId = await snapshotRunId();
    const readRun = async () => (await store.listRuns(100, 0)).find((run) => run.id === runId)!;
    await store.pause(queue, true);
    expect(await readRun()).toMatchObject({
      total: 15_000,
      paused: 15_000,
      completed: 0,
      state: 'paused',
      enumerationDone: true,
      finishedAt: null,
      stageTotals: { total: 15_000, paused: 15_000 },
    });
    expect(await store.feedManifest(queue)).toBe(0);
    await store.pause(queue, false);
    for (let batch = 0; batch < 4; batch++) expect(await store.feedManifest(queue)).toBe(250);
    expect(await store.feedManifest(queue)).toBe(0);
    const count = () =>
      sql<{ count: number }>`select count(*)::int count from job
      where queue = ${queue} and state in ('pending','waiting','active')`
        .execute(db)
        .then(({ rows }) => rows[0].count);
    expect(await count()).toBe(QUEUE_HIGH_WATER);
    // Frozen roots remain visible even though 14,000 have no execution row yet.
    expect(await readRun()).toMatchObject({
      total: 15_000,
      waiting: 15_000,
      completed: 0,
      enumerationDone: true,
      finishedAt: null,
      stageTotals: { total: 15_000, waiting: 15_000 },
    });
    await store.setConcurrency(queue, 250);
    for (let batch = 0; batch < 2; batch++) {
      for (const claim of await store.claim(queue, worker)) await store.complete(claim, []);
      if (batch === 0) expect(await store.feedManifest(queue)).toBe(0);
    }
    expect(await count()).toBe(QUEUE_LOW_WATER);
    expect(await readRun()).toMatchObject({
      total: 15_000,
      completed: 500,
      waiting: 14_500,
      stageTotals: { total: 15_000, completed: 500, waiting: 14_500 },
    });
    expect(await store.feedManifest(queue)).toBe(250);
    expect(await store.feedManifest(queue)).toBe(250);
    expect(await count()).toBe(QUEUE_HIGH_WATER);
    expect(await store.feedManifest(queue)).toBe(0);
  }, 60_000); // CI must accept 500 sequential publications before checking the refill watermark.
});
