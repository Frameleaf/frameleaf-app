import { Kysely, KyselyPlugin, RawNode, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaults, mapAdminConfig } from 'src/dtos/config.dto.js';
import { JobName, QueueName } from 'src/enum.js';
import { digest } from 'src/immich-import/adapters.js';
import { IMPORT_DERIVED_STAGES, importDerivedRunId } from 'src/immich-import/derived-work.js';
import { assertImmichImportActivated } from 'src/immich-import/state.js';
import { ImportConfig } from 'src/immich-import/types.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_BATCH, QueueClaim } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { SCALE_ITEMS, scaleIt } from 'test/medium/scale.js';
import { PostgresImportFixture } from 'test/medium/specs/immich-import/postgres-transport.fixture.js';
import { getKyselyDB } from 'test/utils.js';

const queues = [
  QueueName.MetadataExtraction,
  QueueName.ThumbnailGeneration,
  QueueName.SmartSearch,
  QueueName.FaceDetection,
];
const repositoryFor = (db: Kysely<any>) => {
  const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  for (const [index, [, name]] of IMPORT_DERIVED_STAGES.entries()) {
    repository['handlers'][name] = {
      queueName: queues[index],
      jobName: name,
      label: 'import fixture',
      handler: vi.fn(),
    };
  }
  repository['handlers'][JobName.PersonGenerateThumbnail] = {
    queueName: QueueName.ThumbnailGeneration,
    jobName: JobName.PersonGenerateThumbnail,
    label: 'import person fixture',
    handler: vi.fn(),
  };
  repository['handlers'][JobName.IdenticalFilesCheck] = {
    queueName: QueueName.StorageTemplateMigration,
    jobName: JobName.IdenticalFilesCheck,
    label: 'import identical files fixture',
    handler: vi.fn(),
  };
  return repository;
};

/** Real SQL still runs; faults model a lost acknowledgement after an earlier committed transaction. */
const observe = (
  options: {
    beforeAcknowledgement?: (number: number) => void;
    beforeInsert?: (number: number) => void;
    afterCapture?: () => void;
  } = {},
) => {
  let acknowledgement = 0;
  let captures = 0;
  let maximumRows = 0;
  const plugin: KyselyPlugin = {
    transformQuery: ({ node }) => {
      const statement = node.kind === 'RawNode' ? (node as RawNode).sqlFragments.join(' ') : '';
      if (statement.startsWith('update frameleaf_immich_import_work w'))
        options.beforeAcknowledgement?.(++acknowledgement);
      if (statement.startsWith('insert into job(')) options.beforeInsert?.(++captures);
      // This next read happens after every stage's insert has committed.
      if (statement.startsWith('select asset_id, kind from frameleaf_immich_import_work')) options.afterCapture?.();
      return node;
    },
    transformResult: ({ result }) => {
      maximumRows = Math.max(maximumRows, result.rows.length);
      return Promise.resolve(result);
    },
  };
  return { plugin, maximumRows: () => maximumRows };
};

afterEach(() => vi.unstubAllEnvs());

/** FL-414: the import's one identical-files item; the per-asset counts below leave it out. */
const IDENTICAL = JobName.IdenticalFilesCheck;

describe('offline import derived-work durable ownership', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let repository: JobRepository;
  const runId = importDerivedRunId('source-fixture', 'configuration-fixture');
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  beforeEach(async () => {
    await sql`truncate job, job_run, job_queue, job_worker, frameleaf_immich_import, frameleaf_immich_import_work cascade`.execute(
      db,
    );
    await sql`insert into frameleaf_immich_import(source_fingerprint, config_fingerprint, source_version, status)
      values ('source-fixture', 'configuration-fixture', '3.2.4', 'verifying')`.execute(db);
    store = new SqlQueueStore(db);
    repository = repositoryFor(db);
  });
  afterAll(async () => db?.destroy());
  const seed = async (count: number) => {
    await sql`insert into frameleaf_immich_import_work(asset_id, kind)
      select md5(n::text)::uuid, kind from generate_series(1, ${count}) n
      cross join unnest(${IMPORT_DERIVED_STAGES.map(([kind]) => kind)}::text[]) kind`.execute(db);
  };
  /** FL-1265: the import's work is its jobs; `held` counts those waiting for setup (`availableAt = 'infinity'`). */
  const counts = async () =>
    (
      await sql<{
        runs: number;
        roots: number;
        jobs: number;
        held: number;
        acknowledged: number;
        pending: number;
      }>`select (select count(*)::int from job_run) runs,
    (select count(distinct "rootItemKey")::int from job where name <> ${IDENTICAL}) roots,
    (select count(*)::int from job where name <> ${IDENTICAL}) jobs,
    (select count(*)::int from job where "availableAt" = 'infinity') held,
    (select count(*)::int from frameleaf_immich_import_work where dispatched_at is not null) acknowledged,
    (select count(*)::int from frameleaf_immich_import_work where dispatched_at is null) pending`.execute(db)
    ).rows[0];
  const holds = async () =>
    (await sql<{ holds: unknown }>`select selection->'holds' as holds from job_run`.execute(db)).rows[0]?.holds;

  it('transfers once into one job per asset and stage, plus people thumbnails and identical files', async () => {
    await seed(2);
    expect(await repository.dispatchImportedWork()).toBe(runId);
    expect(await counts()).toEqual({ runs: 1, roots: 2, jobs: 8, held: 0, acknowledged: 8, pending: 0 });
    expect(await repositoryFor(db).dispatchImportedWork()).toBe(runId);
    expect((await counts()).jobs).toBe(8);
    expect((await sql`select "enumerationDone", selection ? 'holds' as held from job_run`.execute(db)).rows).toEqual([
      { enumerationDone: true, held: false },
    ]);
    // FL-414: the identical-files item is inserted with the import run and runs with it
    expect(
      (
        await sql`select queue, "itemKey", "rootItemKey", data, "availableAt" <= now() as ready from job
        where name = ${IDENTICAL}`.execute(db)
      ).rows,
    ).toEqual([
      {
        queue: QueueName.StorageTemplateMigration,
        itemKey: 'identical-files',
        rootItemKey: 'identical-files',
        data: { id: 'identical-files', importRunId: runId },
        ready: true,
      },
    ]);
  });

  const managerConfig = (): ImportConfig => {
    vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', 'new_import');
    vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', 'abcdef123456');
    vi.stubEnv('FRAMELEAF_IMPORT_MANAGER_OPERATION_ID', 'fixture-operation');
    return {
      version: '3.2.4',
      sourceId: 'offline-source',
      writersStopped: true,
      mediaRoots: [{ source: '/media', target: '/media' }],
      media: {
        mode: 'manager-in-place',
        authority: 'frameleaf-manager',
        deploymentId: 'abcdef123456',
        operationId: 'fixture-operation',
      },
    };
  };
  const allHeld = Object.fromEntries(
    [
      JobName.AssetExtractMetadata,
      JobName.AssetGenerateThumbnails,
      JobName.SmartSearch,
      JobName.AssetDetectFaces,
      JobName.PersonGenerateThumbnail,
      IDENTICAL,
    ].map((stage) => [stage, 'setup']),
  );

  it.each(['missing config', 'wrong installation', 'wrong operation', 'wrong origin', 'changed config'])(
    'refuses Manager preparation with %s before creating a run or acknowledging work',
    async (invalid) => {
      const config = managerConfig();
      await sql`update frameleaf_immich_import set config_fingerprint = ${digest(config)}`.execute(db);
      await seed(1);
      let code = 'MANAGER_SETUP_AUTHORITY_REQUIRED';
      switch (invalid) {
        case 'missing config': {
          code = 'MANAGER_SETUP_CONFIG_REQUIRED';
          break;
        }
        case 'wrong installation': {
          vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', 'abcdef654321');
          break;
        }
        case 'wrong operation': {
          vi.stubEnv('FRAMELEAF_IMPORT_MANAGER_OPERATION_ID', 'another-operation');
          break;
        }
        case 'wrong origin': {
          vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', 'new_library');
          break;
        }
        case 'changed config': {
          config.sourceId = 'changed';
          code = 'DERIVED_WORK_CONFIG_MISMATCH';
          break;
        }
      }
      await expect(repository.dispatchImportedWork(invalid === 'missing config' ? undefined : config)).rejects.toThrow(
        code,
      );
      expect(await counts()).toMatchObject({ runs: 0, jobs: 0, acknowledged: 0, pending: 4 });
    },
  );

  it('holds even a partial Manager transfer, then resumes every stage held without starting work', async () => {
    const config = managerConfig();
    await sql`update frameleaf_immich_import set config_fingerprint = ${digest(config)}`.execute(db);
    await seed(2);
    const id = importDerivedRunId('source-fixture', digest(config));
    const fault = observe({
      beforeInsert: (number) => {
        if (number === 2) throw new Error('interrupted preparation');
      },
    });
    await expect(repositoryFor(db.withPlugin(fault.plugin)).dispatchImportedWork(config)).rejects.toThrow(
      'interrupted preparation',
    );
    expect(await counts()).toMatchObject({ runs: 1, jobs: 2, held: 2, acknowledged: 0 });
    expect((await sql`select selection->'managerSetup' as setup from job_run`.execute(db)).rows).toEqual([
      { setup: { installation: 'abcdef123456', operationId: 'fixture-operation', preparedAt: null, startedAt: null } },
    ]);
    expect(await repositoryFor(db).dispatchImportedWork(config)).toBe(id);
    const prepared = (await sql`select selection, "enumerationDone" from job_run`.execute(db)).rows;
    expect(prepared).toEqual([
      {
        enumerationDone: true,
        selection: {
          source: 'source-fixture',
          config: digest(config),
          managerSetupRequired: true,
          holds: allHeld,
          managerSetup: {
            installation: 'abcdef123456',
            operationId: 'fixture-operation',
            preparedAt: expect.any(String),
            startedAt: null,
          },
        },
      },
    ]);
    expect(await repositoryFor(db).dispatchImportedWork(config)).toBe(id);
    expect((await sql`select selection, "enumerationDone" from job_run`.execute(db)).rows).toEqual(prepared);
    expect(await counts()).toMatchObject({ runs: 1, jobs: 8, held: 9, acknowledged: 8, pending: 0 });
    const worker = randomUUID();
    await store.initialize(queues, worker);
    for (const queue of queues) expect(await store.claim(queue, worker)).toEqual([]);
  });

  it('reads the holds a concurrent release wrote and never re-holds released work on resume', async () => {
    const config = managerConfig();
    await sql`update frameleaf_immich_import set config_fingerprint = ${digest(config)}`.execute(db);
    await seed(1);
    const id = await repository.dispatchImportedWork(config);
    // Model the setup service's committed release of the early stages; its authority is tested there.
    await sql`update job_run set selection = jsonb_set(jsonb_set(selection, '{managerSetup,startedAt}',
        to_jsonb(clock_timestamp())), '{holds}', (selection->'holds') - ${JobName.AssetExtractMetadata}::text)
      where id = ${id}::uuid`.execute(db);
    await sql`update job set "availableAt" = now() where name = ${JobName.AssetExtractMetadata}`.execute(db);
    // A metadata row lost since (as if it was never inserted) comes back released, the rest stay held.
    await sql`delete from job where name = ${JobName.AssetExtractMetadata}`.execute(db);
    const prepared = (await sql`select selection from job_run`.execute(db)).rows;
    expect(await repositoryFor(db).dispatchImportedWork(config)).toBe(id);
    expect((await sql`select selection from job_run`.execute(db)).rows).toEqual(prepared);
    const worker = randomUUID();
    await store.initialize(queues, worker);
    expect(await store.claim(QueueName.MetadataExtraction, worker)).toHaveLength(1);
    expect(await store.claim(QueueName.ThumbnailGeneration, worker)).toEqual([]);
    expect(await counts()).toMatchObject({ runs: 1, jobs: 4, acknowledged: 4 });
  });

  it.each([undefined, { mode: 'independent-copy' as const }])(
    'rejects unmanaged preparation after a copied Manager run loses its marker: %s',
    async (media) => {
      const config = managerConfig();
      config.media = media;
      config.mediaRoots = [{ source: '/source', target: '/copy' }];
      await sql`update frameleaf_immich_import set config_fingerprint=${digest(config)}`.execute(db);
      await seed(1);
      await repository.dispatchImportedWork(config);
      await sql`update job_run set selection=selection-'managerSetup'`.execute(db);
      vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', '');
      vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', '');
      vi.stubEnv('FRAMELEAF_IMPORT_MANAGER_OPERATION_ID', '');
      await expect(repositoryFor(db).dispatchImportedWork(config)).rejects.toThrow(
        'DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH',
      );
      expect(await counts()).toMatchObject({ runs: 1, jobs: 4, held: 5 });
    },
  );

  it.each(['changed operation', 'missing marker'])(
    'rejects %s instead of retrofitting or releasing a Manager run',
    async (corruption) => {
      const config = managerConfig();
      await sql`update frameleaf_immich_import set config_fingerprint = ${digest(config)}`.execute(db);
      await seed(1);
      await repository.dispatchImportedWork(config);
      if (corruption === 'changed operation') {
        await sql`update job_run set selection = jsonb_set(selection, '{managerSetup,operationId}', '"another-operation"'::jsonb)`.execute(
          db,
        );
      } else {
        await sql`update job_run set selection = selection - 'managerSetup'`.execute(db);
      }
      await expect(repositoryFor(db).dispatchImportedWork(config)).rejects.toThrow(
        'DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH',
      );
      expect(await counts()).toMatchObject({ runs: 1, jobs: 4, held: 5 });
      expect(await holds()).toEqual(allHeld);
    },
  );

  it.each([undefined, { mode: 'independent-copy' as const }])(
    'retains Manager authority and holds copied imports: %s',
    async (media) => {
      const config = managerConfig();
      config.media = media;
      config.mediaRoots = [{ source: '/source', target: '/copy' }];
      await sql`update frameleaf_immich_import set config_fingerprint = ${digest(config)}`.execute(db);
      await seed(1);
      await repository.dispatchImportedWork(config);
      expect(await holds()).toEqual(allHeld);
      expect(
        (await sql<{ marker: unknown }>`select selection->'managerSetup' as marker from job_run`.execute(db)).rows[0]
          .marker,
      ).toMatchObject({
        installation: 'abcdef123456',
        operationId: 'fixture-operation',
        preparedAt: expect.any(String),
        startedAt: null,
      });
      vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', 'abcdef654321');
      await expect(repository.dispatchImportedWork(config)).rejects.toThrow('DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH');
      expect(await holds()).toEqual(allHeld);
      vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', 'abcdef123456');
      vi.stubEnv('FRAMELEAF_MANAGER_ML_ENABLED', 'true');
      await sql`delete from system_metadata where key='frameleaf-manager-library-setup:abcdef123456'`.execute(db);
      await sql`update frameleaf_immich_import set status='activated'`.execute(db);
      const counted = vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 });
      const setupJobs = Object.assign(repositoryFor(db), { getJobCounts: counted });
      const setup = new FrameleafLibrarySetupService(
        db,
        { getAll: vi.fn().mockResolvedValue([]) } as never,
        {} as never,
        setupJobs,
        { hasAdmin: vi.fn().mockResolvedValue(true) } as never,
        {} as never,
        {} as never,
        {
          getAdminConfigWithRevision: vi.fn().mockResolvedValue({ config: mapAdminConfig(defaults), revision: 'test' }),
          updateAdminConfigWithRevision: vi.fn(),
        } as never,
        {} as never,
      );
      await setup.begin();
      // First setup starts the run: the early stages run now, the rest wait for the file check.
      expect(await holds()).toEqual({
        [JobName.SmartSearch]: 'setup',
        [JobName.AssetDetectFaces]: 'setup',
        [JobName.PersonGenerateThumbnail]: 'setup',
        [IDENTICAL]: 'setup',
      });
      while ((await store.reconcileHolds(1000)) > 0);
      const worker = randomUUID();
      await store.initialize(queues, worker);
      expect(await store.claim(QueueName.MetadataExtraction, worker)).toHaveLength(1);
      expect(await store.claim(QueueName.SmartSearch, worker)).toEqual([]);
    },
  );

  it('reuses inserted jobs after a crash before the first journal acknowledgement', async () => {
    await seed(3);
    const fault = observe({
      afterCapture: () => {
        throw new Error('lost capture acknowledgement');
      },
    });
    await expect(repositoryFor(db.withPlugin(fault.plugin)).dispatchImportedWork()).rejects.toThrow(
      'lost capture acknowledgement',
    );
    const before = (await sql`select id from job order by id`.execute(db)).rows;
    expect(await counts()).toMatchObject({ jobs: 12, pending: 12, acknowledged: 0 });
    expect(await repositoryFor(db).dispatchImportedWork()).toBe(runId);
    expect((await sql`select id from job order by id`.execute(db)).rows).toEqual(before);
    expect(await counts()).toMatchObject({ jobs: 12, pending: 0, acknowledged: 12 });
  });

  it('resumes the same run after only one stage has committed its jobs', async () => {
    await seed(3);
    const fault = observe({
      beforeInsert: (number) => {
        if (number === 2) throw new Error('connection lost between stage inserts');
      },
    });
    await expect(repositoryFor(db.withPlugin(fault.plugin)).dispatchImportedWork()).rejects.toThrow(
      'connection lost between stage inserts',
    );
    const [inserted] = (await sql<{ id: string }>`select id from job limit 1`.execute(db)).rows;
    expect(await counts()).toMatchObject({ runs: 1, jobs: 3, pending: 12, acknowledged: 0 });
    expect(await repositoryFor(db).dispatchImportedWork()).toBe(runId);
    expect((await sql`select id from job where id = ${inserted.id}::uuid`.execute(db)).rows).toHaveLength(1);
    expect(await counts()).toMatchObject({ runs: 1, jobs: 12, pending: 0, acknowledged: 12 });
  });

  it('rolls back every acknowledgement in a page if even one retained payload is inconsistent', async () => {
    await seed(3);
    const fault = observe({
      afterCapture: () => {
        throw new Error('lost capture acknowledgement');
      },
    });
    await expect(repositoryFor(db.withPlugin(fault.plugin)).dispatchImportedWork()).rejects.toThrow(
      'lost capture acknowledgement',
    );
    await sql`update job set data = '{}'::jsonb where id = (
      select id from job where name <> ${IDENTICAL} order by "itemKey", name limit 1)`.execute(db);
    await expect(repositoryFor(db).dispatchImportedWork()).rejects.toThrow('DERIVED_WORK_MANIFEST_MISMATCH');
    expect(await counts()).toMatchObject({ pending: 12, acknowledged: 0, jobs: 12 });
  });

  it('resumes after a committed 250-row acknowledgement without inserting work twice', async () => {
    await seed(200);
    const fault = observe({
      beforeAcknowledgement: (number) => {
        if (number === 2) throw new Error('connection lost after journal page');
      },
    });
    await expect(repositoryFor(db.withPlugin(fault.plugin)).dispatchImportedWork()).rejects.toThrow(
      'connection lost after journal page',
    );
    expect(await counts()).toMatchObject({ acknowledged: 250, pending: 550, jobs: 800 });
    expect(await repositoryFor(db).dispatchImportedWork()).toBe(runId);
    expect(await counts()).toMatchObject({ acknowledged: 800, pending: 0, jobs: 800 });
    expect(fault.maximumRows()).toBe(QUEUE_BATCH);
  });

  it.each(['legacy acknowledgement', 'changed identity', 'changed payload', 'changed queue'])(
    'fails closed for %s instead of minting a new retry budget',
    async (corruption) => {
      await seed(1);
      if (corruption === 'legacy acknowledgement') {
        await sql`update frameleaf_immich_import_work set dispatched_at = now()`.execute(db);
        await expect(repository.dispatchImportedWork()).rejects.toThrow('ACKNOWLEDGEMENT_WITHOUT_RUN');
        expect((await counts()).runs).toBe(0);
        return;
      }
      await repository.dispatchImportedWork();
      switch (corruption) {
        case 'changed identity': {
          await sql`update job_run set selection = 'null'::jsonb`.execute(db);
          break;
        }
        case 'changed payload': {
          await sql`update job set data = jsonb_build_object('id', 'another-asset')`.execute(db);
          break;
        }
        case 'changed queue': {
          // The run's job for that asset and stage exists, so a resume cannot insert a correct one beside it.
          await sql`update job set queue = ${QueueName.SmartSearch} where name = ${JobName.AssetExtractMetadata}`.execute(
            db,
          );
          break;
        }
        // No default
      }
      await expect(repositoryFor(db).dispatchImportedWork()).rejects.toThrow(
        corruption === 'changed identity' ? 'DERIVED_RUN_IDENTITY_MISMATCH' : 'DERIVED_WORK_MANIFEST_MISMATCH',
      );
      expect(await counts()).toMatchObject({ runs: 1, jobs: 4 });
    },
  );

  it.each(['copying', 'activated', 'abandoned'])('refuses transfer while the import is %s', async (status) => {
    await seed(1);
    await sql`update frameleaf_immich_import set status = ${status}`.execute(db);
    await expect(repository.dispatchImportedWork()).rejects.toThrow('REQUIRES_VERIFYING_IMPORT');
    expect(await counts()).toMatchObject({ runs: 0, pending: 4, acknowledged: 0, jobs: 0 });
  });

  it.each([QueueName.SmartSearch, QueueName.FaceDetection])(
    'keeps %s identity, destination, payload and retry budget across resumed transfers and retained completion',
    async (queue) => {
      await seed(1);
      await repository.dispatchImportedWork();
      const worker = randomUUID();
      await store.initialize(queues, worker);
      const [first] = await store.claim(queue, worker);
      expect(first).toMatchObject({ runId, safeToRetry: true, attempt: 1 });
      const data = { id: first.itemKey, ...(queue === QueueName.FaceDetection && { preserveImportedFaces: true }) };
      expect(first.data).toEqual(data);
      const pin = (claim: QueueClaim, destination: string) =>
        queueExecution.run(
          {
            claim,
            signal: new AbortController().signal,
            progress: vi.fn(),
            progressUnits: 0,
            adoptions: [],
            followups: [],
            buffering: false,
          },
          () => repository.pinDestination(queue === QueueName.FaceDetection ? 'face' : 'clip', destination),
        );
      expect(await pin(first, 'paid-destination-original')).toBe('paid-destination-original');
      await store.fail(first, 'transport lost');
      // The routing a handler added to the job's data does not fail the resumed audit (containment).
      await repositoryFor(db).dispatchImportedWork();
      await sql`update job set "availableAt" = now() where state = 'pending'`.execute(db);
      const [retry] = await new SqlQueueStore(db).claim(queue, worker);
      expect(retry).toMatchObject({ id: first.id, runId, itemKey: first.itemKey, attempt: 2 });
      expect(retry.data).toEqual({
        ...data,
        _queueDestinations: {
          [queue === QueueName.FaceDetection ? 'face' : 'clip']: 'paid-destination-original',
        },
      });
      expect(await pin(retry, 'paid-destination-reconfigured')).toBe('paid-destination-original');
      await store.fail(retry, 'exhausted');
      await repositoryFor(db).dispatchImportedWork();
      expect(await store.claim(queue, worker)).toEqual([]);
      expect(
        (await sql`select attempt, "retryBaseAttempt", state from job where queue = ${queue}`.execute(db)).rows,
      ).toEqual([{ attempt: 2, retryBaseAttempt: 0, state: 'failed' }]);
      const [thumbnail] = await store.claim(QueueName.ThumbnailGeneration, worker);
      expect(thumbnail.data).toEqual({ id: thumbnail.itemKey }); // no upload/notify fanout flags
      await store.complete(thumbnail, []);
      await repositoryFor(db).dispatchImportedWork();
      expect(await store.claim(QueueName.ThumbnailGeneration, worker)).toEqual([]);
      expect((await counts()).jobs).toBe(4);
    },
  );

  scaleIt('transfers %i roots and four stages each in bounded acknowledgement pages', 0.6, async () => {
    await seed(SCALE_ITEMS);
    const observed = observe();
    const started = performance.now();
    await repositoryFor(db.withPlugin(observed.plugin)).dispatchImportedWork();
    const transferredMs = performance.now() - started;
    expect(await counts()).toEqual({
      runs: 1,
      roots: SCALE_ITEMS,
      jobs: 4 * SCALE_ITEMS,
      held: 0,
      acknowledged: 4 * SCALE_ITEMS,
      pending: 0,
    });
    expect(observed.maximumRows()).toBe(QUEUE_BATCH);
    process.stdout.write(
      `Import transfer: roots=${SCALE_ITEMS} jobs=${4 * SCALE_ITEMS} transferMs=${Math.round(transferredMs)}\n`,
    );
  });
});

it.each(['independent-copy', 'manager-in-place'] as const)(
  'activates an empty external library in %s mode with no thumbnail work',
  async (mode) => {
    const fixture = new PostgresImportFixture();
    let db: Kysely<any> | undefined;
    try {
      await fixture.initialize();
      if (mode === 'manager-in-place') {
        vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', 'new_import');
        vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', 'abcdef123456');
        vi.stubEnv('FRAMELEAF_IMPORT_MANAGER_OPERATION_ID', 'fixture-operation');
        const source = fixture.config.mediaRoots[0].source;
        fixture.config.mediaRoots = [{ source, target: source }];
        fixture.config.media = {
          mode,
          authority: 'frameleaf-manager',
          operationId: 'fixture-operation',
          deploymentId: 'abcdef123456',
        };
      } else {
        fixture.config.media = { mode };
      }
      await fixture.mutateSource(async (source) => {
        await source.query('TRUNCATE public.asset CASCADE');
        await source.query(
          `INSERT INTO public.library(name,"ownerId","importPaths","exclusionPatterns")
        VALUES ('Empty external library',$1,ARRAY[$2::text],ARRAY[]::text[])`,
          [fixture.owner, fixture.config.mediaRoots[0].source],
        );
      });
      db = new Kysely(getKyselyConfig({ connectionType: 'url', url: fixture.url(fixture.destinationName) }));
      await fixture.importer().run();
      await fixture.importer().verify((config) => repositoryFor(db!).dispatchImportedWork(config));
      await expect(assertImmichImportActivated(fixture.destination.db)).resolves.toBeUndefined();
      expect(await fixture.destination.db.query('SELECT "importPaths" FROM public.library')).toEqual([
        { importPaths: [fixture.config.mediaRoots[0].target] },
      ]);
      // FL-414: only the identical-files item, which still recovers orphans in an empty library
      expect(
        (
          await sql`select name, "itemKey", data->>'importRunId' as "importRunId",
            "availableAt" = 'infinity' as held from job`.execute(db)
        ).rows,
      ).toEqual([
        {
          name: IDENTICAL,
          itemKey: 'identical-files',
          importRunId: expect.any(String),
          held: mode === 'manager-in-place',
        },
      ]);
      expect((await sql`select "enumerationDone" from job_run`.execute(db)).rows).toEqual([{ enumerationDone: true }]);
    } finally {
      await db?.destroy();
      await fixture.close();
    }
  },
  120_000,
);

it.each(['independent-copy', 'manager-in-place'] as const)(
  'retains owner-scoped person thumbnail repairs and featured faces across a lost %s handoff acknowledgement',
  async (mode) => {
    const fixture = new PostgresImportFixture();
    let db: Kysely<any> | undefined;
    const person = randomUUID();
    const face = randomUUID();
    const protectedPerson = randomUUID();
    const protectedFace = randomUUID();
    try {
      await fixture.initialize();
      if (mode === 'manager-in-place') {
        vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', 'new_import');
        vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', 'abcdef123456');
        vi.stubEnv('FRAMELEAF_IMPORT_MANAGER_OPERATION_ID', 'fixture-operation');
        const source = fixture.config.mediaRoots[0].source;
        fixture.config.mediaRoots = [{ source, target: source }];
        fixture.config.media = {
          mode,
          authority: 'frameleaf-manager',
          operationId: 'fixture-operation',
          deploymentId: 'abcdef123456',
        };
      } else {
        fixture.config.media = { mode };
      }
      await fixture.mutateSource(async (source) => {
        await source.query("UPDATE public.asset SET visibility='timeline' WHERE id=$1", [fixture.asset]);
        await source.query('INSERT INTO public.person_group(id,"clusterGroupId") VALUES ($1,$3),($2,$3)', [
          person,
          protectedPerson,
          fixture.group,
        ]);
        await source.query(
          `INSERT INTO public.asset_face(id,"assetId","personGroupId","imageWidth","imageHeight",
        "boundingBoxX1","boundingBoxY1","boundingBoxX2","boundingBoxY2","isVisible")
        VALUES ($1,$3,$4,100,100,10,10,50,50,true),($2,$3,$5,100,100,10,10,50,50,false)`,
          [face, protectedFace, fixture.asset, person, protectedPerson],
        );
        await source.query(
          `INSERT INTO public.person("ownerId","personGroupId","faceAssetId","thumbnailPath","isHidden")
        VALUES ($1,$3,$4,$5,true),($2,$3,$4,$5,false),($1,$6,$7,$5,true)`,
          [
            fixture.owner,
            fixture.reader,
            person,
            face,
            join(fixture.config.mediaRoots[0].source, 'missing-person.jpg'),
            protectedPerson,
            protectedFace,
          ],
        );
      });
      db = new Kysely(getKyselyConfig({ connectionType: 'url', url: fixture.url(fixture.destinationName) }));
      await fixture.importer().run();
      const fault = observe({
        afterCapture: () => {
          throw new Error('lost handoff acknowledgement');
        },
      });
      await expect(
        fixture.importer().verify((config) => repositoryFor(db!.withPlugin(fault.plugin)).dispatchImportedWork(config)),
      ).rejects.toThrow('lost handoff acknowledgement');
      await expect(assertImmichImportActivated(fixture.destination.db)).rejects.toThrow('NOT_ACTIVATED');
      const detection = (
        await sql`select id, "runId", data from job where name = ${JobName.AssetDetectFaces}`.execute(db)
      ).rows;
      expect(detection).toEqual([
        expect.objectContaining({ data: { id: fixture.asset, preserveImportedFaces: true } }),
      ]);
      const before = (
        await sql`select id, "runId", "itemKey", "rootItemKey", data from job
      where name = ${JobName.PersonGenerateThumbnail} order by "itemKey"`.execute(db)
      ).rows;
      expect(before).toHaveLength(2);
      for (const ownerId of [fixture.owner, fixture.reader]) {
        const id = `${ownerId}/${person}`;
        expect(before).toContainEqual(
          expect.objectContaining({
            itemKey: id,
            rootItemKey: fixture.asset,
            data: { id, ownerId, personGroupId: person, selectionFaceId: face },
          }),
        );
      }
      // A retained stage with altered face identity cannot acknowledge the import's repair obligation.
      await sql`update job set data = jsonb_set(data, '{selectionFaceId}', to_jsonb(${protectedFace}::text))
      where name = ${JobName.PersonGenerateThumbnail}`.execute(db);
      await expect(repositoryFor(db).dispatchImportedWork(fixture.config)).rejects.toThrow(
        'DERIVED_PERSON_WORK_MANIFEST_MISMATCH',
      );
      await sql`update job set data = jsonb_set(data, '{selectionFaceId}', to_jsonb(${face}::text))
      where name = ${JobName.PersonGenerateThumbnail}`.execute(db);
      await fixture.restartConnections();
      // A missing preservation contract must not be accepted merely because the insert already committed.
      await sql`update job set data = data - 'preserveImportedFaces' where name = ${JobName.AssetDetectFaces}`.execute(
        db,
      );
      await expect(repositoryFor(db).dispatchImportedWork(fixture.config)).rejects.toThrow(
        'DERIVED_WORK_MANIFEST_MISMATCH',
      );
      await sql`update job set data = data || '{"preserveImportedFaces":true}'::jsonb
        where name = ${JobName.AssetDetectFaces}`.execute(db);
      await fixture.importer().verify((config) => repositoryFor(db!).dispatchImportedWork(config));
      await expect(assertImmichImportActivated(fixture.destination.db)).resolves.toBeUndefined();
      expect(
        (await sql`select id, "runId", data from job where name = ${JobName.AssetDetectFaces}`.execute(db)).rows,
      ).toEqual(detection);
      expect(
        (
          await sql`select id, "runId", "itemKey", "rootItemKey", data from job
      where name = ${JobName.PersonGenerateThumbnail} order by "itemKey"`.execute(db)
        ).rows,
      ).toEqual(before);
      expect(
        await fixture.destination.db.query(
          'SELECT "faceAssetId","thumbnailPath","isHidden" FROM public.person WHERE "ownerId"=$1 AND "personGroupId"=$2',
          [fixture.owner, person],
        ),
      ).toEqual([{ faceAssetId: face, thumbnailPath: '', isHidden: true }]);
      expect(
        await fixture.destination.db.query('SELECT id,"personGroupId","isVisible" FROM public.asset_face WHERE id=$1', [
          face,
        ]),
      ).toEqual([{ id: face, personGroupId: person, isVisible: true }]);
      // Manager's import waits for first setup; a copied one runs as soon as it is inserted.
      expect((await sql`select bool_and("availableAt" = 'infinity') as held from job`.execute(db)).rows).toEqual([
        { held: mode === 'manager-in-place' },
      ]);
      expect(
        (
          await sql`select count(*)::int as count from job
            where name != ${JobName.PersonGenerateThumbnail} and name != ${IDENTICAL}`.execute(db)
        ).rows,
      ).toEqual([{ count: 4 }]);
    } finally {
      await db?.destroy();
      await fixture.close();
    }
  },
  120_000,
);

it('verifies and activates a real offline source after durable transfer while all workers are stopped', async () => {
  const fixture = new PostgresImportFixture();
  let db: Kysely<any> | undefined;
  try {
    await fixture.initialize();
    db = new Kysely(getKyselyConfig({ connectionType: 'url', url: fixture.url(fixture.destinationName) }));
    const importer = fixture.importer();
    await importer.run();
    await expect(assertImmichImportActivated(fixture.destination.db)).rejects.toThrow('NOT_ACTIVATED');
    const repository = repositoryFor(db);
    await importer.verify((config) => repository.dispatchImportedWork(config));
    await expect(assertImmichImportActivated(fixture.destination.db)).resolves.toBeUndefined();
    const state = await importer.status();
    expect(state).toMatchObject({ status: 'activated', derivedRunId: expect.any(String), pendingDerivedWork: '0' });
    expect((await sql`select id from job_worker`.execute(db)).rows).toEqual([]);
    // One asset with its four stages, and the identical-files item (FL-414); nothing has run.
    expect(
      (
        await sql`select "runId", count(distinct "rootItemKey")::int as roots, count(*)::int as total,
          bool_and(state = 'pending' and attempt = 0) as untouched from job group by "runId"`.execute(db)
      ).rows,
    ).toEqual([{ runId: state.derivedRunId, roots: 2, total: 5, untouched: true }]);
  } finally {
    await db?.destroy();
    await fixture.close();
  }
}, 120_000);
