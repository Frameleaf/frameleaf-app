import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { listRuns } from 'src/queue/run-query.js';
import { finishRuns } from 'src/queue/run-summary.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { getKyselyDB } from 'test/utils.js';

/** A run never reads as finished, or drops off Activity's page, while a job does its work. */
describe('runs with live work', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  beforeEach(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    queue = `live-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });
  afterEach(async () => {
    await db.destroy();
  });

  const intent = (runId: string, name: string) => ({
    queue,
    name,
    data: {},
    safeToRetry: true,
    sensitive: false,
    deadlineMs: 600_000,
    runId,
    itemKey: 'asset',
    rootItemKey: 'asset',
  });
  const createRun = async (kind: string) => {
    const id = randomUUID();
    await sql`insert into job_run(id, kind, selection, "enumerationDone") values (${id}::uuid, ${kind}, '{}', true)`.execute(
      db,
    );
    return id;
  };
  const finishedAt = async (runId: string) =>
    (await sql<{ finishedAt: Date | null }>`select "finishedAt" from job_run where id = ${runId}::uuid`.execute(db))
      .rows[0].finishedAt;

  it('reopens a finished run when new work is queued for it, even after its jobs were pruned', async () => {
    const runId = await createRun('relink');
    await store.enqueue([intent(runId, 'Thumbnail')]);
    const [claim] = await store.claim(queue, worker);
    await store.complete(claim, []);
    await finishRuns(db, 100);
    expect(await finishedAt(runId)).not.toBeNull();
    // Retention pruned the run's jobs; the summary keeps its counts.
    await sql`delete from job where "runId" = ${runId}::uuid`.execute(db);

    await store.enqueue([intent(runId, 'Thumbnail')]);

    expect(await finishedAt(runId)).toBeNull();
    expect(await store.getRun(runId)).toMatchObject({ finishedAt: null, total: 1, waiting: 1 });
    await finishRuns(db, 100);
    expect(await finishedAt(runId)).toBeNull();
  });

  it('lists an unfinished run ahead of newer finished runs', async () => {
    const busy = await createRun('busy');
    await store.enqueue([intent(busy, 'Thumbnail')]);
    await sql`update job_run set "createdAt" = now() - interval '1 day' where id = ${busy}::uuid`.execute(db);
    const done = await createRun('done');
    await finishRuns(db, 100);
    expect(await finishedAt(done)).not.toBeNull();

    const ids = (await listRuns(db, 1000, 0)).map((run) => run.id);
    expect(ids.indexOf(busy)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(busy)).toBeLessThan(ids.indexOf(done));
  });
});
