import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueClaim, QueueIntent } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { getKyselyDB } from 'test/utils.js';

/** Work must never run while its run looks finished, and no run may stay open with nothing left to do. */
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
  /** An alias run counting `jobId` through a library producer link or source, which `syncItem` leaves alone. */
  const libraryAlias = async (jobId: string, itemState: string, via: 'producer' | 'source') => {
    const [library, alias] = [await store.createRun('library', {}), await store.createRun('alias', {})];
    const selectionId = randomUUID();
    await sql`insert into job_selection(id, "runId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state,
      "sourceKind", "libraryOperationId") values (${selectionId}::uuid, ${library}::uuid, 'thumbnail', ${queue},
      true, false, 1000, 'ready', 'library-initial', ${library}::uuid)`.execute(db);
    if (via === 'producer') {
      await sql`insert into job_library_source_producer("selectionId", "producerId")
        values (${selectionId}::uuid, ${jobId}::uuid)`.execute(db);
    }
    await sql`insert into job_run_item("runId", "itemKey", stage, queue, selection, "selectionId", "jobId", state)
      values (${alias}::uuid, 'asset', 'thumbnail', ${queue}, '{}'::jsonb,
        ${via === 'source' ? selectionId : null}::uuid, ${jobId}::uuid, ${itemState})`.execute(db);
    await sql`update job_run set "enumerationDone" = true, "finishedAt" = now() where id = ${alias}::uuid`.execute(db);
    return alias;
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
    const runId = await store.createRun('rerun-parent', {});
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
    expect(await finishedAt(runId)).toBeNull();
    expect(await store.complete(rerun, [])).toBe(true);
    expect(await finishedAt(runId)).not.toBeNull();
  });

  it('does not re-run a finished stage that a different job asks for in the same run', async () => {
    const runId = await store.createRun('no-loop', {});
    await store.enqueue([intent({ name: 'first', runId, itemKey: 'asset' })]);
    const [first] = await store.claim(queue, worker);
    await store.complete(first, [intent({ name: 'second', runId, itemKey: 'asset', parentId: first.id })]);
    const [second] = await store.claim(queue, worker);
    await store.complete(second, [intent({ name: 'first', runId, itemKey: 'asset', parentId: second.id })]);
    expect(await store.claim(queue, worker)).toEqual([]);
  });

  it('removeJob blocks dependents and lets the run settle', async () => {
    const runId = await store.createRun('remove-job', {});
    const key = `album/${randomUUID()}`;
    await store.enqueue([intent({ name: JobName.NotifyAlbumUpdate, runId, itemKey: key, options: { jobId: key } })]);
    const {
      rows: [removed],
    } = await sql<{ id: string }>`select id from job where queue = ${queue}`.execute(db);
    await store.enqueue([intent({ name: 'child', runId, itemKey: key, parentId: removed.id })]);
    await store.finishEnumeration(runId);

    await repository(JobName.NotifyAlbumUpdate).removeJob(JobName.NotifyAlbumUpdate, key);

    const { rows } = await sql<{ name: string; job: string; item: string }>`select j.name, j.state job, i.state item
      from job j join job_run_item i on i."jobId" = j.id where j.queue = ${queue} order by j.state`.execute(db);
    expect(rows).toEqual([
      { name: 'child', job: 'blocked', item: 'blocked' },
      { name: JobName.NotifyAlbumUpdate, job: 'cancelled', item: 'cancelled' },
    ]);
    expect(await finishedAt(runId)).not.toBeNull();
  });

  it('a replacement queued after removeJob in the same run runs and keeps the run open', async () => {
    const runId = await store.createRun('replace-job', {});
    const key = `album/${randomUUID()}`;
    const notify = (revision: number) =>
      intent({ name: JobName.NotifyAlbumUpdate, runId, itemKey: key, options: { jobId: key }, data: { revision } });
    await store.enqueue([notify(1)]);
    await store.finishEnumeration(runId);

    await repository(JobName.NotifyAlbumUpdate).removeJob(JobName.NotifyAlbumUpdate, key);
    await store.enqueue([notify(2)]);

    expect(await finishedAt(runId)).toBeNull();
    const [replacement] = await store.claim(queue, worker);
    expect(replacement.data).toEqual({ revision: 2 });
    await store.complete(replacement, []);
    expect(await finishedAt(runId)).not.toBeNull();
  });

  it('retryFailed reopens a library alias run that counts the retried job', async () => {
    const owner = await store.createRun('owner', {});
    await store.enqueue([intent({ runId: owner, itemKey: 'asset' })]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const [claim] = await store.claim(queue, worker);
      await store.fail(claim, 'boom');
      await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
    }
    const {
      rows: [failed],
    } = await sql<{ id: string; state: string }>`select id, state from job where queue = ${queue}`.execute(db);
    expect(failed.state).toBe('failed');
    const alias = await libraryAlias(failed.id, 'failed', 'producer');

    expect(await store.retryFailed(queue)).toBe(1);
    expect(await finishedAt(alias)).toBeNull();
  });

  it('a latest request restarting a finished job reopens a library alias run that counts it', async () => {
    const owner = await store.createRun('owner', {});
    const options = { deduplication: { id: `latest-${owner}`, keepLastIfActive: true } };
    await store.enqueue([intent({ options, runId: owner, itemKey: 'asset' })]);
    const [first] = await store.claim(queue, worker);
    await store.enqueue([intent({ options, runId: owner, itemKey: 'asset', data: { revision: 2 } })]);
    const alias = await libraryAlias(first.id, 'completed', 'source');

    expect(await store.complete(first, [])).toBe(true);
    const [latest] = await store.claim(queue, worker);
    expect(latest.id).toBe(first.id);
    expect(await finishedAt(alias)).toBeNull();
  });

  it('work a running job queues directly counts in every run sharing that job', async () => {
    const [owner, sharing] = [await store.createRun('owner', {}), await store.createRun('sharing', {})];
    const options = { deduplication: { id: `shared-${owner}` } };
    await store.enqueue([intent({ name: 'parent', options, runId: owner, itemKey: 'asset' })]);
    await store.enqueue([intent({ name: 'parent', options, runId: sharing, itemKey: 'asset' })]);
    await store.finishEnumeration(owner);
    await store.finishEnumeration(sharing);
    const [parent] = await store.claim(queue, worker);

    const executor = repository(JobName.SidecarCheck);
    const execution = {
      claim: parent as QueueClaim,
      signal: new AbortController().signal,
      progress: vi.fn(),
      progressUnits: 0,
      adoptions: [],
      followups: [],
      buffering: false,
    };
    await queueExecution.run(execution, () => executor.queue({ name: JobName.SidecarCheck, data: { id: 'child' } }));
    expect(await store.complete(parent, [])).toBe(true);

    expect(await finishedAt(sharing)).toBeNull();
    const [child] = await store.claim(queue, worker);
    expect(child.name).toBe(JobName.SidecarCheck);
    await store.complete(child, []);
    expect(await finishedAt(owner)).not.toBeNull();
    expect(await finishedAt(sharing)).not.toBeNull();
  });
});
