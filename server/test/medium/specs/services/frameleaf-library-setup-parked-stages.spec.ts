import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { IMPORT_DERIVED_RUN_STAGES, importDerivedRunId, insertRunJobs } from 'src/immich-import/derived-work.js';
import { LIBRARY_IMPORT_DERIVED_RUN_STAGES, libraryImportDerivedRunId } from 'src/library-import/derived-work.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { parseLibraryImportBinding } from 'src/library-import/state.js';
import { finishRuns } from 'src/queue/run-summary.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { type DB } from 'src/schema/index.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-1177: an import set up with machine learning off. After Library Care's file check, smart search and faces stay
 * held ("parked") instead of waiting for machine learning for good, so the run settles; switching machine learning on
 * later still processes those photos. FL-1265: holds are the run's `holds` and `availableAt = 'infinity'`. Synthetic
 * rows; the queue, run finishing and setup service are the real ones.
 */
let db: Kysely<DB>;
let store: SqlQueueStore;
const installation = '117700000001';
const setupKey = 'frameleaf-manager-library-setup:' + installation;
const STAGES = [
  [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration, {}],
  [JobName.SmartSearch, QueueName.SmartSearch, {}],
  [JobName.AssetDetectFaces, QueueName.FaceDetection, { preserveImportedFaces: true }],
] as const;
const ML = [JobName.AssetDetectFaces, JobName.SmartSearch];
const QUEUES = [...STAGES.map(([, queue]) => queue), QueueName.StorageTemplateMigration];

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

/** A started Manager import whose stages are inserted and held, waiting for the file check. */
const importRun = async (kind: string, assets: string[], state: Record<string, unknown> = {}) => {
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
      startedAt: new Date().toISOString(),
      paused: false,
    },
    // As first setup leaves it: the early stages run, the rest wait for the file check.
    holds: Object.fromEntries(
      stages
        .filter((stage) => stage !== JobName.AssetGenerateThumbnails && stage !== JobName.AssetExtractMetadata)
        .map((stage) => [stage, 'setup']),
    ),
  };
  await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES(${id}::uuid,${kind},
    ${JSON.stringify(selection)}::text::jsonb,true)`.execute(db);
  for (const [name, queue, data] of STAGES)
    await insertRunJobs(
      db,
      id,
      { queue, name, data, safeToRetry: true, sensitive: false, deadlineMs: 60_000 },
      db.selectNoFrom(sql<string>`unnest(${assets}::text[])`.as('id')),
    );
  // FL-414: an Immich import also holds its one identical-files item, which is not a photo.
  if (!library)
    await insertRunJobs(
      db,
      id,
      {
        queue: QueueName.StorageTemplateMigration,
        name: JobName.IdenticalFilesCheck,
        data: {},
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 60_000,
      },
      db.selectNoFrom(sql<string>`'identical-files'::text`.as('id')),
    );
  await sql`INSERT INTO system_metadata(key,value) VALUES(${setupKey},${JSON.stringify({
    installation,
    origin: 'new_import',
    phase: 'verifying',
    startedAt: new Date().toISOString(),
    processingChoiceApplied: true,
    importRunId: id,
    importOperationId: operationId,
    libraries: [],
    scans: {},
    health: {},
    owners: [],
    healthAfter: new Date().toISOString(),
    checkReleasedAt: null,
    failedBaseline: {},
    ...state,
  })}::text::jsonb)`.execute(db);
  return id;
};

const jobs = () => {
  const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  for (const [jobName, queueName] of [
    ...STAGES.map(([name, queue]) => [name, queue] as const),
    [JobName.AssetExtractMetadata, QueueName.MetadataExtraction] as const,
    [JobName.AssetEncodeVideo, QueueName.VideoConversion] as const,
    [JobName.PersonGenerateThumbnail, QueueName.ThumbnailGeneration] as const,
    [JobName.IdenticalFilesCheck, QueueName.StorageTemplateMigration] as const,
  ])
    repository['handlers'][jobName] = { jobName, queueName, handler: vi.fn(), label: 'synthetic setup' };
  // Only the import's queues are idle checks for setup here; unrelated fixtures never hold it.
  return Object.assign(repository, {
    getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }),
  });
};
const setup = (ml: { enabled: boolean }) =>
  new FrameleafLibrarySetupService(
    db,
    { getAll: vi.fn().mockResolvedValue([]) } as never,
    {} as never,
    jobs(),
    { hasAdmin: vi.fn().mockResolvedValue(true), getAdmin: vi.fn().mockResolvedValue({ id: randomUUID() }) } as never,
    { getNow: vi.fn().mockResolvedValue({ nowId: randomUUID() }) } as never,
    {} as never,
    {
      getAdminConfigWithRevision: vi.fn().mockImplementation(() =>
        Promise.resolve({
          config: {
            machineLearning: {
              enabled: ml.enabled,
              urls: [],
              clip: { enabled: true },
              facialRecognition: { enabled: true },
            },
          },
          revision: 'synthetic',
        }),
      ),
    } as never,
    { notifyCancellation: vi.fn() } as never,
  );

const holds = async (id: string) =>
  (await sql<{ holds: unknown }>`SELECT selection->'holds' AS holds FROM job_run WHERE id=${id}::uuid`.execute(db))
    .rows[0].holds;
const finishedAt = async (id: string) =>
  (await sql<{ finishedAt: Date | null }>`SELECT "finishedAt" FROM job_run WHERE id=${id}::uuid`.execute(db)).rows[0]
    .finishedAt;
/** The coordinator's sweep: apply holds, then finish runs with no live work. */
const sweep = async () => {
  while ((await store.reconcileHolds(1000)) > 0);
  await finishRuns(db, 10);
};
/** Run every job the queue lets start now, the way a worker would. */
const drain = async (queue: QueueName, worker: string) => {
  await sweep();
  const done = [];
  for (;;) {
    const claims = await store.claim(queue, worker);
    if (claims.length === 0) return done;
    for (const claim of claims) expect(await store.complete(claim, [])).toBe(true);
    done.push(...claims);
  }
};

it.each(['immich-import-derived', 'library-import-derived'])(
  'settles a %s run with machine learning off and processes it once machine learning is on',
  async (kind) => {
    const worker = randomUUID();
    await store.initialize(QUEUES, worker);
    const assets = [randomUUID(), randomUUID()];
    const id = await importRun(kind, assets);
    const ml = { enabled: false };

    // The file check ends (no libraries or owners to wait for): smart search and faces are parked.
    await setup(ml).status();
    expect(await holds(id)).toMatchObject({ [JobName.SmartSearch]: 'parked', [JobName.AssetDetectFaces]: 'parked' });
    expect(await holds(id)).not.toHaveProperty(JobName.AssetGenerateThumbnails);

    expect(await drain(QueueName.ThumbnailGeneration, worker)).toHaveLength(2);
    await drain(QueueName.StorageTemplateMigration, worker);
    expect(await drain(QueueName.SmartSearch, worker)).toEqual([]);
    expect(await drain(QueueName.FaceDetection, worker)).toEqual([]);
    // Parked work does not keep the run open.
    await sweep();
    expect(await finishedAt(id)).toEqual(expect.any(Date));
    await setup(ml).status(); // A later poll with nothing to do leaves it settled.
    expect(await finishedAt(id)).toEqual(expect.any(Date));

    // Machine learning switched on later: the next poll releases the parked stages and reopens the run.
    ml.enabled = true;
    await setup(ml).status();
    expect(await holds(id)).toEqual({});
    expect(await finishedAt(id)).toBeNull();
    const search = await drain(QueueName.SmartSearch, worker);
    const faces = await drain(QueueName.FaceDetection, worker);
    expect(search.map(({ data }) => data.id)).toEqual(expect.arrayContaining(assets));
    expect(search).toHaveLength(assets.length);
    expect(faces.map(({ data }) => data)).toEqual(
      expect.arrayContaining(assets.map((asset) => ({ id: asset, preserveImportedFaces: true }))),
    );
    await sweep();
    expect(await finishedAt(id)).toEqual(expect.any(Date));
  },
  30_000,
);

it('never parks a stage already released before machine learning was switched off', async () => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await importRun('immich-import-derived', [randomUUID()]);
  const ml = { enabled: true };
  await setup(ml).status(); // Released with machine learning on…
  expect(await holds(id)).toEqual({});
  ml.enabled = false; // …then switched off before it ran: its jobs wait for machine learning as before.
  await setup(ml).status();
  expect(await holds(id)).toEqual({});
  await drain(QueueName.ThumbnailGeneration, worker);
  await drain(QueueName.StorageTemplateMigration, worker);
  await sweep();
  expect(await finishedAt(id)).toBeNull();
});

it("keeps a parked stage's finished and failed photos in the run", async () => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await importRun('library-import-derived', [randomUUID(), randomUUID()]);
  const ml = { enabled: true };
  await setup(ml).status();
  await sweep();
  // Smart search runs for both photos, one of which fails for good…
  const [first] = await store.claim(QueueName.SmartSearch, worker, 1);
  expect(await store.complete(first, [])).toBe(true);
  const [second] = await store.claim(QueueName.SmartSearch, worker, 1);
  await sql`UPDATE job SET attempt="retryBaseAttempt"+2 WHERE id=${second.id}::uuid`.execute(db);
  expect(await store.fail(second, 'synthetic exhausted retry')).toBe(true);
  // …then the owner pauses, switches machine learning off and resumes: what is left of both stages is parked.
  ml.enabled = false;
  await setup(ml).setPaused(true);
  await setup(ml).setPaused(false);
  expect(await holds(id)).toEqual(Object.fromEntries(ML.map((stage) => [stage, 'parked'])));
  await drain(QueueName.ThumbnailGeneration, worker);
  await sweep();
  expect(await finishedAt(id)).toEqual(expect.any(Date));
  expect(
    (
      await sql<{ state: string }>`SELECT state FROM job WHERE "runId"=${id}::uuid AND name=${JobName.SmartSearch}
        ORDER BY state`.execute(db)
    ).rows.map(({ state }) => state),
  ).toEqual(['completed', 'failed']);
});

it('lets the owner dismiss a running setup: held stages start, the bar and phone step go away, Retry brings it back', async () => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const owner = randomUUID();
  await sql`WITH g AS (INSERT INTO cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO "user"(id,email,"clusterGroupId") SELECT ${owner}::uuid,'owner@example.test',id FROM g`.execute(db);
  // The owner's file check is still running: every stage that waits for it is held.
  const check = (
    await sql<{ id: string }>`INSERT INTO media_operation("ownerId",kind,status,destination,label,snapshot,settings)
      VALUES(${owner}::uuid,'media_health','rendering','local','Synthetic full check','{"mode":"scan"}'::jsonb,'{}'::jsonb)
      RETURNING id`.execute(db)
  ).rows[0].id;
  const id = await importRun('immich-import-derived', [randomUUID()], {
    owners: [owner],
    health: { [owner]: check },
    healthAfter: new Date(Date.now() - 60_000).toISOString(),
  });
  const service = setup({ enabled: true });
  await service.status();
  expect(await service.progress()).toMatchObject({ active: true, checkProblem: false });
  expect(await service.status()).toMatchObject({ setupRequired: true, canFinish: false });
  expect(await holds(id)).toMatchObject({ [JobName.SmartSearch]: 'setup' });

  await service.dismiss();
  expect(await holds(id)).toEqual({});
  expect(await drain(QueueName.SmartSearch, worker)).toHaveLength(1);
  expect(await service.progress()).toMatchObject({ active: false, stages: [] });
  expect(await service.status()).toMatchObject({ setupRequired: false, canFinish: true, dismissed: true });
  await service.dismiss(); // Again: nothing changes.
  expect(await service.progress()).toMatchObject({ active: false });

  await service.begin(true);
  const back = await service.progress();
  expect(back).toMatchObject({ active: true });
  // Dismissing released the stages, not the file check: brought back, the check is not reported finished.
  expect(back.stages.find(({ id }) => id === 'check')?.status).not.toBe('done');
  expect(await service.status()).toMatchObject({ setupRequired: true, dismissed: false });

  // A setup that finished while dismissed checks the library again when brought back.
  await service.dismiss();
  await sql`UPDATE system_metadata SET value=value || ${JSON.stringify({
    phase: 'complete',
    checkReleasedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })}::text::jsonb WHERE key=${setupKey}`.execute(db);
  expect(await service.progress()).toMatchObject({ active: false });
  await service.begin(true);
  expect(await service.progress()).toMatchObject({ active: true, phase: 'rescanning', completedAt: null });
});
