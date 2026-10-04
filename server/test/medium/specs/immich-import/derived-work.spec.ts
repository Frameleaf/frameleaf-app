import { Kysely, KyselyPlugin, RawNode, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { QueueName } from 'src/enum.js';
import { IMPORT_DERIVED_STAGES, importDerivedRunId } from 'src/immich-import/derived-work.js';
import { assertImmichImportActivated } from 'src/immich-import/state.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_BATCH, QUEUE_HIGH_WATER, QUEUE_LOW_WATER, QueueClaim } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { getKyselyConfig } from 'src/utils/database.js';
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
      stages: 4,
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
    expect(await counts()).toMatchObject({ stages: 4, memberships: 12, pending: 12, acknowledged: 0, jobs: 0 });
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
      stages: 4,
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

  it('keeps the same ML execution, destination and retry budget across resumed transfers and retained completion', async () => {
    await seed(1);
    await repository.dispatchImportedWork();
    const queue = QueueName.SmartSearch;
    const worker = randomUUID();
    await store.initialize(queues, worker);
    expect(await store.feedManifest(queue)).toBe(1);
    const [first] = await store.claim(queue, worker);
    expect(first).toMatchObject({ runId, safeToRetry: true, attempt: 1 });
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
        () => repository.pinDestination('clip', destination),
      );
    expect(await pin(first, 'paid-destination-original')).toBe('paid-destination-original');
    await store.fail(first, 'transport lost');
    await repositoryFor(db).dispatchImportedWork();
    expect(await store.feedManifest(queue)).toBe(0);
    await sql`update job set "availableAt" = now()`.execute(db);
    const [retry] = await new SqlQueueStore(db).claim(queue, worker);
    expect(retry).toMatchObject({ id: first.id, runId, itemKey: first.itemKey, attempt: 2 });
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
  });

  it('transfers 500k roots and 2M stage memberships with bounded pages, then caps each queue at 1000', async () => {
    await seed(500_000);
    const observed = observe();
    const started = performance.now();
    await repositoryFor(db.withPlugin(observed.plugin)).dispatchImportedWork();
    const transferredMs = performance.now() - started;
    expect(await counts()).toEqual({
      runs: 1,
      stages: 4,
      roots: 500_000,
      memberships: 2_000_000,
      acknowledged: 2_000_000,
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
      `Import manifest: roots=500000 stages=2000000 transferMs=${Math.round(transferredMs)} maxRows=${observed.maximumRows()} queueCap=${QUEUE_HIGH_WATER}\n`,
    );
  }, 300_000);
});

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
    await importer.verify(() => repository.dispatchImportedWork());
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
