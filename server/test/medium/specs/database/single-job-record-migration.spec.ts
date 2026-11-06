import { createMigrationProvider } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { getKyselyConfig } from 'src/utils/database.js';

const BEFORE = '1793930000000-AssetPaletteContentRevision';

/** FL-1265: an install upgraded mid-flight keeps its waiting and held work and the counts of finished runs. */
describe('SingleJobRecord migration', () => {
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  const name = `frameleaf_migration_${randomUUID().replaceAll('-', '')}`;
  let db: Kysely<any>;
  const migrator = () =>
    new Migrator({
      db,
      migrationTableName: 'frameleaf_migrations',
      migrationLockTableName: 'frameleaf_migrations_lock',
      provider: createMigrationProvider(fileURLToPath(new URL('../../../../src/schema/migrations/', import.meta.url)), {
        import: (path) => import(pathToFileURL(path).href),
      }),
    });

  beforeAll(async () => {
    const admin = postgres(new URL('/postgres', url).href, { max: 1 });
    try {
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`);
    } finally {
      await admin.end();
    }
    db = new Kysely(getKyselyConfig({ connectionType: 'url', url: new URL(`/${name}`, url).href }));
    expect((await migrator().migrateTo(BEFORE)).error).toBeUndefined();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('converts waiting and held work into jobs, keeps finished counts and drops the old ledger', async () => {
    const queue = 'thumbnailGeneration';
    const open = randomUUID();
    const imported = randomUUID();
    const finished = randomUUID();
    await sql`INSERT INTO job_queue(name, paused) VALUES (${queue}, true), ('quiet', true)`.execute(db);
    await sql`INSERT INTO system_metadata(key, value)
      VALUES ('overnight-sequence', '{"quiet":{"holding":["quiet"]}}'::jsonb)`.execute(db);
    await sql`INSERT INTO job_run(id, kind, selection, "enumerationDone") VALUES
      (${open}::uuid, 'AssetGenerateThumbnailsQueueAll', '{}', true),
      (${imported}::uuid, 'immich-import-derived', '{"managerSetup":{}}', true),
      (${finished}::uuid, 'AssetGenerateThumbnailsQueueAll', '{}', true)`.execute(db);
    await sql`UPDATE job_run SET "finishedAt" = now() WHERE id = ${finished}::uuid`.execute(db);
    const selections = { open: randomUUID(), imported: randomUUID(), finished: randomUUID() };
    await sql`INSERT INTO job_selection(id, "runId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state, "capturedAt")
      VALUES (${selections.open}::uuid, ${open}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'ready', now()),
        (${selections.imported}::uuid, ${imported}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'enumerating', now()),
        (${selections.finished}::uuid, ${finished}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'ready', now())`.execute(
      db,
    );
    const item = (runId: string, selectionId: string, key: string, state = 'pending') =>
      sql`(${runId}::uuid, ${key}, ${key}, 'AssetGenerateThumbnails', ${queue}, ${JSON.stringify({ id: key })}::text::jsonb,
        ${selectionId}::uuid, ${state})`;
    await sql`INSERT INTO job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "selectionId", state)
      VALUES ${sql.join([
        item(open, selections.open, 'a'),
        item(open, selections.open, 'b'),
        item(imported, selections.imported, 'c'),
        item(finished, selections.finished, 'd', 'completed'),
        item(finished, selections.finished, 'e', 'failed'),
      ])}`.execute(db);

    // History, as on a long-running server: the migration deletes what retention would and keeps the rest.
    const worker = randomUUID();
    const goneWorker = randomUUID();
    await sql`INSERT INTO job_worker(id, state, "heartbeatAt") VALUES
      (${worker}::uuid, 'lost', now() - interval '40 days'), (${goneWorker}::uuid, 'lost', now() - interval '40 days')`.execute(
      db,
    );
    const history = (key: string, state: string, age: string, extra = sql``) =>
      sql`INSERT INTO job(id, queue, name, data, state, "safeToRetry", "deadlineMs", "finishedAt", "itemKey", "runId", "parentId")
        SELECT gen_random_uuid(), ${queue}, 'AssetGenerateThumbnails', '{}', ${state}, true, 600000,
          now() - ${age}::interval, ${key}, NULL, NULL ${extra} RETURNING id`.execute(db);
    await history('old-done', 'completed', '8 days');
    await history('new-done', 'completed', '1 day');
    await history('old-failed', 'failed', '31 days');
    await history('new-failed', 'failed', '10 days');
    const [{ id: parent }] = (await history('old-parent', 'completed', '8 days')).rows as { id: string }[];
    await sql`INSERT INTO job(id, queue, name, data, state, "safeToRetry", "deadlineMs", "itemKey", "parentId")
      VALUES (gen_random_uuid(), ${queue}, 'AssetGenerateThumbnails', '{}', 'pending', true, 600000, 'child', ${parent}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO job(id, queue, name, data, state, "safeToRetry", "deadlineMs", "finishedAt", "itemKey", "runId")
      VALUES (gen_random_uuid(), ${queue}, 'AssetGenerateThumbnails', '{}', 'completed', true, 600000, now() - interval '8 days',
        NULL, ${open}::uuid)`.execute(db);
    const [{ id: stopped }] = (await history('old-stopped', 'completed', '8 days')).rows as { id: string }[];
    await sql`INSERT INTO job_attempt("jobId", attempt, token, "workerId", outcome, "finishedAt")
      VALUES (${stopped}::uuid, 1, gen_random_uuid(), ${worker}::uuid, 'stopped', now() - interval '8 days')`.execute(
      db,
    );
    const relfile = async () =>
      (await sql<{ node: string }>`SELECT relfilenode::text node FROM pg_class WHERE relname = 'job'`.execute(db))
        .rows[0].node;
    const before = await relfile();

    expect((await migrator().migrateToLatest()).error).toBeUndefined();

    const { rows: kept } = await sql<{ key: string | null }>`SELECT "itemKey" key FROM job
      WHERE "itemKey" IS NULL OR "itemKey" NOT IN ('a','b','c') ORDER BY "itemKey" NULLS FIRST`.execute(db);
    // the open run's job (no item key), recent history, a parent with a live child, a stopped attempt's evidence
    expect(kept.map(({ key }) => key)).toEqual([null, 'child', 'new-done', 'new-failed', 'old-parent', 'old-stopped']);
    const { rows: workers } = await sql<{ id: string }>`SELECT id FROM job_worker`.execute(db);
    expect(workers.map(({ id }) => id)).toEqual([worker]);
    expect(await relfile()).not.toBe(before);

    const { rows: jobs } = await sql<{ runId: string; itemKey: string; held: boolean; data: unknown }>`
      SELECT "runId", "itemKey", "availableAt" = 'infinity' held, data FROM job WHERE "itemKey" IN ('a','b','c') ORDER BY "itemKey"`.execute(
      db,
    );
    expect(jobs).toEqual([
      { runId: open, itemKey: 'a', held: false, data: { id: 'a' } },
      { runId: open, itemKey: 'b', held: false, data: { id: 'b' } },
      { runId: imported, itemKey: 'c', held: true, data: { id: 'c' } },
    ]);
    const { rows: runs } = await sql<{ id: string; selection: any; summary: any }>`
      SELECT id, selection, summary FROM job_run`.execute(db);
    const byId = Object.fromEntries(runs.map((run) => [run.id, run]));
    expect(byId[imported].selection).toMatchObject({
      holds: { AssetGenerateThumbnails: 'setup' },
      holdsDirty: true,
    });
    expect(byId[finished].summary).toMatchObject({
      complete: true,
      migrated: true,
      counts: { total: 2, completed: 1, failed: 1 },
      stageTotals: { total: 2, completed: 1, failed: 1 },
    });
    expect(byId[open].summary).toBeNull();

    const { rows: tables } = await sql<{ name: string }>`SELECT tablename name FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'job%' ORDER BY tablename`.execute(db);
    expect(tables.map(({ name }) => name)).toEqual(['job', 'job_attempt', 'job_queue', 'job_run', 'job_worker']);
    const { rows: queues } = await sql<{ name: string; paused: boolean; closedUntil: Date | null }>`
      SELECT name, paused, "closedUntil" FROM job_queue ORDER BY name`.execute(db);
    // only the pause quiet hours made is given back
    expect(queues).toEqual([
      { name: 'quiet', paused: false, closedUntil: null },
      { name: queue, paused: true, closedUntil: null },
    ]);
    const { rows: overnight } = await sql<{ holding: unknown }>`SELECT value #> '{quiet,holding}' holding
      FROM system_metadata WHERE key = 'overnight-sequence'`.execute(db);
    expect(overnight).toEqual([{ holding: null }]);
    await expect(migrator().migrateDown()).resolves.toMatchObject({ error: expect.any(Error) });
  });
});
