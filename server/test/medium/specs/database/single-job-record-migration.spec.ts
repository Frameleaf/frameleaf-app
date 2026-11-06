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
  const prefix = `frameleaf_migration_${randomUUID().replaceAll('-', '')}`;
  const template = `${prefix}_before`;
  const databases: string[] = [];
  let db: Kysely<any>;
  const admin = async (statement: string) => {
    const client = postgres(new URL('/postgres', url).href, { max: 1 });
    try {
      await client.unsafe(statement);
    } finally {
      await client.end();
    }
  };
  const connect = (database: string) =>
    new Kysely<any>(getKyselyConfig({ connectionType: 'url', url: new URL(`/${database}`, url).href }));
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
    await admin(`CREATE DATABASE ${template} TEMPLATE template0`);
    db = connect(template);
    expect((await migrator().migrateTo(BEFORE)).error).toBeUndefined();
    await db.destroy();
  });
  // Every test upgrades its own copy of the database as it was before the migration.
  beforeEach(async () => {
    const name = `${prefix}_${databases.length}`;
    await admin(`CREATE DATABASE ${name} TEMPLATE ${template}`);
    databases.push(name);
    db = connect(name);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db?.destroy();
  });
  afterAll(async () => {
    for (const name of [...databases, template]) await admin(`DROP DATABASE IF EXISTS ${name}`);
  });

  it('converts waiting and held work into jobs, keeps finished counts and drops the old ledger', async () => {
    const queue = 'thumbnailGeneration';
    const open = randomUUID();
    const imported = randomUUID();
    const finished = randomUUID();
    // a Manager import fed before first setup started, and a library scan whose child item owns its execution
    const fed = randomUUID();
    const scan = randomUUID();
    await sql`INSERT INTO job_queue(name, paused) VALUES (${queue}, true), ('quiet', true)`.execute(db);
    await sql`INSERT INTO system_metadata(key, value)
      VALUES ('overnight-sequence', '{"quiet":{"holding":["quiet"]}}'::jsonb)`.execute(db);
    await sql`INSERT INTO job_run(id, kind, selection, "enumerationDone") VALUES
      (${open}::uuid, 'AssetGenerateThumbnailsQueueAll', '{}', true),
      (${imported}::uuid, 'immich-import-derived', '{"managerSetup":{}}', true),
      (${finished}::uuid, 'AssetGenerateThumbnailsQueueAll', '{}', true),
      (${fed}::uuid, 'library-import-derived', '{"managerSetup":{}}', true),
      (${scan}::uuid, 'library-scan', '{}', false)`.execute(db);
    await sql`UPDATE job_run SET "finishedAt" = now() WHERE id = ${finished}::uuid`.execute(db);
    const selections = {
      open: randomUUID(),
      imported: randomUUID(),
      finished: randomUUID(),
      fed: randomUUID(),
      scan: randomUUID(),
    };
    await sql`INSERT INTO job_selection(id, "runId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state, "capturedAt")
      VALUES (${selections.open}::uuid, ${open}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'ready', now()),
        (${selections.imported}::uuid, ${imported}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'enumerating', now()),
        (${selections.finished}::uuid, ${finished}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'ready', now()),
        (${selections.fed}::uuid, ${fed}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'ready', now())`.execute(
      db,
    );
    await sql`INSERT INTO job_selection(id, "runId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state,
        "sourceKind", "libraryOperationId")
      VALUES (${selections.scan}::uuid, ${scan}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'ready',
        'library-child', ${scan}::uuid)`.execute(db);
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
    const fedJob = randomUUID();
    await sql`INSERT INTO job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "selectionId", "jobId")
      VALUES (${fed}::uuid, 'f', 'f', 'AssetGenerateThumbnails', ${queue}, '{"id":"f"}', ${selections.fed}::uuid, ${fedJob}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO job(id, queue, name, data, "safeToRetry", "deadlineMs", "runId", "itemKey", "rootItemKey")
      VALUES (${fedJob}::uuid, ${queue}, 'AssetGenerateThumbnails', '{"id":"f"}', true, 600000, ${fed}::uuid, 'f', 'f')`.execute(
      db,
    );
    await sql`INSERT INTO job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "selectionId",
        "librarySourceKey", "libraryIntent", "libraryOriginComplete", "libraryExecutionRunId", "libraryExecutionItemKey")
      VALUES (${scan}::uuid, 'g', 'g', 'AssetGenerateThumbnails', ${queue}, '{"id":"g"}', ${selections.scan}::uuid,
        'source-g', '{"data":{"id":"g"}}', true, ${scan}::uuid, 'g')`.execute(db);

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
      WHERE "itemKey" IS NULL OR "itemKey" NOT IN ('a','b','c','f','g') ORDER BY "itemKey" NULLS FIRST`.execute(db);
    // the open run's job (no item key), recent history, a parent with a live child, a stopped attempt's evidence
    expect(kept.map(({ key }) => key)).toEqual([null, 'child', 'new-done', 'new-failed', 'old-parent', 'old-stopped']);
    const { rows: workers } = await sql<{ id: string }>`SELECT id FROM job_worker`.execute(db);
    expect(workers.map(({ id }) => id)).toEqual([worker]);
    expect(await relfile()).not.toBe(before);

    const { rows: jobs } = await sql<{ runId: string; itemKey: string; held: boolean; data: unknown }>`
      SELECT "runId", "itemKey", "availableAt" = 'infinity' held, data FROM job WHERE "itemKey" IN ('a','b','c','f','g') ORDER BY "itemKey"`.execute(
      db,
    );
    expect(jobs).toEqual([
      { runId: open, itemKey: 'a', held: false, data: { id: 'a' } },
      { runId: open, itemKey: 'b', held: false, data: { id: 'b' } },
      { runId: imported, itemKey: 'c', held: true, data: { id: 'c' } },
      { runId: fed, itemKey: 'f', held: true, data: { id: 'f' } },
      { runId: scan, itemKey: 'g', held: false, data: { id: 'g' } },
    ]);
    const { rows: runs } = await sql<{ id: string; selection: any; summary: any }>`
      SELECT id, selection, summary FROM job_run`.execute(db);
    const byId = Object.fromEntries(runs.map((run) => [run.id, run]));
    expect(byId[imported].selection).toMatchObject({
      holds: { AssetGenerateThumbnails: 'setup' },
      holdsDirty: true,
    });
    expect(byId[fed].selection).toMatchObject({ holds: { AssetGenerateThumbnails: 'setup' } });
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

  describe('a started Manager import', () => {
    const installation = '126500000001';
    /** `null`: Manager required setup, but its marker was never written. */
    const setup = async (markerInstallation: string | null) => {
      vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', installation);
      vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', 'new_import');
      vi.stubEnv('FRAMELEAF_MANAGER_IMPORT_INSTALLATION', '');
      const queue = 'thumbnailGeneration';
      const run = randomUUID();
      const selection = randomUUID();
      const operationId = randomUUID();
      const startedAt = new Date().toISOString();
      await sql`INSERT INTO job_queue(name) VALUES (${queue})`.execute(db);
      await sql`INSERT INTO frameleaf_immich_import(source_fingerprint, config_fingerprint, source_version, status)
        VALUES ('synthetic-source', 'synthetic-config', 'synthetic', 'activated')`.execute(db);
      await sql`INSERT INTO job_run(id, kind, selection, "enumerationDone") VALUES (${run}::uuid, 'immich-import-derived',
        ${JSON.stringify({
          source: 'synthetic-source',
          config: 'synthetic-config',
          managerSetupRequired: true,
          managerSetup:
            markerInstallation === null
              ? undefined
              : { installation: markerInstallation, operationId, preparedAt: startedAt, startedAt, paused: false },
        })}::text::jsonb, true)`.execute(db);
      await sql`INSERT INTO job_selection(id, "runId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state, "capturedAt")
        VALUES (${selection}::uuid, ${run}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'ready', now())`.execute(
        db,
      );
      const fed = randomUUID();
      await sql`INSERT INTO job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "selectionId", state, "jobId")
        VALUES (${run}::uuid, 'fed', 'fed', 'AssetGenerateThumbnails', ${queue}, '{"id":"fed"}', ${selection}::uuid, 'waiting', ${fed}::uuid),
          (${run}::uuid, 'unfed', 'unfed', 'AssetGenerateThumbnails', ${queue}, '{"id":"unfed"}', ${selection}::uuid, 'pending', NULL)`.execute(
        db,
      );
      await sql`INSERT INTO job(id, queue, name, data, "safeToRetry", "deadlineMs", "runId", "itemKey", "rootItemKey")
        VALUES (${fed}::uuid, ${queue}, 'AssetGenerateThumbnails', '{"id":"fed"}', true, 600000, ${run}::uuid, 'fed', 'fed')`.execute(
        db,
      );
      // The owner's server: setup stopped in needs-attention after a failed file check; setup itself releases that.
      await sql`INSERT INTO system_metadata(key, value) VALUES (${'frameleaf-manager-library-setup:' + installation},
        ${JSON.stringify({
          installation,
          origin: 'new_import',
          phase: 'needs-attention',
          processingChoiceApplied: true,
          importRunId: run,
          importOperationId: operationId,
        })}::text::jsonb)`.execute(db);

      expect((await migrator().migrateToLatest()).error).toBeUndefined();

      const { rows: jobs } = await sql<{
        itemKey: string;
        held: boolean;
      }>`SELECT "itemKey", "availableAt" = 'infinity' held
        FROM job WHERE "runId" = ${run}::uuid ORDER BY "itemKey"`.execute(db);
      const {
        rows: [{ selection: migrated }],
      } = await sql<{ selection: any }>`SELECT selection FROM job_run WHERE id = ${run}::uuid`.execute(db);
      return { jobs, selection: migrated };
    };

    it('stays held when its setup authority belongs to another installation', async () => {
      const { jobs, selection } = await setup('126500000002');
      expect(selection).toMatchObject({ holds: { AssetGenerateThumbnails: 'setup' }, holdsDirty: true });
      expect(jobs).toEqual([
        { itemKey: 'fed', held: true },
        { itemKey: 'unfed', held: true },
      ]);
    });

    it('stays held when setup is required but its marker is missing', async () => {
      const { jobs, selection } = await setup(null);
      expect(selection).toMatchObject({ holds: { AssetGenerateThumbnails: 'setup' }, holdsDirty: true });
      expect(jobs).toEqual([
        { itemKey: 'fed', held: true },
        { itemKey: 'unfed', held: true },
      ]);
    });

    it('is not held when its setup authority matches, even with setup in needs-attention', async () => {
      const { jobs, selection } = await setup(installation);
      expect(selection.holds).toBeUndefined();
      expect(jobs).toEqual([
        { itemKey: 'fed', held: false },
        { itemKey: 'unfed', held: false },
      ]);
    });
  });

  it('converts library work whose origin discovery had not finished, once, in the run that owns it', async () => {
    const queue = 'thumbnailGeneration';
    const [owner, other] = [randomUUID(), randomUUID()];
    const [ownerSelection, otherSelection] = [randomUUID(), randomUUID()];
    await sql`INSERT INTO job_queue(name) VALUES (${queue})`.execute(db);
    await sql`INSERT INTO job_run(id, kind, selection, "enumerationDone")
      VALUES (${owner}::uuid, 'library-scan', '{}', false), (${other}::uuid, 'library-scan', '{}', false)`.execute(db);
    await sql`INSERT INTO job_selection(id, "runId", stage, queue, "safeToRetry", sensitive, "deadlineMs", state,
        "sourceKind", "libraryOperationId")
      VALUES (${ownerSelection}::uuid, ${owner}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'ready',
          'library-child', ${owner}::uuid),
        (${otherSelection}::uuid, ${other}::uuid, 'AssetGenerateThumbnails', ${queue}, true, false, 600000, 'ready',
          'library-child', ${other}::uuid)`.execute(db);
    // An owner still discovering its origins and one that finished, each shared with the other scan's item.
    const item = (runId: string, selectionId: string, key: string, originComplete: boolean, executionRunId: string) =>
      sql`(${runId}::uuid, ${key}, ${key}, 'AssetGenerateThumbnails', ${queue}, ${JSON.stringify({ id: key })}::text::jsonb,
        ${selectionId}::uuid, ${`source-${key}`}, ${JSON.stringify({ data: { id: key } })}::text::jsonb, ${originComplete},
        ${executionRunId}::uuid, ${key})`;
    await sql`INSERT INTO job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "selectionId",
        "librarySourceKey", "libraryIntent", "libraryOriginComplete", "libraryExecutionRunId", "libraryExecutionItemKey")
      VALUES ${sql.join([
        item(owner, ownerSelection, 'incomplete', false, owner),
        item(owner, ownerSelection, 'complete', true, owner),
        item(other, otherSelection, 'incomplete', false, owner),
        item(other, otherSelection, 'complete', true, owner),
      ])}`.execute(db);

    expect((await migrator().migrateToLatest()).error).toBeUndefined();

    const { rows: jobs } = await sql<{ runId: string; itemKey: string; held: boolean; data: unknown }>`
      SELECT "runId", "itemKey", "availableAt" = 'infinity' held, data FROM job ORDER BY "itemKey"`.execute(db);
    expect(jobs).toEqual([
      { runId: owner, itemKey: 'complete', held: false, data: { id: 'complete' } },
      { runId: owner, itemKey: 'incomplete', held: false, data: { id: 'incomplete' } },
    ]);
  });
});
