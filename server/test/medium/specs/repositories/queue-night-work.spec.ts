import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { SqlQueueStore } from 'src/queue/store.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1480: an overnight step waits for the work its own night queued, not for whatever else shares the queue. */
describe('night work', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  beforeEach(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    queue = `night-${randomUUID()}`;
    await store.initialize([queue], randomUUID());
  });
  afterEach(async () => {
    await db.destroy();
  });

  const night = '2026-10-21T00:00:00.000Z';
  const intent = (data: Record<string, unknown>, runId?: string) => ({
    queue,
    name: 'StorageTemplateMigrationSingle',
    data,
    safeToRetry: true,
    sensitive: false,
    deadlineMs: 600_000,
    ...(runId && { runId, itemKey: 'item', rootItemKey: 'item' }),
  });

  it('ignores work that is not the night’s, and another night’s', async () => {
    await store.enqueue([
      intent({ id: 'someone-else' }),
      intent({ id: 'last-night', _night: { startedAt: '2026-10-20T00:00:00.000Z', manual: false } }),
    ]);
    expect(await store.nightHasLiveWork(queue, night)).toBe(false);
  });

  it('sees a job the night queued, and one of a run the night opened', async () => {
    await store.enqueue([intent({ id: 'tidy-up', _night: { startedAt: night, manual: false } })]);
    expect(await store.nightHasLiveWork(queue, night)).toBe(true);

    await sql`delete from job where queue = ${queue}`.execute(db);
    const run = randomUUID();
    await sql`insert into job_run(id, kind, selection, "enumerationDone") values (${run}::uuid, 'test',
      ${JSON.stringify({ night: { startedAt: night, manual: false } })}::text::jsonb, true)`.execute(db);
    await store.enqueue([intent({ id: 'in-run' }, run)]);
    expect(await store.nightHasLiveWork(queue, night)).toBe(true);
  });
});
