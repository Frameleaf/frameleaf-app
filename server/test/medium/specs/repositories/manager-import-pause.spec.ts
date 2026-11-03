import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { importDerivedRunId } from 'src/immich-import/derived-work.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { type DB } from 'src/schema/index.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { getKyselyDB } from 'test/utils.js';

// Synthetic queue admission only; these rows do not qualify a source or a canonical import.
let db: Kysely<DB>;
let store: SqlQueueStore;
const queue = QueueName.ThumbnailGeneration;
const installation = '114900000001';
const setupKey = 'frameleaf-manager-library-setup:' + installation;
beforeAll(async () => {
  db = await getKyselyDB();
  store = new SqlQueueStore(db);
});
beforeEach(async () => {
  vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', installation);
  vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', 'new_import');
  vi.stubEnv('FRAMELEAF_MANAGER_IMPORT_INSTALLATION', '');
  await sql`TRUNCATE job,job_run,job_queue,frameleaf_immich_import,frameleaf_library_import CASCADE`.execute(db);
  await sql`DELETE FROM system_metadata WHERE key LIKE 'frameleaf-manager-library-setup:%'`.execute(db);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await db?.destroy();
});
const run = async (kind: string, started: boolean) => {
  const id = randomUUID(),
    operationId = randomUUID(),
    destinationId = randomUUID();
  const binding = { operationId, manifestSha256: 'a'.repeat(64), planSha256: 'b'.repeat(64) };
  const source = { source: 'synthetic-source', config: 'synthetic-config' };
  const selection = {
    ...(kind === 'library-import-derived' ? { ...binding, destinationId, version: 1, prepared: true } : source),
    managerSetupRequired: true,
    managerSetup: {
      installation,
      operationId,
      preparedAt: new Date().toISOString(),
      startedAt: started ? new Date().toISOString() : null,
      paused: false,
    },
  };
  if (kind === 'immich-import-derived')
    await sql`INSERT INTO frameleaf_immich_import(source_fingerprint,config_fingerprint,source_version,status)
      VALUES(${source.source},${source.config},'synthetic','activated')`.execute(db);
  else if (kind === 'library-import-derived')
    await sql`INSERT INTO frameleaf_library_import(operation_id,binding,status,reviewed_manifest,reviewed_plan)
      VALUES(${operationId}::uuid,${JSON.stringify(binding)}::text::jsonb,'activated','{}'::jsonb,
        ${JSON.stringify({ destinationId })}::text::jsonb)`.execute(db);
  await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES(${id}::uuid,${kind},
    ${JSON.stringify(selection)}::text::jsonb,true)`.execute(db);
  await sql`INSERT INTO system_metadata(key,value) VALUES(${setupKey},
    ${JSON.stringify({ installation, origin: 'new_import', phase: 'rescanning', processingChoiceApplied: true, importRunId: id, importOperationId: operationId })}::text::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`.execute(db);
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
    expect(
      (await sql<{ count: number }>`SELECT count(*)::int AS count FROM job WHERE state='waiting'`.execute(db)).rows[0]
        .count,
    ).toBe(501);
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

for (const kind of ['immich-import-derived', 'library-import-derived'])
  it.each(['missing marker', 'installation', 'operation', 'source identity', 'attention', 'missing setup'])(
    `fences pending and waiting ${kind} work after invalidating %s`,
    async (corruption) => {
      const worker = randomUUID();
      await store.initialize([queue], worker);
      await sql`UPDATE job_queue SET concurrency=1 WHERE name=${queue}`.execute(db);
      const id = await run(kind, true);
      await enqueue(id, 503);
      const [active] = await store.claim(queue, worker, 1);
      expect(active?.runId).toBe(id);
      await enqueue(id);
      switch (corruption) {
        case 'missing marker': {
          await sql`UPDATE job_run SET selection=selection-'managerSetup' WHERE id=${id}::uuid`.execute(db);
          break;
        }
        case 'installation': {
          vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', '114900000002');
          break;
        }
        case 'operation': {
          await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,operationId}',to_jsonb(${randomUUID()}::text)) WHERE id=${id}::uuid`.execute(
            db,
          );
          break;
        }
        case 'source identity': {
          const field = kind === 'immich-import-derived' ? 'config' : 'planSha256';
          await sql`UPDATE job_run SET selection=jsonb_set(selection,ARRAY[${field}], '"changed"'::jsonb) WHERE id=${id}::uuid`.execute(
            db,
          );
          break;
        }
        case 'attention': {
          await sql`UPDATE system_metadata SET value=jsonb_set(value,'{phase}','"needs-attention"'::jsonb) WHERE key=${setupKey}`.execute(
            db,
          );
          break;
        }
        case 'missing setup': {
          await sql`DELETE FROM system_metadata WHERE key=${setupKey}`.execute(db);
          break;
        }
        default: {
          throw new Error('Unknown synthetic corruption');
        }
      }
      expect(await store.complete(active, [])).toBe(true);
      await enqueue();
      const claims = await store.claim(queue, worker, 1);
      expect(claims).toHaveLength(1);
      expect(claims[0].runId).toBeNull();
      expect(
        (
          await sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM job WHERE "runId"=${id}::uuid AND state='pending'`.execute(db)
        ).rows[0].count,
      ).toBeGreaterThan(0);
      expect(
        (
          await sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM job WHERE "runId"=${id}::uuid AND state='waiting'`.execute(db)
        ).rows[0].count,
      ).toBeGreaterThan(0);
    },
  );
it('backfills the independent fence before old marked work can lose its marker', async () => {
  const id = await run('immich-import-derived', true);
  await sql`UPDATE job_run SET selection=selection-'managerSetupRequired' WHERE id=${id}::uuid`.execute(db);
  const worker = randomUUID();
  await store.initialize([queue], worker);
  expect(
    (
      await sql<{
        required: boolean;
      }>`SELECT (selection->>'managerSetupRequired')::boolean AS required FROM job_run WHERE id=${id}::uuid`.execute(db)
    ).rows[0].required,
  ).toBe(true);
  await sql`UPDATE job_run SET selection=selection-'managerSetup' WHERE id=${id}::uuid`.execute(db);
  vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', '');
  vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', '');
  await enqueue(id);
  await enqueue();
  const claims = await store.claim(queue, worker, 1);
  expect(claims).toHaveLength(1);
  expect(claims[0].runId).toBeNull();
});
it.each(['immich-import-derived', 'library-import-derived'])('preserves genuine unmanaged %s work', async (kind) => {
  vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', '');
  vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', '');
  const worker = randomUUID();
  await store.initialize([queue], worker);
  const id = randomUUID();
  await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES(${id}::uuid,${kind},'{}'::jsonb,true)`.execute(
    db,
  );
  await enqueue(id);
  expect((await store.claim(queue, worker, 1))[0]?.runId).toBe(id);
});

it.each(['immich-import-derived', 'library-import-derived'])(
  'uses approved original authority after restoring %s to another installation',
  async (kind) => {
    const worker = randomUUID();
    await store.initialize([queue], worker);
    await sql`UPDATE job_queue SET concurrency=1 WHERE name=${queue}`.execute(db);
    const id = await run(kind, true);
    const original = (
      await sql<{ value: Record<string, unknown> }>`SELECT value FROM system_metadata WHERE key=${setupKey}`.execute(db)
    ).rows[0].value;
    const restored = '114900000002';
    vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', restored);
    vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', 'restored_library');
    vi.stubEnv('FRAMELEAF_MANAGER_IMPORT_INSTALLATION', installation);
    await sql`INSERT INTO system_metadata(key,value) VALUES(${'frameleaf-manager-library-setup:' + restored},
    ${JSON.stringify({ ...original, installation: restored, origin: 'restored_library', processingChoiceApplied: false })}::text::jsonb)`.execute(
      db,
    );
    await enqueue(id, 2);
    const [active] = await store.claim(queue, worker, 1);
    expect(active?.runId).toBe(id);
    expect(await store.complete(active, [])).toBe(true);
    vi.stubEnv('FRAMELEAF_MANAGER_IMPORT_INSTALLATION', '');
    await enqueue();
    const claims = await store.claim(queue, worker, 1);
    expect(claims).toHaveLength(1);
    expect(claims[0].runId).toBeNull();
  },
);

it('keeps the original bound operation when retry follows an identity failure', async () => {
  const worker = randomUUID(),
    operationId = randomUUID();
  const source = 'retry-source',
    config = 'retry-config';
  const id = importDerivedRunId(source, config);
  await store.initialize([queue], worker);
  await sql`UPDATE job_queue SET concurrency=1 WHERE name=${queue}`.execute(db);
  await sql`INSERT INTO frameleaf_immich_import(source_fingerprint,config_fingerprint,source_version,status)
    VALUES(${source},${config},'synthetic','activated')`.execute(db);
  const marker = {
    installation,
    operationId,
    preparedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    paused: false,
  };
  await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES(${id}::uuid,'immich-import-derived',
    ${JSON.stringify({ source, config, managerSetupRequired: true, managerSetup: marker })}::text::jsonb,true)`.execute(
    db,
  );
  await sql`INSERT INTO system_metadata(key,value) VALUES(${setupKey},${JSON.stringify({ installation, origin: 'new_import', phase: 'rescanning', startedAt: new Date().toISOString(), importRunId: id, importOperationId: operationId, processingChoiceApplied: true, libraries: [], scans: {}, health: {}, owners: [], healthAfter: null, revision: null, quietSince: null })}::text::jsonb)`.execute(
    db,
  );
  await enqueue(id, 2);
  const [active] = await store.claim(queue, worker, 1);
  expect(active?.runId).toBe(id);
  expect(await store.complete(active, [])).toBe(true);
  await enqueue(id);
  await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,operationId}',to_jsonb(${randomUUID()}::text)) WHERE id=${id}::uuid`.execute(
    db,
  );
  const setup = new FrameleafLibrarySetupService(
    db,
    { getAll: vi.fn().mockResolvedValue([]) } as never,
    {} as never,
    { getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }) } as never,
    { hasAdmin: vi.fn().mockResolvedValue(true) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  expect((await setup.status()).phase).toBe('needs-attention');
  await setup.begin(true);
  expect(
    (
      await sql<{
        run: string;
        operation: string;
      }>`SELECT value->>'importRunId' AS run,value->>'importOperationId' AS operation FROM system_metadata WHERE key=${setupKey}`.execute(
        db,
      )
    ).rows[0],
  ).toEqual({ run: id, operation: operationId });
  expect(await store.claim(queue, worker, 1)).toEqual([]);
});
