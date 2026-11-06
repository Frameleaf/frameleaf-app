import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { IMPORT_DERIVED_RUN_STAGES, importDerivedRunId, insertRunJobs } from 'src/immich-import/derived-work.js';
import { LIBRARY_IMPORT_DERIVED_RUN_STAGES, libraryImportDerivedRunId } from 'src/library-import/derived-work.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { parseLibraryImportBinding } from 'src/library-import/state.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { type DB } from 'src/schema/index.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-1265: Manager's import work is held by `availableAt = 'infinity'`, set from the run's holds, which setup recomputes:
 * nothing before first setup, a pause holds what has not started, Resume in Jobs wins for its queue, a Release from Jobs
 * wins over an older pause, and dismissing releases everything. Synthetic rows; the queue and setup service are real.
 */
let db: Kysely<DB>;
let store: SqlQueueStore;
const installation = '114900000001';
const setupKey = 'frameleaf-manager-library-setup:' + installation;
const QUEUES = [QueueName.ThumbnailGeneration, QueueName.SmartSearch];
const HANDLERS = [
  [JobName.AssetExtractMetadata, QueueName.MetadataExtraction],
  [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration],
  [JobName.SmartSearch, QueueName.SmartSearch],
  [JobName.AssetDetectFaces, QueueName.FaceDetection],
  [JobName.AssetEncodeVideo, QueueName.VideoConversion],
  [JobName.PersonGenerateThumbnail, QueueName.ThumbnailGeneration],
  [JobName.IdenticalFilesCheck, QueueName.StorageTemplateMigration],
] as const;
const KINDS = ['immich-import-derived', 'library-import-derived'];

beforeAll(async () => {
  db = await getKyselyDB();
  store = new SqlQueueStore(db);
});
beforeEach(async () => {
  vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', installation);
  vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', 'new_import');
  vi.stubEnv('FRAMELEAF_MANAGER_IMPORT_INSTALLATION', '');
  await sql`TRUNCATE job,job_run,job_queue,job_worker,frameleaf_immich_import,frameleaf_library_import CASCADE`.execute(
    db,
  );
  await sql`DELETE FROM system_metadata WHERE key LIKE 'frameleaf-manager-library-setup:%'`.execute(db);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await db?.destroy();
});

const jobs = () => {
  const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  for (const [jobName, queueName] of HANDLERS)
    repository['handlers'][jobName] = { jobName, queueName, handler: vi.fn(), label: 'synthetic setup' };
  return repository;
};
const service = (repository = jobs()) =>
  new FrameleafLibrarySetupService(
    db,
    { getAll: vi.fn().mockResolvedValue([]) } as never,
    {} as never,
    repository,
    { hasAdmin: vi.fn().mockResolvedValue(true), getAdmin: vi.fn().mockResolvedValue({ id: randomUUID() }) } as never,
    { getNow: vi.fn().mockResolvedValue({ nowId: randomUUID() }) } as never,
    {} as never,
    {
      getAdminConfigWithRevision: vi.fn().mockResolvedValue({
        config: {
          machineLearning: { enabled: true, urls: [], clip: { enabled: true }, facialRecognition: { enabled: true } },
        },
        revision: 'synthetic',
      }),
    } as never,
    { notifyCancellation: vi.fn() } as never,
  );

/** A prepared, activated Manager import with thumbnails and smart search for `assets`, held as preparation leaves it. */
const run = async (kind: string, started: boolean, assets: string[], state: Record<string, unknown> = {}) => {
  const operationId = randomUUID(),
    destinationId = randomUUID();
  const binding = parseLibraryImportBinding({
    operationId,
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    source: fixture.plan.source,
  });
  const source = { source: 'synthetic-source', config: 'synthetic-config' };
  const library = kind === 'library-import-derived';
  const id = library ? libraryImportDerivedRunId(binding) : importDerivedRunId(source.source, source.config);
  const stages: readonly string[] = library ? LIBRARY_IMPORT_DERIVED_RUN_STAGES : IMPORT_DERIVED_RUN_STAGES;
  if (library)
    await sql`INSERT INTO frameleaf_library_import(operation_id,binding,status,reviewed_manifest,reviewed_plan)
      VALUES(${operationId}::uuid,${JSON.stringify(binding)}::text::jsonb,'activated','{}'::jsonb,
        ${JSON.stringify({ destinationId })}::text::jsonb)`.execute(db);
  else
    await sql`INSERT INTO frameleaf_immich_import(source_fingerprint,config_fingerprint,source_version,status)
      VALUES(${source.source},${source.config},'synthetic','activated')`.execute(db);
  const selection = {
    ...(library ? { ...binding, destinationId, version: 1, prepared: true } : source),
    managerSetupRequired: true,
    managerSetup: {
      installation,
      operationId,
      preparedAt: new Date().toISOString(),
      startedAt: started ? new Date().toISOString() : null,
      paused: false,
    },
    holds: Object.fromEntries(stages.map((stage) => [stage, 'setup'])),
  };
  await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES(${id}::uuid,${kind},
    ${JSON.stringify(selection)}::text::jsonb,true)`.execute(db);
  for (const [name, queue] of [HANDLERS[1], HANDLERS[2]])
    await insertRunJobs(
      db,
      id,
      { queue, name, data: {}, safeToRetry: true, sensitive: false, deadlineMs: 60_000 },
      db.selectNoFrom(sql<string>`unnest(${assets}::text[])`.as('id')),
    );
  await sql`INSERT INTO system_metadata(key,value) VALUES(${setupKey},${JSON.stringify({
    installation,
    origin: 'new_import',
    phase: 'rescanning',
    startedAt: new Date().toISOString(),
    processingChoiceApplied: true,
    importRunId: id,
    importOperationId: operationId,
    libraries: [],
    scans: {},
    health: {},
    owners: [],
    healthAfter: null,
    revision: null,
    quietSince: null,
    checkReleasedAt: null,
    ...state,
  })}::text::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`.execute(db);
  return id;
};
const holds = async (id: string) =>
  (await sql<{ holds: unknown }>`SELECT selection->'holds' AS holds FROM job_run WHERE id=${id}::uuid`.execute(db))
    .rows[0].holds;
/** What each queue would run now, after the coordinator applied the run's holds. */
const claimable = async (worker: string) => {
  while ((await store.reconcileHolds(1000)) > 0);
  const result: Record<string, number> = {};
  for (const queue of QUEUES) {
    result[queue] = 0;
    for (;;) {
      const claims = await store.claim(queue, worker);
      if (claims.length === 0) break;
      for (const claim of claims) expect(await store.complete(claim, [])).toBe(true);
      result[queue] += claims.length;
    }
  }
  return result;
};

it.each(KINDS)('holds %s work until first setup starts, then runs the early stages', async (kind) => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await run(kind, false, [randomUUID(), randomUUID()]);
  expect(await claimable(worker)).toEqual({ [QueueName.ThumbnailGeneration]: 0, [QueueName.SmartSearch]: 0 });
  await service().begin();
  expect(await holds(id)).not.toHaveProperty(JobName.AssetGenerateThumbnails);
  expect(await holds(id)).toMatchObject({ [JobName.SmartSearch]: 'setup' });
  expect(await claimable(worker)).toEqual({ [QueueName.ThumbnailGeneration]: 2, [QueueName.SmartSearch]: 0 });
});

it.each(KINDS)('pauses unstarted %s work while running jobs finish, and resumes it', async (kind) => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  await sql`UPDATE job_queue SET concurrency=1 WHERE name=${QueueName.ThumbnailGeneration}`.execute(db);
  const id = await run(kind, true, [randomUUID(), randomUUID(), randomUUID()], {
    checkReleasedAt: new Date().toISOString(),
  });
  const setup = service();
  await setup.begin();
  while ((await store.reconcileHolds(1000)) > 0);
  const [active] = await store.claim(QueueName.ThumbnailGeneration, worker, 1);
  expect(active.runId).toBe(id);
  vi.spyOn(setup, 'progress').mockResolvedValue({} as never);
  await setup.setPaused(true);
  expect(await holds(id)).toMatchObject({
    [JobName.AssetGenerateThumbnails]: 'paused',
    [JobName.SmartSearch]: 'paused',
  });
  expect(await store.complete(active, [])).toBe(true);
  // Other work in the same queue is never starved by the held import.
  await store.enqueue([
    {
      queue: QueueName.ThumbnailGeneration,
      name: JobName.AssetGenerateThumbnails,
      data: { id: randomUUID() },
      safeToRetry: true,
      sensitive: false,
      deadlineMs: 60_000,
    },
  ]);
  const before = await claimable(worker);
  expect(before).toEqual({ [QueueName.ThumbnailGeneration]: 1, [QueueName.SmartSearch]: 0 });
  await setup.setPaused(false);
  expect(await holds(id)).toEqual({});
  // The two thumbnails that never started, and every smart search.
  expect(await claimable(worker)).toEqual({ [QueueName.ThumbnailGeneration]: 2, [QueueName.SmartSearch]: 3 });
});

it.each(KINDS)('lets a queue resumed in Jobs run its %s work while setup stays paused', async (kind) => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await run(kind, true, [randomUUID()], { checkReleasedAt: new Date().toISOString() });
  const setup = service();
  vi.spyOn(setup, 'progress').mockResolvedValue({} as never);
  await setup.setPaused(true);
  expect(await claimable(worker)).toEqual({ [QueueName.ThumbnailGeneration]: 0, [QueueName.SmartSearch]: 0 });
  await setup.onQueueResumed({ queue: QueueName.SmartSearch });
  expect(await holds(id)).toMatchObject({ [JobName.AssetGenerateThumbnails]: 'paused' });
  expect(await holds(id)).not.toHaveProperty(JobName.SmartSearch);
  expect(await claimable(worker)).toEqual({ [QueueName.ThumbnailGeneration]: 0, [QueueName.SmartSearch]: 1 });
  // A poll keeps the override; pausing setup again takes it back.
  await setup.begin();
  expect(await holds(id)).not.toHaveProperty(JobName.SmartSearch);
  await setup.setPaused(false);
  await setup.setPaused(true);
  expect(await holds(id)).toMatchObject({ [JobName.SmartSearch]: 'paused' });
});

it.each(KINDS)('never re-holds %s work released from Jobs after a pause', async (kind) => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await run(kind, true, [randomUUID()]);
  const setup = service();
  vi.spyOn(setup, 'progress').mockResolvedValue({} as never);
  await setup.setPaused(true);
  // What Jobs' Release writes (JobRepository.releaseRun).
  await sql`UPDATE job_run SET selection=selection || jsonb_build_object('releasedAt',clock_timestamp(),'holds','{}'::jsonb,
    'holdsDirty',true) WHERE id=${id}::uuid`.execute(db);
  await setup.begin();
  expect(await holds(id)).toEqual({});
  expect(await claimable(worker)).toEqual({ [QueueName.ThumbnailGeneration]: 1, [QueueName.SmartSearch]: 1 });
});

it.each(KINDS)('releases every %s stage when setup is dismissed, paused or not', async (kind) => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await run(kind, true, [randomUUID()]);
  const setup = service();
  vi.spyOn(setup, 'progress').mockResolvedValue({} as never);
  await setup.setPaused(true);
  await setup.dismiss();
  expect(await holds(id)).toEqual({});
  expect(await claimable(worker)).toEqual({ [QueueName.ThumbnailGeneration]: 1, [QueueName.SmartSearch]: 1 });
});

it('leaves other runs alone, including ones carrying similarly named metadata', async () => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  await run('immich-import-derived', true, [randomUUID()]);
  const other = randomUUID();
  await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES(${other}::uuid,'synthetic-unrelated',
    ${JSON.stringify({ managerSetup: { installation, paused: true }, holds: { [JobName.SmartSearch]: 'paused' } })}::text::jsonb,
    true)`.execute(db);
  const setup = service();
  vi.spyOn(setup, 'progress').mockResolvedValue({} as never);
  await setup.setPaused(true);
  await setup.setPaused(false);
  expect(await holds(other)).toEqual({ [JobName.SmartSearch]: 'paused' });
});

it('keeps the original bound operation and its holds when retry follows an identity failure', async () => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await run('immich-import-derived', true, [randomUUID()]);
  const operationId = (
    await sql<{ operation: string }>`SELECT value->>'importOperationId' AS operation FROM system_metadata
      WHERE key=${setupKey}`.execute(db)
  ).rows[0].operation;
  const before = await holds(id);
  await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,operationId}',to_jsonb(${randomUUID()}::text)) WHERE id=${id}::uuid`.execute(
    db,
  );
  const setup = service();
  const status = await setup.status();
  expect(status.phase).toBe('needs-attention');
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
  expect(await holds(id)).toEqual(before);
  expect(await claimable(worker)).toEqual({ [QueueName.ThumbnailGeneration]: 0, [QueueName.SmartSearch]: 0 });
});

it.each(KINDS)('retries safe failed %s work through the common setup action', async (kind) => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const queue = QueueName.ThumbnailGeneration;
  await sql`UPDATE job_queue SET concurrency=1 WHERE name=${queue}`.execute(db);
  const id = await run(kind, true, [], { checkReleasedAt: new Date().toISOString() });
  const setup = service();
  await setup.begin();
  await store.enqueue([
    {
      queue,
      name: JobName.AssetGenerateThumbnails,
      data: { id: randomUUID() },
      safeToRetry: true,
      sensitive: false,
      deadlineMs: 60_000,
      runId: id,
      itemKey: 'retried',
    },
  ]);
  const [active] = await store.claim(queue, worker, 1);
  expect(active?.runId).toBe(id);
  await store.enqueue([
    {
      queue,
      name: JobName.AssetGenerateThumbnails,
      data: { id: randomUUID() },
      safeToRetry: true,
      sensitive: false,
      deadlineMs: 60_000,
      runId: id,
      itemKey: 'blocked-child',
      parentId: active.id,
    },
  ]);
  await sql`UPDATE job SET attempt="retryBaseAttempt"+2 WHERE id=${active.id}::uuid`.execute(db);
  expect(await store.fail(active, 'synthetic exhausted retry')).toBe(true);
  expect(
    (await sql<{ state: string }>`SELECT state FROM job WHERE "parentId"=${active.id}::uuid`.execute(db)).rows[0].state,
  ).toBe('blocked');
  const controls = [
    { key: 'unrelated', runId: undefined, state: 'failed', safeToRetry: true, data: {} },
    { key: 'unsafe', runId: id, state: 'failed', safeToRetry: false, data: {} },
    { key: 'unconfirmed', runId: id, state: 'needs_attention', safeToRetry: true, data: {} },
    { key: 'cancelled', runId: id, state: 'cancelled', safeToRetry: true, data: {} },
    { key: 'domain', runId: id, state: 'failed', safeToRetry: true, data: { operationId: randomUUID() } },
  ];
  for (const control of controls) {
    await store.enqueue([
      {
        queue,
        name: JobName.AssetGenerateThumbnails,
        data: { ...control.data, id: control.key },
        safeToRetry: control.safeToRetry,
        sensitive: false,
        deadlineMs: 60_000,
        runId: control.runId,
        itemKey: control.key,
      },
    ]);
    await sql`UPDATE job SET state=${control.state},"finishedAt"=now() WHERE data->>'id'=${control.key}`.execute(db);
  }
  // A file check that ended early is what Retry is for now; setup is not stopped by it.
  await sql`UPDATE system_metadata SET value=jsonb_set(value,'{checkProblem}','true'::jsonb) WHERE key=${setupKey}`.execute(
    db,
  );
  await setup.begin(true);
  for (const control of controls)
    expect(
      (await sql<{ state: string }>`SELECT state FROM job WHERE data->>'id'=${control.key}`.execute(db)).rows[0].state,
    ).toBe(control.state);
  const [retry] = await store.claim(queue, worker, 1);
  expect(retry?.id).toBe(active.id);
  expect(await store.complete(retry, [])).toBe(true);
  const [child] = await store.claim(queue, worker, 1);
  expect(child?.itemKey).toBe('blocked-child');
  expect(await store.complete(child, [])).toBe(true);
});
