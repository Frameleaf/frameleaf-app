import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { QueueName } from 'src/enum.js';
import { freezeSelection } from 'src/queue/manifest.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueIntent } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { QueueService } from 'src/services/queue.service.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB, newTestService } from 'test/utils.js';

describe('durable queue observation', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
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
    const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    ({ sut: service } = newTestService(QueueService, { job: repository }));
  });
  beforeEach(async () => {
    queue = `observation-${randomUUID()}` as QueueName;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });
  afterAll(async () => db?.destroy());

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

  it('reports an actual frozen selection before its first job is admitted', async () => {
    await freezeSelection(db, intent(), db.selectFrom('job_worker').select('id').where('id', '=', worker));
    expect(await snapshot()).toMatchObject({
      hasUnfinishedWork: true,
      statistics: { active: 0, waiting: 0, delayed: 0, paused: 0 },
    });
    await store.clear(queue, ['pending', 'waiting']);
    expect((await snapshot()).hasUnfinishedWork).toBe(false);
  });

  it('retains unfinished membership-copy work when the materialized queue is empty', async () => {
    const frozenRun = await freezeSelection(
      db,
      intent(),
      db.selectFrom('job_worker').select('id').where('id', '=', worker),
    );
    const {
      rows: [frozen],
    } = await sql<{ id: string }>`select id from job_selection where "runId"=${frozenRun}::uuid`.execute(db);
    await store.clear(queue, ['pending', 'waiting']);
    const runId = await store.createRun('late-selection-alias', {});
    await sql`insert into job_selection_run ("selectionId","runId","copyComplete")
      values (${frozen.id}::uuid,${runId}::uuid,false)`.execute(db);
    expect(await snapshot()).toMatchObject({
      hasUnfinishedWork: true,
      statistics: { active: 0, waiting: 0, delayed: 0, paused: 0 },
    });
  });

  it('keeps terminal failure visible separately from unfinished work', async () => {
    await store.enqueue([intent({ safeToRetry: false })]);
    const [claim] = await store.claim(queue, worker);
    await store.fail(claim, 'fixture requires attention');
    expect(await snapshot()).toMatchObject({ hasUnfinishedWork: false, statistics: { failed: 1 } });
  });
});
