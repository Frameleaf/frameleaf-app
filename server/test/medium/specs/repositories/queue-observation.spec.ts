import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueExecution, QueueIntent } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { QueueService } from 'src/services/queue.service.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB, newTestService } from 'test/utils.js';

describe('durable queue observation', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let repository: JobRepository;
  let service: QueueService;
  let queue: QueueName;
  let worker: string;
  const intent = (extra: Partial<QueueIntent> = {}): QueueIntent => ({
    queue,
    name: 'observation-fixture',
    data: {},
    safeToRetry: true,
    sensitive: false,
    deadlineMs: 60_000,
    ...extra,
  });
  const snapshot = () => service.get(factory.auth(), queue);
  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    ({ sut: service } = newTestService(QueueService, { job: repository }));
  });
  beforeEach(async () => {
    queue = `observation-${randomUUID()}` as QueueName;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });
  afterAll(async () => db?.destroy());

  it('executes embedding inference after metadata inference has completed in the same run', async () => {
    const destination = `${queue}-inference`;
    await store.initialize([destination]);
    repository['handlers'][JobName.LandmarkInfer] = {
      jobName: JobName.LandmarkInfer,
      queueName: destination as QueueName,
      label: 'inference fixture',
      handler: vi.fn(),
    };
    const runId = randomUUID();
    await sql`insert into job_run(id, kind, selection, "enumerationDone")
      values (${runId}::uuid, 'inference-followups', '{}', true)`.execute(db);
    await store.enqueue(
      [JobName.AssetMetadataPostprocess, JobName.SmartSearchPostprocess].map((name) =>
        intent({ name, data: { id: 'asset' }, runId, itemKey: 'asset', rootItemKey: 'asset' }),
      ),
    );
    await store.setConcurrency(queue, 2);
    const parents = await store.claim(queue, worker, 2);
    const publish = async (name: JobName, trigger: 'metadata' | 'embedding') => {
      const claim = parents.find((parent) => parent.name === name)!;
      const context: QueueExecution = {
        claim,
        signal: new AbortController().signal,
        progress: vi.fn(),
        progressUnits: 0,
        followups: [],
        adoptions: [],
        buffering: false,
      };
      await queueExecution.run(context, () =>
        repository.collectFollowups(() =>
          repository.queue({ name: JobName.LandmarkInfer, data: { id: 'asset', trigger } }),
        ),
      );
      expect(await store.complete(claim, context.followups)).toBe(true);
    };
    await publish(JobName.AssetMetadataPostprocess, 'metadata');
    const [metadata] = await store.claim(destination, worker);
    expect(metadata.data.trigger).toBe('metadata');
    expect(await store.complete(metadata, [])).toBe(true);

    await publish(JobName.SmartSearchPostprocess, 'embedding');
    const embedding = await store.claim(destination, worker);
    expect(embedding).toHaveLength(1);
    expect(embedding[0].data.trigger).toBe('embedding');
    expect(await store.complete(embedding[0], [])).toBe(true);
    expect((await store.listRuns(10, 0)).find((run) => run.id === runId)).toMatchObject({ total: 1, completed: 1 });
  });

  it('keeps older public jobs discoverable when newer internal jobs fill the result limit', async () => {
    await store.enqueue([intent({ name: JobName.LandmarkMatchAll })]);
    await sql`update job set "createdAt" = now() - interval '1 minute' where queue = ${queue}`.execute(db);
    await store.enqueue(Array.from({ length: 1000 }, () => intent({ name: JobName.LandmarkInfer })));

    await expect(repository.searchJobs(queue, {}, 1000, true)).resolves.toEqual([
      expect.objectContaining({ name: JobName.LandmarkMatchAll }),
    ]);
    expect(await repository.searchJobs(queue, {}, 1001)).toHaveLength(1001);
  });

  it('does not turn delayed or paused execution into a completed queue', async () => {
    expect((await snapshot()).hasUnfinishedWork).toBe(false);
    await store.enqueue([intent({ options: { delay: 30_000 } })]);
    expect(await snapshot()).toMatchObject({
      hasUnfinishedWork: true,
      statistics: { active: 0, waiting: 0, delayed: 1 },
    });
    await sql`update job set "availableAt"=now() where queue=${queue}`.execute(db);
    await store.pause(queue, true);
    expect(await snapshot()).toMatchObject({
      isPaused: true,
      hasUnfinishedWork: true,
      statistics: { active: 0, waiting: 0, paused: 1 },
    });
    await store.pause(queue, false);
    const [claim] = await store.claim(queue, worker);
    await store.complete(claim, []);
    expect((await snapshot()).hasUnfinishedWork).toBe(false);
  });

  it('reports held work as unfinished, and Empty keeps it', async () => {
    const runId = randomUUID();
    await sql`insert into job_run(id, kind, selection, "enumerationDone")
      values (${runId}::uuid, 'held', '{"holds":{"observation-fixture":"setup"}}', true)`.execute(db);
    await store.enqueue([intent({ runId, itemKey: 'asset', rootItemKey: 'asset' })]);
    await sql`update job set "availableAt" = 'infinity' where queue = ${queue}`.execute(db);
    expect(await snapshot()).toMatchObject({ hasUnfinishedWork: true, statistics: { active: 0 } });
    expect(await store.claim(queue, worker)).toEqual([]);
    await store.clear(queue, ['pending', 'waiting']);
    expect((await snapshot()).hasUnfinishedWork).toBe(true);
    expect(await store.getRun(runId)).toMatchObject({ held: 1, state: 'blocked', reasons: ['first_setup_pending'] });
  });

  it('keeps terminal failure visible separately from unfinished work', async () => {
    await store.enqueue([intent({ safeToRetry: false })]);
    const [claim] = await store.claim(queue, worker);
    await store.fail(claim, 'fixture requires attention');
    expect(await snapshot()).toMatchObject({ hasUnfinishedWork: false, statistics: { failed: 1 } });
  });
});
