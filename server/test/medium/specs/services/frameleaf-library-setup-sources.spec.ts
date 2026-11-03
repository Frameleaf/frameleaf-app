import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { v5 } from 'uuid';
import { defaults, mapAdminConfig } from 'src/dtos/config.dto.js';
import { JobName, QueueName } from 'src/enum.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { type SourceKind, manifestFingerprint, parseImportManifest, sourceKinds } from 'src/library-import/manifest.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { PersonService } from 'src/services/person.service.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import { getKyselyDB, newTestService } from 'test/utils.js';

const cases = [
  ...sourceKinds.map((kind) => ({ kind, mismatch: '', outcome: '' })),
  ...['operation', 'manifest', 'installation', 'restore-none', 'restore-other', 'restore-approved'].map((mismatch) => ({
    kind: 'photoprism' as SourceKind,
    mismatch,
    outcome: '',
  })),
  ...['disabled', 'failed', 'needs_attention', 'cancelled', 'blocked', 'terminal-alias'].map((outcome) => ({
    kind: 'photoprism' as SourceKind,
    mismatch: '',
    outcome,
  })),
];
it.each(cases)('shared setup: $kind $mismatch $outcome', async ({ kind, mismatch, outcome }) => {
  const db = await getKyselyDB(`manager_setup_${kind}_${(mismatch || outcome).replaceAll('-', '_') || 'valid'}`);
  const previous = {
    FRAMELEAF_MANAGER_INSTALLATION: process.env.FRAMELEAF_MANAGER_INSTALLATION,
    FRAMELEAF_MANAGER_ORIGIN: process.env.FRAMELEAF_MANAGER_ORIGIN,
    FRAMELEAF_MANAGER_ML_ENABLED: process.env.FRAMELEAF_MANAGER_ML_ENABLED,
    FRAMELEAF_MANAGER_IMPORT_INSTALLATION: process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION,
  };
  const installation = '114900000001';
  const destinationId = randomUUID();
  const source = {
    kind,
    version: 'synthetic-setup-contract',
    identity: 'source',
    revision: 'frozen',
    schemaSha256: 'c'.repeat(64),
  };
  const ownerId = randomUUID();
  const assetId = randomUUID();
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.source = source;
  plan.destinationId = destinationId;
  plan.owners = [{ sourceId: 'owner', destinationId: ownerId }];
  plan.files = [plan.files[0]];
  const file = plan.files[0];
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 3,
    source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: source.revision,
      revisionAfter: source.revision,
    },
    users: [{ id: 'owner', name: 'Synthetic imported owner' }],
    files: [{ id: file.id, path: file.sourcePath, bytes: file.bytes, sha256: file.sha256, role: 'original' }],
    assets: [
      {
        id: 'photo',
        ownerId: 'owner',
        fileIds: [file.id],
        primaryFileId: file.id,
        originalFileNames: { [file.id]: 'synthetic.jpg' },
        type: 'IMAGE',
        fileModifiedAt: '2020-01-02T03:04:05Z',
        visibility: 'timeline',
        metadata: {},
      },
    ],
    albums: [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
    source,
  };
  const id = v5(
    JSON.stringify(['library-import-derived', binding.operationId, binding.manifestSha256, binding.planSha256]),
    v5.URL,
  );
  const stages = [
    [JobName.AssetExtractMetadata, QueueName.MetadataExtraction],
    [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration],
    [JobName.SmartSearch, QueueName.SmartSearch],
    [JobName.AssetDetectFaces, QueueName.FaceDetection],
    [JobName.AssetEncodeVideo, QueueName.VideoConversion],
    [JobName.PersonGenerateThumbnail, QueueName.ThumbnailGeneration],
  ] as const;
  const users = {
    hasAdmin: vi.fn().mockResolvedValue(false),
    getAdmin: vi.fn().mockResolvedValue({ id: randomUUID() }),
  };
  const config = {
    getAdminConfigWithRevision: vi.fn().mockResolvedValue({ config: mapAdminConfig(defaults), revision: 'first' }),
    updateAdminConfigWithRevision: vi.fn(),
  };
  config.updateAdminConfigWithRevision.mockImplementation(({ config: saved }) => {
    config.getAdminConfigWithRevision.mockResolvedValue({ config: saved, revision: 'updated' });
    return Promise.resolve({});
  });
  const make = () =>
    new FrameleafLibrarySetupService(
      db,
      { getAll: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      {
        getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }),
      } as never,
      users as never,
      { getNow: vi.fn().mockResolvedValue({ nowId: randomUUID() }) } as never,
      {} as never,
      config as never,
      {} as never,
    );
  const marker = async () =>
    (
      await sql<{
        selection: { managerSetup: { startedAt: string | null } };
      }>`SELECT selection FROM job_run WHERE id=${id}::uuid`.execute(db)
    ).rows[0].selection.managerSetup;
  const ready = async () =>
    (
      await sql<{
        stage: string;
      }>`SELECT stage FROM job_selection WHERE "runId"=${id}::uuid AND state='ready' ORDER BY stage`.execute(db)
    ).rows.map(({ stage }) => stage);
  try {
    process.env.FRAMELEAF_MANAGER_INSTALLATION = installation;
    process.env.FRAMELEAF_MANAGER_ORIGIN = 'new_import';
    process.env.FRAMELEAF_MANAGER_ML_ENABLED = outcome === 'disabled' ? 'false' : 'true';
    await sql`INSERT INTO frameleaf_library_import(operation_id,binding,status,reviewed_manifest,reviewed_plan)
      VALUES(${binding.operationId}::uuid,${JSON.stringify(binding)}::text::jsonb,'verifying',
        ${JSON.stringify(manifest)}::text::jsonb,${JSON.stringify(plan)}::text::jsonb)`.execute(db);
    await sql`WITH g AS (INSERT INTO cluster_group DEFAULT VALUES RETURNING id)
      INSERT INTO "user"(id,email,"clusterGroupId") SELECT ${ownerId}::uuid,'owner@example.test',id FROM g`.execute(db);
    await sql`INSERT INTO asset(id,"ownerId",type,"originalPath","fileCreatedAt","fileModifiedAt",checksum,
      "checksumAlgorithm","originalFileName","localDateTime") VALUES(${assetId}::uuid,${ownerId}::uuid,
      'IMAGE','/fixture/synthetic.jpg',now(),now(),decode(${file.sha256},'hex'),'sha256','synthetic.jpg',now())`.execute(
      db,
    );
    for (const [kind, sourceId, destinationId] of [
      ['owner', 'owner', ownerId],
      ['asset', 'photo', assetId],
    ])
      await sql`INSERT INTO frameleaf_library_import_mapping(operation_id,entity_kind,source_id,destination_id,record_sha256)
        VALUES(${binding.operationId}::uuid,${kind},${sourceId},${destinationId}::uuid,${'e'.repeat(64)})`.execute(db);
    const jobs = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    for (const [jobName, queueName] of stages)
      jobs['handlers'][jobName] = { jobName, queueName, handler: vi.fn(), label: 'synthetic setup' };
    expect(
      await jobs.prepareImportedLibraryWork(
        { binding, destinationId },
        { installation, operationId: binding.operationId },
      ),
    ).toBe(id);
    expect(
      (
        await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM job_selection WHERE "runId"=${id}::uuid`.execute(db)
      ).rows[0].count,
    ).toBe(stages.length);
    // Simulate activation's completed enumeration while retaining the real prepared selections.
    await sql`UPDATE job_run SET "enumerationDone"=true WHERE id=${id}::uuid`.execute(db);
    if (mismatch.startsWith('restore-')) {
      process.env.FRAMELEAF_MANAGER_ORIGIN = 'restored_library';
      if (mismatch === 'restore-none') delete process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION;
      else
        process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION =
          mismatch === 'restore-approved' ? installation : '114900000002';
      users.hasAdmin.mockResolvedValue(true);
      await sql`UPDATE frameleaf_library_import SET status='activated'`.execute(db);
      await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,startedAt}',to_jsonb(now()::text)) WHERE id=${id}::uuid`.execute(
        db,
      );
      await make().begin();
      if (mismatch === 'restore-other') {
        expect(await make().progress()).toMatchObject({ phase: 'needs-attention', completedAt: null });
        await expect(make().setPaused(true)).rejects.toThrow('Imported setup identity mismatch');
      } else {
        await make().setPaused(true);
        await make().setPaused(false);
      }
      expect(await ready()).toEqual(
        mismatch === 'restore-approved' ? [JobName.AssetExtractMetadata, JobName.AssetGenerateThumbnails].sort() : [],
      );
      if (mismatch === 'restore-none')
        expect((await make().progress()).stages.find(({ id }) => id === 'thumbnails')?.status).toBe('waiting');
      return;
    }
    if (mismatch) {
      if (mismatch === 'installation')
        await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,installation}','"114900000002"'::jsonb) WHERE id=${id}::uuid`.execute(
          db,
        );
      else {
        const field = mismatch === 'operation' ? 'operationId' : 'manifestSha256';
        const value = mismatch === 'operation' ? randomUUID() : 'd'.repeat(64);
        await sql`UPDATE job_run SET selection=jsonb_set(selection,ARRAY[${field}],${JSON.stringify(value)}::text::jsonb) WHERE id=${id}::uuid`.execute(
          db,
        );
      }
      users.hasAdmin.mockResolvedValue(true);
      await sql`UPDATE frameleaf_library_import SET status='activated'`.execute(db);
      await make().begin();
      expect((await marker()).startedAt).toBeNull();
      expect(await ready()).toEqual([]);
      expect(await make().progress()).toMatchObject({ active: true, phase: 'needs-attention', completedAt: null });
      await expect(make().setPaused(true)).rejects.toThrow('Imported setup identity mismatch');
      return;
    }
    await make().begin();
    expect((await make().status()).regeneration).toMatchObject({
      runId: id,
      state: 'pending_first_setup',
      startedAt: null,
    });
    expect(await ready()).toEqual([]);
    await sql`UPDATE frameleaf_library_import SET status='activated'`.execute(db);
    users.hasAdmin.mockResolvedValue(true);
    await make().begin();
    const startedAt = (await marker()).startedAt;
    expect(startedAt).toEqual(expect.any(String));
    const early = [JobName.AssetExtractMetadata, JobName.AssetGenerateThumbnails].sort();
    expect(await ready()).toEqual(early);
    expect(await make().progress()).toMatchObject({ active: true, paused: false, completedAt: null });
    expect((await make().progress()).stages.find(({ id }) => id === 'search')?.status).toBe('waiting');
    await make().setPaused(true);
    expect(await ready()).toEqual([]);
    await make().setPaused(false);
    expect(await ready()).toEqual(early);
    await make().begin(true);
    expect((await marker()).startedAt).toBe(startedAt);
    expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM job_run`.execute(db)).rows[0].count).toBe(
      1,
    );
    await sql`UPDATE job_selection SET state='ready' WHERE "runId"=${id}::uuid AND state='enumerating'`.execute(db);
    await sql`UPDATE job_run_item SET state='completed' WHERE "runId"=${id}::uuid`.execute(db);
    await sql`UPDATE system_metadata SET value=value || ${JSON.stringify({
      phase: 'verifying',
      healthAfter: new Date().toISOString(),
      owners: [],
      health: {},
      checkReleasedAt: new Date().toISOString(),
      quietSince: Date.now() - 11_000,
    })}::text::jsonb WHERE key=${`frameleaf-manager-library-setup:${installation}`}`.execute(db);
    if (outcome) {
      if (outcome === 'terminal-alias') {
        const store = new SqlQueueStore(db);
        const worker = randomUUID();
        await store.initialize([QueueName.SmartSearch], worker);
        await sql`UPDATE job_run_item SET state='pending' WHERE "runId"=${id}::uuid AND stage=${JobName.SmartSearch}`.execute(
          db,
        );
        await store.feedManifest(QueueName.SmartSearch);
        const [claim] = await store.claim(QueueName.SmartSearch, worker, 1);
        expect(await store.complete(claim, [])).toBe(true);
        await sql`UPDATE job_run_item SET state='active' WHERE "runId"=${id}::uuid AND stage=${JobName.SmartSearch}`.execute(
          db,
        );
        expect((await make().status()).phase).toBe('complete');
        expect(await make().progress()).toMatchObject({ completedAt: expect.any(String) });
      } else if (outcome === 'disabled') {
        const store = new SqlQueueStore(db);
        const worker = randomUUID();
        const smart = newTestService(SmartInfoService).sut;
        const faces = newTestService(PersonService).sut;
        const disabled = structuredClone(defaults);
        disabled.machineLearning.enabled = false;
        vi.spyOn(smart, 'getConfig').mockResolvedValue(disabled);
        vi.spyOn(faces, 'getConfig').mockResolvedValue(disabled);
        await store.initialize([QueueName.SmartSearch, QueueName.FaceDetection], worker);
        for (const [stage, queue] of [
          [JobName.SmartSearch, QueueName.SmartSearch],
          [JobName.AssetDetectFaces, QueueName.FaceDetection],
        ] as const) {
          await sql`UPDATE job_run_item SET state='pending' WHERE "runId"=${id}::uuid AND stage=${stage}`.execute(db);
          await store.feedManifest(queue);
          const [claim] = await store.claim(queue, worker, 1);
          expect(claim).toBeDefined();
          const invoke = () =>
            stage === JobName.SmartSearch
              ? smart.handleEncodeClip({ id: assetId })
              : faces.handleDetectFaces({ id: assetId });
          await expect(
            queueExecution.run(
              {
                claim,
                signal: new AbortController().signal,
                progress: () => {},
                followups: [],
                adoptions: [],
                buffering: false,
                progressUnits: 0,
              },
              invoke,
            ),
          ).rejects.toMatchObject({ reason: 'workload-disabled' });
          expect(await store.defer(claim, 'workload-disabled')).toBe(true);
        }
        expect((await make().status()).phase).toBe('complete');
        expect(await make().progress()).toMatchObject({
          completedAt: expect.any(String),
          stages: expect.arrayContaining([{ id: 'search', status: 'waiting', disabled: true, done: 0, total: 0 }]),
        });
        expect((await sql`SELECT "dependencyReason" FROM job WHERE "runId"=${id}::uuid`.execute(db)).rows).toEqual([
          { dependencyReason: 'workload-disabled' },
          { dependencyReason: 'workload-disabled' },
        ]);
      } else {
        await sql`UPDATE job_run_item SET state=${outcome} WHERE "runId"=${id}::uuid AND stage=${JobName.SmartSearch}`.execute(
          db,
        );
        expect((await make().status()).phase).toBe('needs-attention');
        expect(await make().progress()).toMatchObject({ phase: 'needs-attention', completedAt: null });
        expect((await make().progress()).stages.find(({ id }) => id === 'search')?.status).not.toBe('done');
      }
      return;
    }
    for (const stage of [JobName.SmartSearch, JobName.AssetDetectFaces]) {
      await sql`UPDATE job_run_item SET state='pending' WHERE "runId"=${id}::uuid AND stage=${stage}`.execute(db);
      await sql`UPDATE system_metadata SET value=jsonb_set(value,'{quietSince}',${JSON.stringify(Date.now() - 11_000)}::text::jsonb)
        WHERE key=${`frameleaf-manager-library-setup:${installation}`}`.execute(db);
      expect((await make().status()).phase).toBe('verifying');
      expect(
        (
          await sql<{ quiet: unknown }>`SELECT value->'quietSince' AS quiet FROM system_metadata
        WHERE key=${`frameleaf-manager-library-setup:${installation}`}`.execute(db)
        ).rows[0].quiet,
      ).toBeNull();
      await sql`UPDATE job_run_item SET state='completed' WHERE "runId"=${id}::uuid AND stage=${stage}`.execute(db);
    }
    const unrelated = randomUUID();
    await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone")
      VALUES(${unrelated}::uuid,'synthetic-unrelated','{}'::jsonb,true)`.execute(db);
    await sql`INSERT INTO job_run_item("runId","itemKey",stage,queue,state,selection)
      VALUES(${unrelated}::uuid,'unrelated',${JobName.SmartSearch},${QueueName.SmartSearch},'pending','{}'::jsonb)`.execute(
      db,
    );
    await sql`UPDATE system_metadata SET value=jsonb_set(value,'{quietSince}',${JSON.stringify(Date.now() - 11_000)}::text::jsonb)
      WHERE key=${`frameleaf-manager-library-setup:${installation}`}`.execute(db);
    expect((await make().status()).phase).toBe('complete');
    expect(await make().progress()).toMatchObject({ phase: 'complete', completedAt: expect.any(String) });
    expect(
      (await sql<{ count: number }>`SELECT count(*)::int AS count FROM frameleaf_immich_import`.execute(db)).rows[0]
        .count,
    ).toBe(0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db.destroy();
  }
});
