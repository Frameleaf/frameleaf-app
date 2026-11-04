import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { listRuns } from 'src/queue/run-query.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { getKyselyDB } from 'test/utils.js';

/** A run never reads as finished, or drops off Activity's page, while a job does its work. */
describe('runs with live work', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  beforeEach(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    queue = `live-${randomUUID()}`;
    await store.initialize([queue], randomUUID());
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

  it('revives a finished item and reopens its run when new work is queued for it', async () => {
    const runId = await store.createRun('relink', {});
    // A finished run whose job rows retention already pruned: the item keeps its outcome, unlinked.
    await sql`insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, state)
      values (${runId}::uuid, 'asset', 'asset', 'Thumbnail', ${queue}, '{}', 'completed')`.execute(db);
    await sql`update job_run set "enumerationDone" = true, "finishedAt" = now() where id = ${runId}::uuid`.execute(db);

    await store.enqueue([intent(runId, 'Thumbnail')]);

    const {
      rows: [item],
    } = await sql<{ state: string; linked: boolean }>`select i.state, j.id is not null linked
      from job_run_item i left join job j on j.id = i."jobId" where i."runId" = ${runId}::uuid`.execute(db);
    expect(item).toEqual({ state: 'pending', linked: true });
    const {
      rows: [run],
    } = await sql<{ finishedAt: Date | null }>`select "finishedAt" from job_run where id = ${runId}::uuid`.execute(db);
    expect(run.finishedAt).toBeNull();
  });

  it('lists a run marked finished with live jobs ahead of finished runs', async () => {
    const busy = await store.createRun('busy', {});
    await store.enqueue([intent(busy, 'Thumbnail')]);
    await sql`update job_run set "enumerationDone" = true, "finishedAt" = now(), "createdAt" = now() - interval '1 day'
      where id = ${busy}::uuid`.execute(db);
    // A newer, really finished run that would otherwise sort first among finished runs.
    const done = await store.createRun('done', {});
    await sql`update job_run set "enumerationDone" = true, "finishedAt" = now() where id = ${done}::uuid`.execute(db);

    const ids = (await listRuns(db, 1000, 0)).map((run) => run.id);
    expect(ids.indexOf(busy)).toBeLessThan(ids.indexOf(done));
  });
});
