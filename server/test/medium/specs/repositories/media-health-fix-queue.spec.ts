import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueExecution } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1337: a person's Try again supersedes the photo's other fixes, and one fix runs per photo at a time. */
describe('Library care fix queue', () => {
  let db: Kysely<any>;
  let jobs: JobRepository;
  let store: SqlQueueStore;
  let queue: string;
  let asset: string;

  const fix = (data: Record<string, unknown>) =>
    jobs.queue({ name: JobName.MediaHealthFixAsset, data: { id: asset, ...data } as never });
  const rows = () =>
    db
      .selectFrom('job')
      .select(['id', 'externalId', 'state', 'data', 'latestPending'])
      .where('queue', '=', queue)
      .orderBy('createdAt')
      .execute();
  const row = async (externalId: string) => (await rows()).find((job) => job.externalId === externalId)!;
  const start = (externalId: string, startedAt = new Date()) =>
    db
      .updateTable('job')
      .set({ state: 'active', startedAt, token: randomUUID() })
      .where('queue', '=', queue)
      .where('externalId', '=', externalId)
      .execute();
  const as = <T>(jobId: string, action: () => Promise<T>) =>
    queueExecution.run({ claim: { id: jobId } } as unknown as QueueExecution, action);

  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    queue = `media-health-fix-${randomUUID()}`;
    asset = randomUUID();
    await store.initialize([queue], randomUUID());
    jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    jobs['handlers'][JobName.MediaHealthFixAsset] = { queueName: queue as QueueName } as never;
  });

  it('runs a Try again in place of a feed already queued, instead of dropping it', async () => {
    await fix({ from: 'check' });
    await fix({ from: 'person', attempt: 0 });

    const live = (await rows()).filter((job) => job.state !== 'cancelled');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ externalId: `fix-${asset}`, data: { id: asset, from: 'person', attempt: 0 } });
    // a feed after it collapses onto the Try again, which stays a person's
    await fix({ from: 'preview' });
    expect((await row(`fix-${asset}`)).data).toMatchObject({ from: 'person' });
  });

  it('runs a Try again after the fix that is running settles', async () => {
    await fix({ from: 'check' });
    await start(`fix-${asset}`);
    await fix({ from: 'person', attempt: 0 });

    const running = await row(`fix-${asset}`);
    expect(running.state).toBe('active');
    expect(running.latestPending).toMatchObject({ data: { id: asset, from: 'person', attempt: 0 } });
  });

  it('cancels the waiting fixes of the photo, and only those', async () => {
    const other = randomUUID();
    await fix({ from: 'check', requeue: 2, attempt: 2, delay: 1_800_000 });
    await fix({ from: 'check', searched: true });
    await fix({ from: 'check', requeue: 1, delay: 1_800_000 });
    await start(`fix-${asset}/r1`);
    await jobs.queue({
      name: JobName.MediaHealthFixAsset,
      data: { id: other, from: 'check', requeue: 1, delay: 60_000 },
    });

    // the fix of a Try again that already waited for the running one (it started before the cancel)
    await fix({ from: 'person', attempt: 0, requeue: 1, delay: 60_000 });

    await jobs.cancelWaitingFixes(asset);

    const states = Object.fromEntries((await rows()).map((job) => [job.externalId, job.state]));
    expect(states).toEqual({
      [`fix-${asset}/r2`]: 'cancelled',
      [`fix-${asset}/searched`]: 'cancelled',
      // a running fix settles by itself; the per-photo guard holds Try again back meanwhile
      [`fix-${asset}/r1`]: 'active',
      // the Try again's own fix waiting its turn stays
      [`fix-${asset}/p1`]: 'pending',
      [`fix-${other}/r1`]: 'pending',
    });
  });

  it('lets one fix of a photo run at a time: the one that started first', async () => {
    await fix({ from: 'check', requeue: 1 });
    await fix({ from: 'person', attempt: 0 });
    const first = await row(`fix-${asset}/r1`);
    const second = await row(`fix-${asset}`);

    // nothing running yet
    await expect(as(second.id, () => jobs.isOtherFixRunning(asset))).resolves.toBe(false);

    await start(`fix-${asset}/r1`, new Date(Date.now() - 1000));
    await start(`fix-${asset}`);
    // the later one waits, the earlier one carries on, and another photo is not held back
    await expect(as(second.id, () => jobs.isOtherFixRunning(asset))).resolves.toBe(true);
    await expect(as(first.id, () => jobs.isOtherFixRunning(asset))).resolves.toBe(false);
    await expect(as(second.id, () => jobs.isOtherFixRunning(randomUUID()))).resolves.toBe(false);

    // two that started at the same moment: exactly one waits
    await sql`update job set "startedAt" = ${new Date()} where queue = ${queue}`.execute(db);
    const waits = await Promise.all([first, second].map((job) => as(job.id, () => jobs.isOtherFixRunning(asset))));
    expect(waits.filter(Boolean)).toHaveLength(1);
  });
});
