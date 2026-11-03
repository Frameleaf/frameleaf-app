import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { type DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

// Synthetic queue admission only; these rows do not qualify a source or a canonical import.
let db: Kysely<DB>;
let store: SqlQueueStore;
const queue = QueueName.ThumbnailGeneration;
beforeAll(async () => {
  db = await getKyselyDB();
  store = new SqlQueueStore(db);
});
beforeEach(async () => {
  await sql`TRUNCATE job,job_run,job_queue CASCADE`.execute(db);
});
afterAll(async () => {
  await db?.destroy();
});
const run = async (kind: string, started: boolean) => {
  const id = randomUUID();
  await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES(${id}::uuid,${kind},
    ${JSON.stringify({ managerSetup: { installation: '114900000001', operationId: randomUUID(), preparedAt: new Date().toISOString(), startedAt: started ? new Date().toISOString() : null, paused: false } })}::text::jsonb,true)`.execute(
    db,
  );
  return id;
};
const enqueue = (runId?: string, count = 1) =>
  store.enqueue(
    Array.from({ length: count }, () => ({
      queue,
      name: JobName.AssetGenerateThumbnails,
      data: { id: randomUUID() },
      safeToRetry: true,
      sensitive: false,
      deadlineMs: 60_000,
      ...(runId && { runId, itemKey: randomUUID() }),
    })),
  );

it.each(['immich-import-derived', 'library-import-derived'])(
  'pauses admitted %s work without starving other requests',
  async (kind) => {
    const worker = randomUUID();
    await store.initialize([queue], worker);
    await sql`UPDATE job_queue SET concurrency=1 WHERE name=${queue}`.execute(db);
    const id = await run(kind, true);
    await enqueue(id, 502);
    const [active] = await store.claim(queue, worker, 1);
    expect(active.runId).toBe(id);
    expect((await sql`SELECT count(*)::int AS count FROM job WHERE state='waiting'`.execute(db)).rows[0].count).toBe(
      501,
    );
    await db.transaction().execute(async (tx) => {
      await sql`SELECT name FROM job_queue ORDER BY name FOR NO KEY UPDATE`.execute(tx);
      await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,paused}','true'::jsonb) WHERE id=${id}::uuid`.execute(
        tx,
      );
      expect(await store.claim(queue, worker, 1)).toEqual([]);
    });
    expect(await store.complete(active, [])).toBe(true);
    await enqueue();
    const [other] = await store.claim(queue, worker, 1);
    expect(other?.runId).toBeNull();
    expect(await store.complete(other, [])).toBe(true);
    await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,paused}','false'::jsonb) WHERE id=${id}::uuid`.execute(
      db,
    );
    const [resumed] = await store.claim(queue, worker, 1);
    expect(resumed.runId).toBe(id);
  },
);

it.each(['immich-import-derived', 'library-import-derived'])(
  'keeps %s queued work held before its Manager acknowledgement',
  async (kind) => {
    const worker = randomUUID();
    await store.initialize([queue], worker);
    const id = await run(kind, false);
    await enqueue(id);
    await enqueue();
    const claims = await store.claim(queue, worker);
    expect(claims).toHaveLength(1);
    expect(claims[0].runId).toBeNull();
  },
);

it('preserves admission for unrelated run kinds carrying similarly named metadata', async () => {
  const worker = randomUUID();
  await store.initialize([queue], worker);
  const id = await run('synthetic-unrelated', false);
  await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,paused}','true'::jsonb) WHERE id=${id}::uuid`.execute(
    db,
  );
  await enqueue(id);
  expect((await store.claim(queue, worker, 1))[0].runId).toBe(id);
});
