import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { importDerivedRunId } from 'src/immich-import/derived-work.js';
import { libraryImportDerivedRunId } from 'src/library-import/derived-work.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { parseLibraryImportBinding } from 'src/library-import/state.js';
import { freezeSelection } from 'src/queue/manifest.js';
import { listRunItems, listRuns } from 'src/queue/run-query.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { type DB } from 'src/schema/index.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-1177: an import set up with machine learning off. After Library Care's file check, smart search and faces stay
 * held instead of waiting for machine learning for good, so the run settles; switching machine learning on later
 * still processes those photos. Synthetic rows; the queue, run summary and setup service are the real ones.
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

/** A started Manager import whose stages are captured and held, waiting for the file check. */
const importRun = async (kind: string, assets: string[]) => {
  const operationId = randomUUID(),
    destinationId = randomUUID();
  const binding = parseLibraryImportBinding({
    operationId,
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    source: fixture.plan.source,
  });
  const source = { source: 'synthetic-source', config: 'synthetic-config' };
  const id =
    kind === 'library-import-derived'
      ? libraryImportDerivedRunId(binding)
      : importDerivedRunId(source.source, source.config);
  if (kind === 'immich-import-derived')
    await sql`INSERT INTO frameleaf_immich_import(source_fingerprint,config_fingerprint,source_version,status)
      VALUES(${source.source},${source.config},'synthetic','activated')`.execute(db);
  else
    await sql`INSERT INTO frameleaf_library_import(operation_id,binding,status,reviewed_manifest,reviewed_plan)
      VALUES(${operationId}::uuid,${JSON.stringify(binding)}::text::jsonb,'activated','{}'::jsonb,
        ${JSON.stringify({ destinationId })}::text::jsonb)`.execute(db);
  const selection = {
    ...(kind === 'library-import-derived' ? { ...binding, destinationId, version: 1, prepared: true } : source),
    managerSetupRequired: true,
    managerSetup: {
      installation,
      operationId,
      preparedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      paused: false,
    },
  };
  // Old enough that two quiet minutes would read as a stalled dispatcher.
  await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone","createdAt") VALUES(${id}::uuid,${kind},
    ${JSON.stringify(selection)}::text::jsonb,true,now()-interval '10 minutes')`.execute(db);
  for (const [name, queue, data] of STAGES)
    await freezeSelection(
      db,
      { queue, name, data, safeToRetry: true, sensitive: false, deadlineMs: 60_000 },
      db.selectNoFrom(sql<string>`unnest(${assets}::text[])`.as('id')),
      undefined,
      id,
      sql.lit('enumerating'),
    );
  // FL-414: an Immich import also holds its one identical-files item, which is not a photo.
  if (kind === 'immich-import-derived')
    await freezeSelection(
      db,
      {
        queue: QueueName.StorageTemplateMigration,
        name: JobName.IdenticalFilesCheck,
        data: {},
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 60_000,
      },
      db.selectNoFrom(sql<string>`'identical-files'::text`.as('id')),
      undefined,
      id,
      sql.lit('enumerating'),
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
  })}::text::jsonb)`.execute(db);
  return id;
};

const setup = (ml: { enabled: boolean }) =>
  new FrameleafLibrarySetupService(
    db,
    { getAll: vi.fn().mockResolvedValue([]) } as never,
    {} as never,
    {
      getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }),
      retryImportedWork: vi.fn(),
    } as never,
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
    {} as never,
  );

const selections = async (id: string) =>
  Object.fromEntries(
    (
      await sql<{
        stage: string;
        state: string;
      }>`SELECT stage,state FROM job_selection WHERE "runId"=${id}::uuid`.execute(db)
    ).rows.map(({ stage, state }) => [stage, state]),
  );
const header = async (id: string) =>
  (
    await sql<{ finishedAt: Date | null; parked: unknown }>`SELECT "finishedAt",
      selection #> '{managerSetup,parkedStages}' AS parked FROM job_run WHERE id=${id}::uuid`.execute(db)
  ).rows[0];
const summary = async (id: string) => (await listRuns(db, 1, 0, id))[0];
/** Feed and run every job the queue admits now, the way a worker would. */
const drain = async (queue: QueueName, worker: string) => {
  const done = [];
  for (;;) {
    await store.feedManifest(queue);
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
    const total = assets.length + (kind === 'immich-import-derived' ? 1 : 0);

    // Held for the file check: nothing to dispatch, so no stalled-dispatcher warning. Only photos count as held.
    expect(await summary(id)).toMatchObject({ total, held: 2, noDispatchBacklog: false, finishedAt: null });
    expect((await summary(id)).reasons).not.toContain('no_dispatch_backlog');

    // The file check ends (no libraries or owners to wait for): thumbnails start; smart search and faces stay parked.
    await setup(ml).status();
    expect(await selections(id)).toMatchObject({
      [JobName.AssetGenerateThumbnails]: 'ready',
      [JobName.SmartSearch]: 'enumerating',
      [JobName.AssetDetectFaces]: 'enumerating',
    });
    expect((await header(id)).parked).toEqual(ML);
    // The parked stages leave the summary: only the thumbnails' work is left, and nothing is held any more.
    expect(await summary(id)).toMatchObject({ total, held: 0, state: 'waiting', finishedAt: null });

    expect(await drain(QueueName.ThumbnailGeneration, worker)).toHaveLength(2);
    await drain(QueueName.StorageTemplateMigration, worker);
    expect(await drain(QueueName.SmartSearch, worker)).toEqual([]);
    expect(await drain(QueueName.FaceDetection, worker)).toEqual([]);
    // The queue alone cannot settle a run whose stages are still held; the setup poll can.
    expect((await header(id)).finishedAt).toBeNull();
    await setup(ml).status();
    expect((await header(id)).finishedAt).toEqual(expect.any(Date));
    const settled = await summary(id);
    expect(settled).toMatchObject({
      state: 'completed',
      total,
      completed: total,
      waiting: 0,
      held: 0,
      noDispatchBacklog: false,
      finishedAt: expect.any(Date),
    });
    expect(settled.reasons).toEqual([]);
    expect((await listRunItems(db, id, 25, 0))!.map(({ outcome }) => outcome)).toEqual(
      Array.from({ length: total }, () => 'completed'),
    );
    // Nothing waits for machine learning: no job was made for the parked stages.
    expect((await sql`SELECT 1 FROM job WHERE "runId"=${id}::uuid AND state<>'completed'`.execute(db)).rows).toEqual(
      [],
    );
    await setup(ml).status(); // A later poll with nothing to do leaves it settled.
    expect(await summary(id)).toMatchObject({ state: 'completed' });

    // Machine learning switched on later: the next poll releases the parked stages and reopens the run.
    ml.enabled = true;
    await setup(ml).status();
    expect(await selections(id)).toMatchObject({
      [JobName.AssetGenerateThumbnails]: 'ready',
      [JobName.SmartSearch]: 'ready',
      [JobName.AssetDetectFaces]: 'ready',
    });
    expect(await header(id)).toEqual({ finishedAt: null, parked: [] });
    expect(await summary(id)).toMatchObject({ state: 'waiting', total });
    const search = await drain(QueueName.SmartSearch, worker);
    const faces = await drain(QueueName.FaceDetection, worker);
    expect(search.map(({ data }) => data.id)).toEqual(expect.arrayContaining(assets));
    expect(search).toHaveLength(assets.length);
    expect(faces.map(({ data }) => data)).toEqual(
      expect.arrayContaining(assets.map((asset) => ({ id: asset, preserveImportedFaces: true }))),
    );
    expect(await summary(id)).toMatchObject({ state: 'completed', completed: total, finishedAt: expect.any(Date) });
  },
  30_000,
);

it('never parks a stage whose jobs are already waiting for machine learning', async () => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await importRun('immich-import-derived', [randomUUID()]);
  const ml = { enabled: true };
  await setup(ml).status(); // Released with machine learning on…
  expect((await header(id)).parked).toEqual([]);
  await store.feedManifest(QueueName.SmartSearch);
  const [claim] = await store.claim(QueueName.SmartSearch, worker, 1);
  expect(await store.defer(claim, 'workload-disabled')).toBe(true); // …then switched off before it ran.
  ml.enabled = false;
  await setup(ml).setPaused(true);
  await setup(ml).setPaused(false); // Resuming releases again, with machine learning now off.
  expect((await header(id)).parked).toEqual([JobName.AssetDetectFaces]);
  expect((await selections(id))[JobName.SmartSearch]).toBe('ready');
  await drain(QueueName.ThumbnailGeneration, worker);
  await drain(QueueName.StorageTemplateMigration, worker);
  await setup(ml).status();
  // The deferred search job still holds the run open, so it can run once machine learning is back.
  expect((await header(id)).finishedAt).toBeNull();
  expect(await summary(id)).toMatchObject({ state: 'blocked' });
  expect((await summary(id)).reasons).toContain('workload-disabled');
});

it("keeps a parked stage's finished and failed photos in the run", async () => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await importRun('library-import-derived', [randomUUID(), randomUUID()]);
  const ml = { enabled: true };
  await setup(ml).status();
  // Smart search runs for both photos, one of which fails for good…
  await store.feedManifest(QueueName.SmartSearch);
  const [first] = await store.claim(QueueName.SmartSearch, worker, 1);
  expect(await store.complete(first, [])).toBe(true);
  const [second] = await store.claim(QueueName.SmartSearch, worker, 1);
  await sql`UPDATE job SET attempt="retryBaseAttempt"+2 WHERE id=${second.id}::uuid`.execute(db);
  expect(await store.fail(second, 'synthetic exhausted retry')).toBe(true);
  // …then the owner pauses, switches machine learning off and resumes: smart search has nothing live left to park.
  ml.enabled = false;
  await setup(ml).setPaused(true);
  await setup(ml).setPaused(false);
  expect((await header(id)).parked).toEqual(ML);
  await drain(QueueName.ThumbnailGeneration, worker);
  await setup(ml).status();
  expect((await header(id)).finishedAt).toEqual(expect.any(Date));
  expect(await summary(id)).toMatchObject({ state: 'completed_with_errors', total: 2, completed: 1, failed: 1 });
  expect((await listRunItems(db, id, 25, 0))!.map(({ outcome }) => outcome).toSorted()).toEqual([
    'completed',
    'failed',
  ]);
});

it('reports a paused setup as paused while its last admitted job finishes', async () => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await importRun('library-import-derived', [randomUUID(), randomUUID()]);
  await setup({ enabled: true }).status();
  await store.feedManifest(QueueName.ThumbnailGeneration);
  const [active] = await store.claim(QueueName.ThumbnailGeneration, worker, 1);
  await setup({ enabled: true }).setPaused(true);
  expect(await summary(id)).toMatchObject({ state: 'paused', active: 1, held: 2 });
  expect(await store.complete(active, [])).toBe(true);
  expect(await summary(id)).toMatchObject({ state: 'paused', held: 2 });
});

it('counts nothing as held in a run that is not a Manager import', async () => {
  const id = randomUUID();
  await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES(${id}::uuid,'synthetic','{}'::jsonb,true)`.execute(
    db,
  );
  await freezeSelection(
    db,
    {
      queue: QueueName.SmartSearch,
      name: JobName.SmartSearch,
      data: {},
      safeToRetry: true,
      sensitive: false,
      deadlineMs: 60_000,
    },
    db.selectNoFrom(sql<string>`${randomUUID()}::text`.as('id')),
    undefined,
    id,
    sql.lit('enumerating'),
  );
  expect(await summary(id)).toMatchObject({ held: 0, total: 1 });
});

it('lets the owner dismiss a stopped setup: held stages start, the bar and phone step go away, Retry brings it back', async () => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const id = await importRun('immich-import-derived', [randomUUID()]);
  // The file check stopped for an owner it never finished: every stage that waits for it is still held.
  await sql`UPDATE system_metadata SET value=value || ${JSON.stringify({
    phase: 'needs-attention',
    owners: [randomUUID()],
  })}::text::jsonb WHERE key=${setupKey}`.execute(db);
  const service = setup({ enabled: true });
  expect(await service.progress()).toMatchObject({ active: true, phase: 'needs-attention' });
  expect(await service.status()).toMatchObject({ setupRequired: true, canFinish: false });

  await service.dismiss();
  expect(Object.values(await selections(id))).toEqual(Array.from({ length: 4 }, () => 'ready'));
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
