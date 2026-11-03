import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { v5 } from 'uuid';
import { JobName, QueueName } from 'src/enum.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { type SourceKind, manifestFingerprint, parseImportManifest, sourceKinds } from 'src/library-import/manifest.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { getKyselyDB } from 'test/utils.js';

const cases = [
  ...sourceKinds.map((kind) => ({ kind, mismatch: '' })),
  ...['operation', 'manifest', 'installation', 'restore-none', 'restore-other', 'restore-approved'].map((mismatch) => ({
    kind: 'photoprism' as SourceKind,
    mismatch,
  })),
];
it.each(cases)('uses one Manager setup contract for $kind ($mismatch)', async ({ kind, mismatch }) => {
  const db = await getKyselyDB(`manager_setup_${kind}_${mismatch.replaceAll('-', '_') || 'valid'}`);
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
    getAdminConfigWithRevision: vi
      .fn()
      .mockResolvedValue({ config: { machineLearning: { enabled: true, urls: [] } }, revision: 'first' }),
    updateAdminConfigWithRevision: vi.fn().mockResolvedValue({}),
  };
  const make = () =>
    new FrameleafLibrarySetupService(
      db,
      { getAll: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      { getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }) } as never,
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
    process.env.FRAMELEAF_MANAGER_ML_ENABLED = 'false';
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
