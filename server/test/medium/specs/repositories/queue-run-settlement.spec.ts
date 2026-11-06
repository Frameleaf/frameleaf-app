import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName } from 'src/enum.js';
import { finishRuns } from 'src/queue/run-summary.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueIntent } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Work must never run while its run looks finished, and no run may stay open with nothing left to do. FL-1265: the
 * coordinator sweep (`finishRuns`) finishes a run once; anything that brings its work back reopens it.
 */
describe('queue run settlement', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  const intent = (extra: Partial<QueueIntent> = {}): QueueIntent => ({
    queue,
    name: 'thumbnail',
    data: { id: randomUUID() },
    safeToRetry: true,
    sensitive: false,
    deadlineMs: QUEUE_TIMING.opaqueDeadline,
    ...extra,
  });
  const finishedAt = async (runId: string) =>
    (await sql<{ finishedAt: Date | null }>`select "finishedAt" from job_run where id = ${runId}::uuid`.execute(db))
      .rows[0].finishedAt;
  const repository = (...names: JobName[]) => {
    const executor = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    for (const name of names) executor['handlers'][name] = { queueName: queue } as never;
    return executor;
  };
  const createRun = async (kind: string) => {
    const id = randomUUID();
    await sql`insert into job_run(id, kind, selection) values (${id}::uuid, ${kind}, '{}')`.execute(db);
    return id;
  };
  /** Runs the sweep, then reads the run's `finishedAt`. */
  const settled = async (runId: string) => {
    await finishRuns(db, 100);
    return finishedAt(runId);
  };

  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });
  beforeEach(async () => {
    queue = `test-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });

  it('runs a blocked child again when its retried parent asks for it again in the same run', async () => {
    const runId = await createRun('rerun-parent');
    await store.enqueue([intent({ name: 'parent', runId, itemKey: 'asset' })]);
    const child = (parentId: string, revision: number) =>
      intent({ name: 'child', runId, itemKey: 'asset', parentId, data: { revision } });
    let [parent] = await store.claim(queue, worker);
    await store.enqueue([child(parent.id, 1)]);
    await store.finishEnumeration(runId);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) [parent] = await store.claim(queue, worker);
      await store.fail(parent, 'boom');
      await sql`update job set "availableAt" = now() where id = ${parent.id}::uuid`.execute(db);
    }
    const states = async () =>
      (
        await sql<{
          name: string;
          state: string;
        }>`select name, state from job where queue = ${queue} order by name desc`.execute(db)
      ).rows;
    expect(await states()).toEqual([
      { name: 'parent', state: 'failed' },
      { name: 'child', state: 'blocked' },
    ]);

    expect(await store.retryFailed(queue)).toBe(1);
    [parent] = await store.claim(queue, worker);
    expect(await store.complete(parent, [child(parent.id, 2)])).toBe(true);

    const [rerun] = await store.claim(queue, worker);
    expect(rerun).toMatchObject({ name: 'child', data: { revision: 2 } });
    expect(await settled(runId)).toBeNull();
    expect(await store.complete(rerun, [])).toBe(true);
    expect(await settled(runId)).not.toBeNull();
  });

  it('a request without a parent coalesces onto a finished stage in the same run (known limit)', async () => {
    const runId = await createRun('no-parent');
    await store.enqueue([intent({ name: 'child', runId, itemKey: 'asset' })]);
    const [child] = await store.claim(queue, worker);
    await store.complete(child, []);
    await store.enqueue([intent({ name: 'child', runId, itemKey: 'asset', data: { revision: 2 } })]);
    expect(await store.claim(queue, worker)).toEqual([]);
  });

  it('does not re-run a finished stage that a different job asks for in the same run', async () => {
    const runId = await createRun('no-loop');
    await store.enqueue([intent({ name: 'first', runId, itemKey: 'asset' })]);
    const [first] = await store.claim(queue, worker);
    await store.complete(first, [intent({ name: 'second', runId, itemKey: 'asset', parentId: first.id })]);
    const [second] = await store.claim(queue, worker);
    await store.complete(second, [intent({ name: 'first', runId, itemKey: 'asset', parentId: second.id })]);
    expect(await store.claim(queue, worker)).toEqual([]);
  });

  it('removeJob blocks dependents and lets the run settle', async () => {
    const runId = await createRun('remove-job');
    const key = `album/${randomUUID()}`;
    await store.enqueue([intent({ name: JobName.NotifyAlbumUpdate, runId, itemKey: key, options: { jobId: key } })]);
    const {
      rows: [removed],
    } = await sql<{ id: string }>`select id from job where queue = ${queue}`.execute(db);
    await store.enqueue([intent({ name: 'child', runId, itemKey: key, parentId: removed.id })]);
    await store.finishEnumeration(runId);

    await repository(JobName.NotifyAlbumUpdate).removeJob(JobName.NotifyAlbumUpdate, key);

    const { rows } = await sql<{ name: string; state: string }>`select name, state from job
      where queue = ${queue} order by state`.execute(db);
    expect(rows).toEqual([
      { name: 'child', state: 'blocked' },
      { name: JobName.NotifyAlbumUpdate, state: 'cancelled' },
    ]);
    expect(await settled(runId)).not.toBeNull();
  });

  it('a replacement queued after removeJob in the same run runs and keeps the run open', async () => {
    const runId = await createRun('replace-job');
    const key = `album/${randomUUID()}`;
    const notify = (revision: number) =>
      intent({ name: JobName.NotifyAlbumUpdate, runId, itemKey: key, options: { jobId: key }, data: { revision } });
    await store.enqueue([notify(1)]);
    await store.finishEnumeration(runId);

    await repository(JobName.NotifyAlbumUpdate).removeJob(JobName.NotifyAlbumUpdate, key);
    await store.enqueue([notify(2)]);

    expect(await settled(runId)).toBeNull();
    const [replacement] = await store.claim(queue, worker);
    expect(replacement.data).toEqual({ revision: 2 });
    await store.complete(replacement, []);
    expect(await settled(runId)).not.toBeNull();
  });

  it('a retry reopens a finished run, which is then counted and finished again', async () => {
    const runId = await createRun('retry');
    await store.enqueue([intent({ runId, itemKey: 'asset', rootItemKey: 'asset' })]);
    await store.finishEnumeration(runId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const [claim] = await store.claim(queue, worker);
      await store.fail(claim, 'boom');
      await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
    }
    const first = await settled(runId);
    expect(first).not.toBeNull();
    expect(await store.getRun(runId)).toMatchObject({ state: 'completed_with_errors', failed: 1 });

    expect(await store.retryFailed(queue)).toBe(1);
    expect(await finishedAt(runId)).toBeNull();
    expect(await store.getRun(runId)).toMatchObject({ finishedAt: null, waiting: 1, failed: 0 });
    const [claim] = await store.claim(queue, worker);
    expect(await settled(runId)).toBeNull();
    await store.complete(claim, []);
    expect(await settled(runId)).not.toBeNull();
    expect(await store.getRun(runId)).toMatchObject({ state: 'completed', completed: 1, failed: 0 });
  });

  it('work a running job queues joins its run and keeps it open until it is done', async () => {
    const runId = await createRun('followups');
    await store.enqueue([intent({ name: 'parent', runId, itemKey: 'asset', rootItemKey: 'asset' })]);
    await store.finishEnumeration(runId);
    const [parent] = await store.claim(queue, worker);
    expect(await settled(runId)).toBeNull();
    expect(
      await store.complete(parent, [
        intent({ name: 'child', runId, itemKey: 'asset', rootItemKey: 'asset', parentId: parent.id }),
      ]),
    ).toBe(true);
    expect(await settled(runId)).toBeNull();
    const [child] = await store.claim(queue, worker);
    expect(child.name).toBe('child');
    await store.complete(child, []);
    expect(await settled(runId)).not.toBeNull();
    expect(await store.getRun(runId)).toMatchObject({
      total: 1,
      completed: 1,
      stageTotals: { total: 2, completed: 2 },
    });
  });

  it('a run still being enumerated never finishes, however empty', async () => {
    const runId = await createRun('enumerating');
    expect(await settled(runId)).toBeNull();
    await store.finishEnumeration(runId);
    expect(await settled(runId)).not.toBeNull();
  });
});
