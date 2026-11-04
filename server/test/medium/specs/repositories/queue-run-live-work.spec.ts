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

  it('revives a finished item when its request joins a live job with the same deduplication key', async () => {
    const runId = await store.createRun('relink-dedup', {});
    const keyed = { ...intent(runId, 'Thumbnail'), options: { deduplication: { id: 'thumbnail:asset' } } };
    await store.enqueue([keyed]);
    // The item already ended and lost its link, but the keyed job is still waiting.
    await sql`update job_run_item set state = 'completed', "jobId" = null where "runId" = ${runId}::uuid`.execute(db);
    await sql`update job_run set "enumerationDone" = true, "finishedAt" = now() where id = ${runId}::uuid`.execute(db);

    await store.enqueue([keyed]);

    const {
      rows: [item],
    } = await sql<{ state: string; jobState: string }>`select i.state, j.state "jobState"
      from job_run_item i join job j on j.id = i."jobId" where i."runId" = ${runId}::uuid`.execute(db);
    expect(item).toEqual({ state: 'pending', jobState: 'pending' });
    const {
      rows: [run],
    } = await sql<{ finishedAt: Date | null }>`select "finishedAt" from job_run where id = ${runId}::uuid`.execute(db);
    expect(run.finishedAt).toBeNull();
  });

  it('reopens a finished run whose new item joins another run’s live job', async () => {
    const owner = await store.createRun('owner', {});
    const keyed = (runId: string) => ({
      ...intent(runId, 'Thumbnail'),
      options: { deduplication: { id: 'thumbnail:shared' } },
    });
    await store.enqueue([keyed(owner)]);
    const late = await store.createRun('late', {});
    await sql`update job_run set "enumerationDone" = true, "finishedAt" = now() where id = ${late}::uuid`.execute(db);

    await store.enqueue([keyed(late)]);

    const {
      rows: [run],
    } = await sql<{ finishedAt: Date | null }>`select "finishedAt" from job_run where id = ${late}::uuid`.execute(db);
    expect(run.finishedAt).toBeNull();
  });

  it('leaves an item of a library-owned execution as it was, so its run can still settle', async () => {
    const owner = await store.createRun('library', {});
    const keyed = (runId: string) => ({
      ...intent(runId, 'Thumbnail'),
      options: { deduplication: { id: 'thumbnail:library' } },
    });
    await store.enqueue([keyed(owner)]);
    const {
      rows: [{ id: jobId }],
    } = await sql<{ id: string }>`select id from job where "runId" = ${owner}::uuid`.execute(db);
    // The job is a library source producer: an ordinary run sharing it keeps its own outcome.
    const selectionId = randomUUID();
    await sql`insert into job_selection(id, "runId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state)
      values (${selectionId}::uuid, ${owner}::uuid, 'Thumbnail', ${queue}, true, false, 600000, 'ready')`.execute(db);
    await sql`insert into job_library_source_producer("selectionId", "producerId")
      values (${selectionId}::uuid, ${jobId}::uuid)`.execute(db);
    const alias = await store.createRun('alias', {});
    await sql`insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, state)
      values (${alias}::uuid, 'asset', 'asset', 'Thumbnail', ${queue}, '{}', 'completed')`.execute(db);

    await store.enqueue([keyed(alias)]);

    const {
      rows: [item],
    } = await sql<{ state: string }>`select state from job_run_item where "runId" = ${alias}::uuid`.execute(db);
    expect(item.state).toBe('completed');
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
