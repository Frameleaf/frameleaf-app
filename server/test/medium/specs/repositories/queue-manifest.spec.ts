import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_HIGH_WATER, QUEUE_LOW_WATER, QUEUE_TIMING, QueueClaim } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
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
    count(*) filter(where "jobId" is null and state = 'pending')::int unscheduled,
    count(*) filter(where state = 'needs_attention')::int attention from job_run_item
    where "runId" = ${runId}::uuid and "selectionId" is not null`
      .execute(db)
      .then(({ rows }) => rows[0]);

  it('reuses the exact nightly snapshot on a fresh claim after a crashed no-runId producer', async () => {
    await store.enqueue([producer()]);
    const [first] = await store.claim(queue, worker);
    expect(first.runId).toBeNull();
    await freeze(first);
    const originalRun = first.runId!;
    expect(await manifest(originalRun)).toMatchObject({ selected: 1250, unscheduled: 1250 });
    expect(await store.feedManifest(queue)).toBe(0); // unaccepted snapshot cannot execute
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
    const runId = await repository.createRun('faces', {}, () =>
      repository.queueSelection(
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
      ),
    );
    const {
      rows: [counts],
    } = await sql<{ media: number; stages: number }>`select count(distinct "rootItemKey")::int media,
      count(*)::int stages from job_run_item where "runId" = ${runId}::uuid`.execute(db);
    expect(counts).toEqual({ media: 1, stages: 2 });
  });

  it('leaves excess items manifest-only, honors pause and refills between the watermarks in bounded transactions', async () => {
    await repository.createRun('direct', {}, () =>
      repository.queueSelection(
        JobName.AssetGenerateThumbnails,
        db.selectFrom(sql<{ id: string }>`(select generate_series(1, 15000)::text id)`.as('selected')).select('id'),
      ),
    );
    await store.pause(queue, true);
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
    await store.setConcurrency(queue, 250);
    for (let batch = 0; batch < 2; batch++) {
      for (const claim of await store.claim(queue, worker)) await store.complete(claim, []);
      if (batch === 0) expect(await store.feedManifest(queue)).toBe(0);
    }
    expect(await count()).toBe(QUEUE_LOW_WATER);
    expect(await store.feedManifest(queue)).toBe(250);
    expect(await store.feedManifest(queue)).toBe(250);
    expect(await count()).toBe(QUEUE_HIGH_WATER);
    expect(await store.feedManifest(queue)).toBe(0);
  });
});
