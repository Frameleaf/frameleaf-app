import { Kysely, KyselyPlugin, RawNode, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { JobName, QueueName } from 'src/enum.js';
import { digest } from 'src/immich-import/adapters.js';
import { IMPORT_DERIVED_STAGES, importDerivedRunId } from 'src/immich-import/derived-work.js';
import { assertImmichImportActivated } from 'src/immich-import/state.js';
import { ImportConfig } from 'src/immich-import/types.js';
import { queueExecution } from 'src/queue/context.js';
import { freezeSelection } from 'src/queue/manifest.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_BATCH, QUEUE_HIGH_WATER, QUEUE_LOW_WATER, QueueClaim } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
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
  return repository;
};

/** Real SQL still runs; faults model a lost acknowledgement after an earlier committed transaction. */
const observe = (
  options: {
    beforeAcknowledgement?: (number: number) => void;
    beforeCapture?: (number: number) => void;
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
      if (statement.startsWith('insert into job_selection(')) options.beforeCapture?.(++captures);
      // This next read happens after freezeSelection has returned and its capture has committed.
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
  const counts = async () =>
    (
      await sql<{
        runs: number;
        stages: number;
        roots: number;
        memberships: number;
        acknowledged: number;
        pending: number;
        jobs: number;
      }>`select (select count(*)::int from job_run) runs,
    (select count(*)::int from job_selection) stages,
    (select count(distinct "rootItemKey")::int from job_run_item) roots,
    (select count(*)::int from job_run_item) memberships,
    (select count(*)::int from frameleaf_immich_import_work where dispatched_at is not null) acknowledged,
    (select count(*)::int from frameleaf_immich_import_work where dispatched_at is null) pending,
    (select count(*)::int from job) jobs`.execute(db)
    ).rows[0];

  it('transfers once without workers or hot jobs and retains one root per asset with four stages', async () => {
    await seed(2);
    expect(await repository.dispatchImportedWork()).toBe(runId);
    expect(await counts()).toEqual({
      runs: 1,
      stages: 5,
      roots: 2,
      memberships: 8,
      acknowledged: 8,
      pending: 0,
      jobs: 0,
    });
    expect(await new SqlQueueStore(db).listRuns(10, 0)).toEqual([
      expect.objectContaining({
        id: runId,
        total: 2,
        enumerationDone: true,
        state: 'unavailable',
        stageTotals: expect.objectContaining({ total: 8, waiting: 8 }),
      }),
    ]);
    expect(await repositoryFor(db).dispatchImportedWork()).toBe(runId);
    expect((await counts()).memberships).toBe(8);
    expect(
      (
        await sql`select state, "capturedAt" is not null as captured from job_selection
      where stage = ${JobName.PersonGenerateThumbnail}`.execute(db)
      ).rows,
    ).toEqual([{ state: 'ready', captured: true }]);
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
      expect(await counts()).toMatchObject({ runs: 0, stages: 0, acknowledged: 0, pending: 4, jobs: 0 });
    },
  );

  it('commits even a partial Manager capture held, then resumes all five stages without publishing work', async () => {
    const config = managerConfig();
    await sql`update frameleaf_immich_import set config_fingerprint = ${digest(config)}`.execute(db);
    await seed(2);
    const id = importDerivedRunId('source-fixture', digest(config));
    const fault = observe({
      beforeCapture: (number) => {
        if (number === 2) throw new Error('interrupted preparation');
      },
    });
    await expect(repositoryFor(db.withPlugin(fault.plugin)).dispatchImportedWork(config)).rejects.toThrow(
      'interrupted preparation',
    );
    expect((await sql`select state, "capturedAt" is not null as captured from job_selection`.execute(db)).rows).toEqual(
      [{ state: 'enumerating', captured: true }],
    );
    expect((await sql`select selection->'managerSetup' as setup from job_run`.execute(db)).rows).toEqual([
      { setup: { installation: 'abcdef123456', operationId: 'fixture-operation', preparedAt: null, startedAt: null } },
    ]);
    for (const queue of queues) expect(await store.feedManifest(queue)).toBe(0);
    expect(await repositoryFor(db).dispatchImportedWork(config)).toBe(id);
    expect((await sql`select state, "capturedAt" is not null as captured from job_selection`.execute(db)).rows).toEqual(
      Array.from({ length: 5 }, () => ({ state: 'enumerating', captured: true })),
    );
    const prepared = (await sql`select selection, "enumerationDone" from job_run`.execute(db)).rows;
    expect(prepared).toEqual([
      {
        enumerationDone: true,
        selection: {
          source: 'source-fixture',
          config: digest(config),
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
    for (const queue of queues) expect(await store.feedManifest(queue)).toBe(0);
    expect(await counts()).toMatchObject({ runs: 1, stages: 5, memberships: 8, acknowledged: 8, pending: 0, jobs: 0 });
  });

  it('does not re-hold started work or revive cancelled and attention stages on Manager resume', async () => {
    const config = managerConfig();
    await sql`update frameleaf_immich_import set config_fingerprint = ${digest(config)}`.execute(db);
    await seed(1);
    const id = await repository.dispatchImportedWork(config);
    // Model the setup service's committed release; actual settings/admin/journal authority is tested there.
    await db.transaction().execute(async (tx) => {
      await sql`select id from job_run where id = ${id}::uuid for update`.execute(tx);
      await sql`update job_run set selection = jsonb_set(selection, '{managerSetup,startedAt}', to_jsonb(clock_timestamp()))
        where id = ${id}::uuid`.execute(tx);
      await sql`update job_selection set state = case
        when stage = ${JobName.AssetExtractMetadata} then 'cancelled'
        when stage = ${JobName.SmartSearch} then 'needs_attention' else 'ready' end`.execute(tx);
    });
    const prepared = (await sql`select selection from job_run`.execute(db)).rows;
    const selections = (await sql`select id, state from job_selection order by id`.execute(db)).rows;
    expect(await repositoryFor(db).dispatchImportedWork(config)).toBe(id);
    expect((await sql`select selection from job_run`.execute(db)).rows).toEqual(prepared);
    expect((await sql`select id, state from job_selection order by id`.execute(db)).rows).toEqual(selections);
    expect(await store.feedManifest(QueueName.MetadataExtraction)).toBe(0);
    expect(await store.feedManifest(QueueName.SmartSearch)).toBe(0);
    expect(await store.feedManifest(QueueName.ThumbnailGeneration)).toBe(1);
    expect(await store.feedManifest(QueueName.ThumbnailGeneration)).toBe(0);
    expect(await counts()).toMatchObject({ runs: 1, memberships: 4, acknowledged: 4, jobs: 1 });
  });

  it('reads a concurrent first-setup release after the run lock and never restores the hold', async () => {
    const config = managerConfig();
    await sql`update frameleaf_immich_import set config_fingerprint = ${digest(config)}`.execute(db);
    await seed(1);
    const id = await repository.dispatchImportedWork(config);
    const attempted = Promise.withResolvers<void>();
    const captureDb = db.withPlugin({
      transformQuery: ({ node }) => {
        const statement = node.kind === 'RawNode' ? (node as RawNode).sqlFragments.join(' ') : '';
        if (statement.startsWith('select id from job_run') && statement.includes('for update')) attempted.resolve();
        return node;
      },
      transformResult: ({ result }) => Promise.resolve(result),
    });
    let capture: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await db.transaction().execute(async (tx) => {
        await sql`select id from job_run where id = ${id}::uuid for update`.execute(tx);
        capture = freezeSelection(
          captureDb,
          {
            name: JobName.AssetExtractMetadata,
            queue: QueueName.MetadataExtraction,
            data: {},
            safeToRetry: true,
            sensitive: false,
            deadlineMs: 60_000,
          },
          db.selectFrom('frameleaf_immich_import_work').select('asset_id as id').where('kind', '=', 'metadata'),
          undefined,
          id,
          sql<'enumerating' | 'ready'>`case when (select selection #>> '{managerSetup,startedAt}'
          from job_run where id = ${id}::uuid) is not null then 'ready' else 'enumerating' end`,
        );
        // Attach a rejection handler immediately, while preserving the original promise for assertion.
        void capture.catch(() => {});
        await Promise.race([
          attempted.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('capture did not attempt the setup run lock')), 5000);
          }),
        ]);
        await sql`update job_run set selection = jsonb_set(selection, '{managerSetup,startedAt}', to_jsonb(clock_timestamp()))
          where id = ${id}::uuid`.execute(tx);
        await sql`update job_selection set state = 'ready' where "runId" = ${id}::uuid and state = 'enumerating'`.execute(
          tx,
        );
      });
      await expect(capture).resolves.toBe(id);
      expect((await sql`select distinct state from job_selection`.execute(db)).rows).toEqual([{ state: 'ready' }]);
      expect(await store.feedManifest(QueueName.MetadataExtraction)).toBe(1);
      expect(await counts()).toMatchObject({ runs: 1, memberships: 4, jobs: 1 });
    } finally {
      clearTimeout(timer);
      await capture?.catch(() => {});
    }
  });

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
      expect((await sql`select distinct state from job_selection`.execute(db)).rows).toEqual([
        { state: 'enumerating' },
      ]);
      expect(await counts()).toMatchObject({ runs: 1, stages: 5, jobs: 0 });
    },
  );

  it('keeps explicit independent-copy admission ready even in a Manager environment', async () => {
    const config = managerConfig();
    config.media = { mode: 'independent-copy' };
    config.mediaRoots = [{ source: '/source', target: '/copy' }];
    await sql`update frameleaf_immich_import set config_fingerprint = ${digest(config)}`.execute(db);
    await seed(1);
    await repository.dispatchImportedWork(config);
    expect((await sql`select distinct state from job_selection`.execute(db)).rows).toEqual([{ state: 'ready' }]);
    expect((await sql`select selection ? 'managerSetup' as managed from job_run`.execute(db)).rows).toEqual([
      { managed: false },
    ]);
    expect(await store.feedManifest(QueueName.MetadataExtraction)).toBe(1);
  });

  it('reuses frozen memberships after a crash before the first journal acknowledgement', async () => {
    await seed(3);
    const fault = observe({
      afterCapture: () => {
        throw new Error('lost capture acknowledgement');
      },
    });
    await expect(repositoryFor(db.withPlugin(fault.plugin)).dispatchImportedWork()).rejects.toThrow(
      'lost capture acknowledgement',
    );
    const before = (await sql`select id from job_selection order by id`.execute(db)).rows;
    expect(await counts()).toMatchObject({ stages: 5, memberships: 12, pending: 12, acknowledged: 0, jobs: 0 });
    expect(await repositoryFor(db).dispatchImportedWork()).toBe(runId);
    expect((await sql`select id from job_selection order by id`.execute(db)).rows).toEqual(before);
    expect(await counts()).toMatchObject({ memberships: 12, pending: 0, acknowledged: 12, jobs: 0 });
  });

  it('resumes the same run after only one stage has committed its snapshot', async () => {
    await seed(3);
    const fault = observe({
      beforeCapture: (number) => {
        if (number === 2) throw new Error('connection lost between stage captures');
      },
    });
    await expect(repositoryFor(db.withPlugin(fault.plugin)).dispatchImportedWork()).rejects.toThrow(
      'connection lost between stage captures',
    );
    const [captured] = (await sql<{ id: string }>`select id from job_selection`.execute(db)).rows;
    expect(await counts()).toMatchObject({ runs: 1, stages: 1, memberships: 3, pending: 12, acknowledged: 0, jobs: 0 });
    expect(await repositoryFor(db).dispatchImportedWork()).toBe(runId);
    expect((await sql`select id from job_selection where id = ${captured.id}::uuid`.execute(db)).rows).toHaveLength(1);
    expect(await counts()).toMatchObject({
      runs: 1,
      stages: 5,
      memberships: 12,
      pending: 0,
      acknowledged: 12,
      jobs: 0,
    });
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
    await sql`update job_run_item set selection = '{}'::jsonb where ("runId", "itemKey", stage) = (
      select "runId", "itemKey", stage from job_run_item order by "itemKey", stage limit 1)`.execute(db);
    await expect(repositoryFor(db).dispatchImportedWork()).rejects.toThrow('DERIVED_WORK_MANIFEST_MISMATCH');
    expect(await counts()).toMatchObject({ pending: 12, acknowledged: 0, memberships: 12, jobs: 0 });
  });

  it('resumes after a committed 250-row acknowledgement without recapturing or creating executions', async () => {
    await seed(200);
    const fault = observe({
      beforeAcknowledgement: (number) => {
        if (number === 2) throw new Error('connection lost after journal page');
      },
    });
    await expect(repositoryFor(db.withPlugin(fault.plugin)).dispatchImportedWork()).rejects.toThrow(
      'connection lost after journal page',
    );
    expect(await counts()).toMatchObject({ acknowledged: 250, pending: 550, memberships: 800, jobs: 0 });
    expect(await repositoryFor(db).dispatchImportedWork()).toBe(runId);
    expect(await counts()).toMatchObject({ acknowledged: 800, pending: 0, memberships: 800, jobs: 0 });
    expect(fault.maximumRows()).toBe(QUEUE_BATCH);
  });

  it.each(['legacy acknowledgement', 'changed identity', 'changed membership', 'added to an empty snapshot'])(
    'fails closed for %s instead of minting a new retry budget',
    async (corruption) => {
      if (corruption !== 'added to an empty snapshot') await seed(1);
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
        case 'changed membership': {
          await sql`update job_run_item set selection = jsonb_build_object('id', 'another-asset')`.execute(db);

          break;
        }
        case 'added to an empty snapshot': {
          await seed(1);

          break;
        }
        // No default
      }
      await expect(repositoryFor(db).dispatchImportedWork()).rejects.toThrow(
        corruption === 'changed identity' ? 'DERIVED_RUN_IDENTITY_MISMATCH' : 'DERIVED_WORK_MANIFEST_MISMATCH',
      );
      expect((await counts()).jobs).toBe(0);
      expect((await counts()).runs).toBe(1);
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
      expect(await store.feedManifest(queue)).toBe(1);
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
      await repositoryFor(db).dispatchImportedWork();
      expect(await store.feedManifest(queue)).toBe(0);
      await sql`update job set "availableAt" = now()`.execute(db);
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
      expect(await store.feedManifest(queue)).toBe(0);
      expect(await store.claim(queue, worker)).toEqual([]);
      expect((await sql`select attempt, "retryBaseAttempt", state from job`.execute(db)).rows).toEqual([
        { attempt: 2, retryBaseAttempt: 0, state: 'failed' },
      ]);
      // Completed thumbnail cleanup must not make the retained selection eligible again.
      expect(await store.feedManifest(QueueName.ThumbnailGeneration)).toBe(1);
      const [thumbnail] = await store.claim(QueueName.ThumbnailGeneration, worker);
      expect(thumbnail.data).toEqual({ id: thumbnail.itemKey }); // no upload/notify fanout flags
      await store.complete(thumbnail, []);
      await sql`delete from job where id = ${thumbnail.id}::uuid`.execute(db);
      await repositoryFor(db).dispatchImportedWork();
      expect(await store.feedManifest(QueueName.ThumbnailGeneration)).toBe(0);
      expect((await counts()).memberships).toBe(4);
    },
  );

  scaleIt('transfers %i roots and four stages each in bounded pages, then caps each queue at 1000', 0.6, async () => {
    await seed(SCALE_ITEMS);
    const observed = observe();
    const started = performance.now();
    await repositoryFor(db.withPlugin(observed.plugin)).dispatchImportedWork();
    const transferredMs = performance.now() - started;
    expect(await counts()).toEqual({
      runs: 1,
      stages: 5,
      roots: SCALE_ITEMS,
      memberships: 4 * SCALE_ITEMS,
      acknowledged: 4 * SCALE_ITEMS,
      pending: 0,
      jobs: 0,
    });
    expect(observed.maximumRows()).toBe(QUEUE_BATCH);
    for (const queue of queues) {
      for (let admitted = 0; admitted < QUEUE_HIGH_WATER; admitted += QUEUE_BATCH) {
        expect(await store.feedManifest(queue)).toBe(QUEUE_BATCH);
      }
      expect(await new SqlQueueStore(db).feedManifest(queue)).toBe(0);
    }
    // Exercise the coordinator's low-water policy with deterministic completed fixture executions.
    const queue = queues[0];
    await sql`update job set state = 'completed' where id in (
      select id from job where queue = ${queue} order by id limit ${QUEUE_HIGH_WATER - QUEUE_LOW_WATER - 1})`.execute(
      db,
    );
    expect(await store.feedManifest(queue)).toBe(0);
    await sql`update job set state = 'completed' where id = (
      select id from job where queue = ${queue} and state = 'pending' order by id limit 1)`.execute(db);
    expect(await store.feedManifest(queue)).toBe(QUEUE_BATCH);
    expect(await store.feedManifest(queue)).toBe(QUEUE_BATCH);
    expect(await store.feedManifest(queue)).toBe(0);
    process.stdout.write(
      `Import manifest: roots=${SCALE_ITEMS} stages=${4 * SCALE_ITEMS} transferMs=${Math.round(transferredMs)} maxRows=${observed.maximumRows()} queueCap=${QUEUE_HIGH_WATER}\n`,
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
      expect(await new SqlQueueStore(db).listRuns(10, 0)).toEqual([
        expect.objectContaining({
          enumerationDone: true,
          total: 0,
          ...(mode === 'independent-copy' && { state: 'completed' }),
        }),
      ]);
      expect(
        (await sql`select state, count(*)::int as count from job_selection group by state`.execute(db)).rows,
      ).toEqual([{ state: mode === 'manager-in-place' ? 'enumerating' : 'ready', count: 5 }]);
      expect((await sql`select id from job`.execute(db)).rows).toEqual([]);
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
        await sql`select "runId", selection, "selectionId" from job_run_item
          where stage = ${JobName.AssetDetectFaces}`.execute(db)
      ).rows;
      expect(detection).toEqual([
        expect.objectContaining({ selection: { id: fixture.asset, preserveImportedFaces: true } }),
      ]);
      const before = (
        await sql`select "runId", "itemKey", "rootItemKey", selection, "selectionId" from job_run_item
      where stage = ${JobName.PersonGenerateThumbnail} order by "itemKey"`.execute(db)
      ).rows;
      expect(before).toHaveLength(2);
      for (const ownerId of [fixture.owner, fixture.reader]) {
        const id = `${ownerId}/${person}`;
        expect(before).toContainEqual(
          expect.objectContaining({
            itemKey: id,
            rootItemKey: fixture.asset,
            selection: { id, ownerId, personGroupId: person, selectionFaceId: face },
          }),
        );
      }
      // A retained stage with altered face identity cannot acknowledge the import's repair obligation.
      await sql`update job_run_item set selection = jsonb_set(selection, '{selectionFaceId}', to_jsonb(${protectedFace}::text))
      where stage = ${JobName.PersonGenerateThumbnail}`.execute(db);
      await expect(repositoryFor(db).dispatchImportedWork(fixture.config)).rejects.toThrow(
        'DERIVED_PERSON_WORK_MANIFEST_MISMATCH',
      );
      await sql`update job_run_item set selection = jsonb_set(selection, '{selectionFaceId}', to_jsonb(${face}::text))
      where stage = ${JobName.PersonGenerateThumbnail}`.execute(db);
      await fixture.restartConnections();
      // A missing preservation contract must not be accepted merely because capture already committed.
      await sql`update job_run_item set selection = selection - 'preserveImportedFaces'
        where stage = ${JobName.AssetDetectFaces}`.execute(db);
      await expect(repositoryFor(db).dispatchImportedWork(fixture.config)).rejects.toThrow(
        'DERIVED_WORK_MANIFEST_MISMATCH',
      );
      await sql`update job_run_item set selection = selection || '{"preserveImportedFaces":true}'::jsonb
        where stage = ${JobName.AssetDetectFaces}`.execute(db);
      await fixture.importer().verify((config) => repositoryFor(db!).dispatchImportedWork(config));
      await expect(assertImmichImportActivated(fixture.destination.db)).resolves.toBeUndefined();
      expect(
        (
          await sql`select "runId", selection, "selectionId" from job_run_item
            where stage = ${JobName.AssetDetectFaces}`.execute(db)
        ).rows,
      ).toEqual(detection);
      expect(
        (
          await sql`select "runId", "itemKey", "rootItemKey", selection, "selectionId" from job_run_item
      where stage = ${JobName.PersonGenerateThumbnail} order by "itemKey"`.execute(db)
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
      if (mode === 'manager-in-place') {
        expect(
          (await sql`select state, count(*)::int as count from job_selection group by state`.execute(db)).rows,
        ).toEqual([{ state: 'enumerating', count: 5 }]);
        expect(await new SqlQueueStore(db).feedManifest(QueueName.ThumbnailGeneration)).toBe(0);
      }
      expect((await sql`select id from job`.execute(db)).rows).toEqual([]);
      expect(
        (
          await sql`select count(*)::int as count from job_run_item where stage != ${JobName.PersonGenerateThumbnail}`.execute(
            db,
          )
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
    expect((await sql`select id from job`.execute(db)).rows).toEqual([]);
    expect((await sql`select id from job_worker`.execute(db)).rows).toEqual([]);
    expect(await new SqlQueueStore(db).listRuns(10, 0)).toEqual([
      expect.objectContaining({
        id: state.derivedRunId,
        total: 1,
        stageTotals: expect.objectContaining({ total: 4 }),
        enumerationDone: true,
      }),
    ]);
  } finally {
    await db?.destroy();
    await fixture.close();
  }
}, 120_000);
