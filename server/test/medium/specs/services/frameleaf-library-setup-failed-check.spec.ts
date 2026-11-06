import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { IMPORT_DERIVED_RUN_KIND, importDerivedRunId, insertRunJobs } from 'src/immich-import/derived-work.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { type DB } from 'src/schema/index.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-1265: the hold that kept 823K imported photos from processing. An old server put setup in needs-attention when an
 * account's full file check failed or was cancelled, and never released the stages that wait for the check. Now a check
 * that ended either way releases them, reports the problem, and the held jobs become claimable.
 */
let db: Kysely<DB>;
let store: SqlQueueStore;
const installation = '126500000001';
const setupKey = 'frameleaf-manager-library-setup:' + installation;
const STAGES = [
  [JobName.AssetExtractMetadata, QueueName.MetadataExtraction],
  [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration],
  [JobName.SmartSearch, QueueName.SmartSearch],
  [JobName.AssetDetectFaces, QueueName.FaceDetection],
  [JobName.PersonGenerateThumbnail, QueueName.ThumbnailGeneration],
  [JobName.IdenticalFilesCheck, QueueName.StorageTemplateMigration],
] as const;
const QUEUES = [...new Set(STAGES.map(([, queue]) => queue))];

beforeAll(async () => {
  db = await getKyselyDB();
  store = new SqlQueueStore(db);
});
beforeEach(async () => {
  vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', installation);
  vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', 'new_import');
  vi.stubEnv('FRAMELEAF_MANAGER_IMPORT_INSTALLATION', '');
  await sql`TRUNCATE job,job_run,job_queue,job_worker,frameleaf_immich_import,media_operation CASCADE`.execute(db);
  await sql`DELETE FROM system_metadata WHERE key LIKE 'frameleaf-manager-library-setup:%'`.execute(db);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await db?.destroy();
});

const user = async () => {
  const id = randomUUID();
  await sql`WITH g AS (INSERT INTO cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO "user"(id,email,"clusterGroupId") SELECT ${id}::uuid,${`${id}@example.test`},id FROM g`.execute(db);
  return id;
};
const fullCheck = async (ownerId: string, status: 'failed' | 'cancelled') =>
  (
    await sql<{ id: string }>`INSERT INTO media_operation("ownerId",kind,status,destination,label,snapshot,settings)
      VALUES(${ownerId}::uuid,'media_health',${status},'local','Synthetic full check','{"mode":"scan"}'::jsonb,'{}'::jsonb)
      RETURNING id`.execute(db)
  ).rows[0].id;
const claimable = async (queue: QueueName, worker: string) => {
  const all = [];
  for (;;) {
    const claims = await store.claim(queue, worker);
    if (claims.length === 0) return all;
    for (const claim of claims) expect(await store.complete(claim, [])).toBe(true);
    all.push(...claims);
  }
};

it('releases import work held behind a failed and a cancelled file check', async () => {
  const worker = randomUUID();
  await store.initialize(QUEUES, worker);
  const [first, second] = [await user(), await user()];
  const assets = [randomUUID(), randomUUID(), randomUUID()];
  const source = { source: 'synthetic-source', config: 'synthetic-config' };
  const id = importDerivedRunId(source.source, source.config);
  const operationId = randomUUID();
  await sql`INSERT INTO frameleaf_immich_import(source_fingerprint,config_fingerprint,source_version,status)
    VALUES(${source.source},${source.config},'synthetic','activated')`.execute(db);
  // What the upgrade leaves for a started import whose file check never released: the early stages run, the rest wait.
  const held = [
    JobName.SmartSearch,
    JobName.AssetDetectFaces,
    JobName.PersonGenerateThumbnail,
    JobName.IdenticalFilesCheck,
  ];
  await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES(${id}::uuid,${IMPORT_DERIVED_RUN_KIND},
    ${JSON.stringify({
      ...source,
      managerSetupRequired: true,
      managerSetup: {
        installation,
        operationId,
        preparedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        paused: false,
      },
      holds: Object.fromEntries(held.map((stage) => [stage, 'setup'])),
    })}::text::jsonb,true)`.execute(db);
  for (const [name, queue] of [STAGES[1], STAGES[2], STAGES[3]])
    await insertRunJobs(
      db,
      id,
      { queue, name, data: {}, safeToRetry: true, sensitive: false, deadlineMs: 60_000 },
      db.selectNoFrom(sql<string>`unnest(${assets}::text[])`.as('id')),
    );
  const healthAfter = new Date(Date.now() - 60_000).toISOString();
  const failed = await fullCheck(first, 'failed');
  const cancelled = await fullCheck(second, 'cancelled');
  await sql`INSERT INTO system_metadata(key,value) VALUES(${setupKey},${JSON.stringify({
    installation,
    origin: 'new_import',
    phase: 'needs-attention',
    startedAt: healthAfter,
    processingChoiceApplied: true,
    importRunId: id,
    importOperationId: operationId,
    libraries: [],
    scans: {},
    health: { [first]: failed, [second]: cancelled },
    owners: [first, second],
    healthAfter,
    checkReleasedAt: null,
    failedBaseline: {},
    revision: null,
    quietSince: null,
  })}::text::jsonb)`.execute(db);

  const jobs = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  for (const [jobName, queueName] of STAGES)
    jobs['handlers'][jobName] = { jobName, queueName, handler: vi.fn(), label: 'synthetic setup' };
  const setup = new FrameleafLibrarySetupService(
    db,
    { getAll: vi.fn().mockResolvedValue([]) } as never,
    {} as never,
    jobs,
    { hasAdmin: vi.fn().mockResolvedValue(true), getAdmin: vi.fn().mockResolvedValue({ id: first }) } as never,
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
    {} as never,
  );

  // Before: thumbnails run, smart search and faces stay held, whatever the queue does.
  expect(await claimable(QueueName.ThumbnailGeneration, worker)).toHaveLength(assets.length);
  expect(await claimable(QueueName.SmartSearch, worker)).toEqual([]);

  const status = await setup.status();
  expect(status.phase).not.toBe('needs-attention');
  expect(status.checkProblem).toBe(true);
  const progress = await setup.progress();
  expect(progress).toMatchObject({ active: true, checkProblem: true });
  expect(progress.stages.find((stage) => stage.id === 'check')).toMatchObject({ status: 'done' });
  expect(
    (await sql<{ holds: unknown }>`SELECT selection->'holds' AS holds FROM job_run WHERE id=${id}::uuid`.execute(db))
      .rows[0].holds,
  ).toEqual({});

  // The coordinator releases the held jobs after commit; then every one of them can be claimed.
  while ((await store.reconcileHolds(1000)) > 0);
  const search = await claimable(QueueName.SmartSearch, worker);
  const faces = await claimable(QueueName.FaceDetection, worker);
  expect(search.map((claim) => claim.itemKey)).toEqual(expect.arrayContaining(assets));
  expect(faces.map((claim) => claim.itemKey)).toEqual(expect.arrayContaining(assets));
  expect([search.length, faces.length]).toEqual([assets.length, assets.length]);
  expect([...search, ...faces].every((claim) => claim.runId === id)).toBe(true);
});
