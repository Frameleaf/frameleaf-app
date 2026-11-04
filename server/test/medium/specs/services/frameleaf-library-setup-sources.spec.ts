import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { v5 } from 'uuid';
import { defaults, mapAdminConfig } from 'src/dtos/config.dto.js';
import { JobName, MediaOperationDestination, MediaOperationKind, MediaOperationStatus, QueueName } from 'src/enum.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { type SourceKind, manifestFingerprint, parseImportManifest, sourceKinds } from 'src/library-import/manifest.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { PersonService } from 'src/services/person.service.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import { getKyselyDB, newTestService } from 'test/utils.js';

const cases = [
  ...sourceKinds.map((kind) => ({ kind, mismatch: '', outcome: '' })),
  ...[
    'operation',
    'manifest',
    'installation',
    'manager-marker-missing',
    'restore-none',
    'restore-other',
    'restore-approved',
  ].map((mismatch) => ({
    kind: 'photoprism' as SourceKind,
    mismatch,
    outcome: '',
  })),
  ...[
    'disabled',
    'disabled-people',
    'failed',
    'needs_attention',
    'cancelled',
    'blocked',
    'halting-failed',
    'terminal-alias',
    'empty',
    'queued-pause',
    'repeated-begin',
    'scans-pause',
    'pause-rollback',
    'quiet-hours',
  ].map((outcome) => ({
    kind: 'photoprism' as SourceKind,
    mismatch: '',
    outcome,
  })),
];
it.each(cases)('shared setup: $kind $mismatch $outcome', async ({ kind, mismatch, outcome }) => {
  const db = await getKyselyDB();
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
  if (outcome === 'empty') plan.files = [];
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
    files: plan.files.map((file) => ({
      id: file.id,
      path: file.sourcePath,
      bytes: file.bytes,
      sha256: file.sha256,
      role: 'original',
    })),
    assets:
      outcome === 'empty'
        ? []
        : [
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
  const operations = new MediaOperationRepository(db);
  const isPaused = vi.fn().mockResolvedValue(true);
  const make = (connection = db) =>
    new FrameleafLibrarySetupService(
      connection,
      { getAll: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      {
        getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }),
        isPaused,
      } as never,
      users as never,
      { getNow: vi.fn().mockResolvedValue({ nowId: randomUUID() }) } as never,
      {} as never,
      config as never,
      operations,
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
    process.env.FRAMELEAF_MANAGER_ML_ENABLED = outcome.startsWith('disabled') ? 'false' : 'true';
    await sql`INSERT INTO frameleaf_library_import(operation_id,binding,status,reviewed_manifest,reviewed_plan)
      VALUES(${binding.operationId}::uuid,${JSON.stringify(binding)}::text::jsonb,'verifying',
        ${JSON.stringify(manifest)}::text::jsonb,${JSON.stringify(plan)}::text::jsonb)`.execute(db);
    await sql`WITH g AS (INSERT INTO cluster_group DEFAULT VALUES RETURNING id)
      INSERT INTO "user"(id,email,"clusterGroupId") SELECT ${ownerId}::uuid,'owner@example.test',id FROM g`.execute(db);
    if (manifest.assets.length > 0)
      await sql`INSERT INTO asset(id,"ownerId",type,"originalPath","fileCreatedAt","fileModifiedAt",checksum,
      "checksumAlgorithm","originalFileName","localDateTime") VALUES(${assetId}::uuid,${ownerId}::uuid,
      'IMAGE','/fixture/synthetic.jpg',now(),now(),decode(${file.sha256},'hex'),'sha256','synthetic.jpg',now())`.execute(
        db,
      );
    for (const [kind, sourceId, destinationId] of [
      ['owner', 'owner', ownerId],
      ...(manifest.assets.length > 0 ? [['asset', 'photo', assetId]] : []),
    ])
      await sql`INSERT INTO frameleaf_library_import_mapping(operation_id,entity_kind,source_id,destination_id,record_sha256)
        VALUES(${binding.operationId}::uuid,${kind},${sourceId},${destinationId}::uuid,${'e'.repeat(64)})`.execute(db);
    const jobs = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    for (const [jobName, queueName] of stages)
      jobs['handlers'][jobName] = { jobName, queueName, handler: vi.fn(), label: 'synthetic setup' };
    expect(
      await jobs.dispatchImportedLibraryWork(
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
      if (mismatch === 'restore-other' || mismatch === 'restore-none') {
        expect(await make().progress()).toMatchObject({ phase: 'needs-attention', completedAt: null });
        await expect(make().setPaused(true)).rejects.toThrow('Imported setup identity mismatch');
      } else {
        await make().setPaused(true);
        await make().setPaused(false);
      }
      expect(await ready()).toEqual(
        mismatch === 'restore-approved' ? [JobName.AssetExtractMetadata, JobName.AssetGenerateThumbnails].sort() : [],
      );
      if (mismatch === 'restore-none') expect((await make().progress()).stages).toEqual([]);
      return;
    }
    if (mismatch) {
      if (mismatch === 'manager-marker-missing')
        await sql`UPDATE job_run SET selection=selection-'managerSetup' WHERE id=${id}::uuid`.execute(db);
      else if (mismatch === 'installation')
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
      if (mismatch === 'manager-marker-missing') expect(await marker()).toBeUndefined();
      else expect((await marker()).startedAt).toBeNull();
      expect(await ready()).toEqual([]);
      expect(await make().progress()).toMatchObject({ active: true, phase: 'needs-attention', completedAt: null });
      await expect(make().setPaused(true)).rejects.toThrow('Imported setup identity mismatch');
      return;
    }
    await make().begin();
    expect((await make().status()).regeneration).toMatchObject({
      runId: id,
      state: outcome === 'empty' ? 'completed' : 'pending_first_setup',
      startedAt: null,
    });
    expect(await ready()).toEqual([]);
    await sql`UPDATE frameleaf_library_import SET status='activated'`.execute(db);
    users.hasAdmin.mockResolvedValue(true);
    await make().begin();
    const startedAt = (await marker()).startedAt;
    expect(startedAt).toEqual(expect.any(String));
    expect(
      (
        await sql<{
          run: string;
          operation: string;
        }>`SELECT value->>'importRunId' AS run,value->>'importOperationId' AS operation
      FROM system_metadata WHERE key=${'frameleaf-manager-library-setup:' + installation}`.execute(db)
      ).rows[0],
    ).toEqual({ run: id, operation: binding.operationId });
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
      switch (outcome) {
        case 'repeated-begin': {
          const before = (await sql`SELECT xmin::text AS version FROM job_run WHERE id=${id}::uuid`.execute(db))
            .rows[0];
          await db.transaction().execute(async (blocker) => {
            await sql`SELECT name FROM job_queue FOR NO KEY UPDATE`.execute(blocker);
            await db.connection().execute(async (connection) => {
              await sql`SET lock_timeout='500ms'`.execute(connection);
              try {
                await make(connection).begin();
              } finally {
                await sql`RESET lock_timeout`.execute(connection);
              }
            });
          });
          expect(
            (await sql`SELECT xmin::text AS version FROM job_run WHERE id=${id}::uuid`.execute(db)).rows[0],
          ).toEqual(before);
          break;
        }
        case 'queued-pause': {
          const store = new SqlQueueStore(db);
          const worker = randomUUID();
          await store.initialize([QueueName.MetadataExtraction, QueueName.ThumbnailGeneration], worker);
          await sql`UPDATE job_run_item SET state='pending' WHERE "runId"=${id}::uuid AND stage IN (${JobName.AssetExtractMetadata},${JobName.AssetGenerateThumbnails})`.execute(
            db,
          );
          await store.feedManifest(QueueName.MetadataExtraction);
          const [active] = await store.claim(QueueName.MetadataExtraction, worker, 1);
          expect(active.runId).toBe(id);
          await sql`UPDATE job_queue SET concurrency=1 WHERE name=${QueueName.ThumbnailGeneration}`.execute(db);
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
          const [occupying] = await store.claim(QueueName.ThumbnailGeneration, worker, 1);
          await store.feedManifest(QueueName.ThumbnailGeneration);
          expect(await store.claim(QueueName.ThumbnailGeneration, worker)).toEqual([]);
          await make().setPaused(true);
          await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup}',(selection->'managerSetup')-'paused') WHERE id=${id}::uuid`.execute(
            db,
          );
          await make().begin(); // A restarted Manager repairs the durable hold before accepting more work.
          expect(await store.complete(occupying, [])).toBe(true);
          expect(await store.claim(QueueName.ThumbnailGeneration, worker)).toEqual([]);
          expect(await store.complete(active, [])).toBe(true);
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
          const [other] = await store.claim(QueueName.ThumbnailGeneration, worker, 1);
          expect(other.runId).toBeNull();
          expect(await store.complete(other, [])).toBe(true);
          await make().setPaused(false);
          const [resumed] = await store.claim(QueueName.ThumbnailGeneration, worker, 1);
          expect(resumed.runId).toBe(id);

          break;
        }
        case 'scans-pause':
        case 'pause-rollback': {
          const createScan = () =>
            operations.create({
              ownerId,
              kind: MediaOperationKind.LibraryScan,
              destination: MediaOperationDestination.Local,
              label: 'Synthetic library scan',
              snapshot: {},
              settings: {},
            });
          const running = (await createScan()).id;
          const claim = await operations.claimNext({
            kinds: [MediaOperationKind.LibraryScan],
            workerId: 'synthetic-worker',
            leaseMs: 60_000,
          });
          expect(claim?.operation.id).toBe(running);
          expect(claim?.operation.status).toBe(MediaOperationStatus.Preparing);
          const queued = (await createScan()).id;
          const health = (
            await operations.create({
              ownerId,
              kind: MediaOperationKind.MediaHealth,
              destination: MediaOperationDestination.Local,
              label: 'Synthetic original check',
              snapshot: {},
              settings: {},
            })
          ).id;
          await sql`UPDATE system_metadata SET value=jsonb_set(value,'{health}',${JSON.stringify({ [ownerId]: health })}::text::jsonb)
            WHERE key=${`frameleaf-manager-library-setup:${installation}`}`.execute(db);
          await sql`UPDATE system_metadata SET value=jsonb_set(value,'{scans}',${JSON.stringify({ first: queued, second: running })}::text::jsonb)
          WHERE key=${`frameleaf-manager-library-setup:${installation}`}`.execute(db);
          const notified = vi.fn();
          const unsubscribe = operations.onChange(notified);
          if (outcome === 'pause-rollback') {
            const pause = operations.requestPause.bind(operations);
            vi.spyOn(operations, 'requestPause')
              .mockImplementationOnce(pause)
              .mockImplementationOnce(async (...args) => {
                await pause(...args);
                throw new Error('synthetic pause failure');
              });
            await expect(make().setPaused(true)).rejects.toThrow('synthetic pause failure');
            expect(notified).not.toHaveBeenCalled();
            expect((await make().progress()).paused).toBe(false);
            expect(
              (
                await sql<{
                  paused: boolean | null;
                }>`SELECT selection #> '{managerSetup,paused}' AS paused FROM job_run WHERE id=${id}::uuid`.execute(db)
              ).rows[0].paused,
            ).toBe(false);
          } else {
            await make().setPaused(true);
            expect(notified.mock.calls.flatMap(([rows]) => rows)).toEqual(
              expect.arrayContaining([
                { id: queued, ownerId },
                { id: running, ownerId },
                { id: health, ownerId },
              ]),
            );
            notified.mockClear();
            expect(
              (
                await sql<{
                  status: MediaOperationStatus;
                }>`SELECT status FROM media_operation WHERE id=${queued}::uuid`.execute(db)
              ).rows[0].status,
            ).toBe(MediaOperationStatus.Paused);
            expect(
              (
                await sql<{
                  paused: boolean;
                }>`SELECT "pauseRequestedAt" IS NOT NULL AS paused FROM media_operation WHERE id=${running}::uuid`.execute(
                  db,
                )
              ).rows[0].paused,
            ).toBe(true);
            await make().setPaused(false);
            expect(notified.mock.calls.flatMap(([rows]) => rows)).toEqual(
              expect.arrayContaining([
                { id: queued, ownerId },
                { id: running, ownerId },
                { id: health, ownerId },
              ]),
            );
            expect(
              (
                await sql<{
                  status: MediaOperationStatus;
                }>`SELECT status FROM media_operation WHERE id=${queued}::uuid`.execute(db)
              ).rows[0].status,
            ).toBe(MediaOperationStatus.Queued);
          }
          unsubscribe();
          expect(
            (await sql`SELECT 1 FROM media_operation WHERE "pauseRequestedAt" IS NOT NULL`.execute(db)).rows,
          ).toEqual([]);
          break;
        }
        case 'quiet-hours': {
          // Metadata counts with thumbnails, and video conversion with smart search and faces: setup waits for both.
          await sql`INSERT INTO job_run_item("runId","itemKey",stage,queue,state,selection) VALUES
            (${id}::uuid,'synthetic-metadata',${JobName.AssetExtractMetadata},${QueueName.MetadataExtraction},'pending','{}'::jsonb),
            (${id}::uuid,'synthetic-video',${JobName.AssetEncodeVideo},${QueueName.VideoConversion},'pending','{}'::jsonb)`.execute(
            db,
          );
          const stage = async (name: string) => (await make().progress()).stages.find(({ id }) => id === name);
          expect(await stage('thumbnails')).toMatchObject({ status: 'running', done: 2, total: 3 });
          expect(await stage('search')).toEqual({
            id: 'search',
            status: 'running',
            disabled: false,
            done: 2,
            total: 3,
          });
          // FL-577: quiet hours hold the remaining video conversion by day, so the stage waits for tonight.
          await sql`INSERT INTO system_metadata(key,value) VALUES('overnight-sequence',${JSON.stringify({
            run: null,
            nights: [],
            quiet: { holding: [QueueName.SmartSearch, QueueName.FaceDetection, QueueName.VideoConversion] },
          })}::text::jsonb)`.execute(db);
          expect(await stage('search')).toMatchObject({
            status: 'waiting',
            heldForNight: true,
            resumesAt: expect.any(String),
            done: 2,
            total: 3,
          });
          expect(isPaused).toHaveBeenCalledWith(QueueName.VideoConversion);
          // A queue an administrator resumed during the day runs, and a paused setup says paused.
          isPaused.mockResolvedValue(false);
          expect(await stage('search')).toMatchObject({ status: 'running' });
          expect(await stage('search')).not.toHaveProperty('heldForNight');
          isPaused.mockResolvedValue(true);
          await make().setPaused(true);
          expect(await stage('search')).toMatchObject({ status: 'paused' });
          expect(await stage('search')).not.toHaveProperty('heldForNight');
          break;
        }
        case 'empty': {
          await sql`UPDATE job_run SET "enumerationDone"=false WHERE id=${id}::uuid`.execute(db);
          expect((await make().progress()).stages.find(({ id }) => id === 'thumbnails')?.status).toBe('running');
          await sql`UPDATE job_run SET "enumerationDone"=true WHERE id=${id}::uuid`.execute(db);
          expect((await make().status()).phase).toBe('complete');
          expect((await make().progress()).stages.find(({ id }) => id === 'thumbnails')?.status).toBe('done');

          break;
        }
        case 'terminal-alias': {
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

          break;
        }
        default: {
          if (outcome.startsWith('disabled')) {
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
              await sql`UPDATE job_run_item SET state='pending' WHERE "runId"=${id}::uuid AND stage=${stage}`.execute(
                db,
              );
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
            if (outcome === 'disabled') {
              // With AI processing off, videos still count in the stage, which still says AI is off.
              await sql`INSERT INTO job_run_item("runId","itemKey",stage,queue,state,selection)
                VALUES(${id}::uuid,'synthetic-video',${JobName.AssetEncodeVideo},${QueueName.VideoConversion},'pending','{}'::jsonb)`.execute(
                db,
              );
              expect((await make().progress()).stages.find(({ id }) => id === 'search')).toEqual({
                id: 'search',
                status: 'running',
                disabled: true,
                done: 0,
                total: 1,
              });
              await sql`DELETE FROM job_run_item WHERE "runId"=${id}::uuid AND "itemKey"='synthetic-video'`.execute(db);
            } else if (outcome === 'disabled-people') {
              // A retained people-preview child remains required while the AI stages wait for enablement.
              await sql`INSERT INTO job_run_item("runId","itemKey",stage,queue,state,selection)
            VALUES(${id}::uuid,${randomUUID()},${JobName.PersonGenerateThumbnail},${QueueName.ThumbnailGeneration},'pending','{}'::jsonb)`.execute(
                db,
              );
              expect((await make().status()).phase).toBe('verifying');
              const previews = (await make().progress()).stages.find(({ id }) => id === 'thumbnails');
              // The photo's metadata and thumbnail are done; the person preview is not.
              expect(previews).toMatchObject({ total: 3, done: 2, status: 'running' });
              await sql`UPDATE job_run_item SET state='completed' WHERE "runId"=${id}::uuid AND stage=${JobName.PersonGenerateThumbnail}`.execute(
                db,
              );
              await sql`UPDATE system_metadata SET value=jsonb_set(value,'{quietSince}',${JSON.stringify(Date.now() - 11_000)}::text::jsonb)
            WHERE key=${`frameleaf-manager-library-setup:${installation}`}`.execute(db);
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
            if (outcome === 'halting-failed') {
              // A halting queue's item stops setup.
              await sql`INSERT INTO job_queue(name) VALUES(${QueueName.MediaHealth}) ON CONFLICT DO NOTHING`.execute(
                db,
              );
              await sql`INSERT INTO job_run_item("runId","itemKey",stage,queue,state,selection)
                VALUES(${id}::uuid,${randomUUID()},${JobName.MediaHealthScanMissing},${QueueName.MediaHealth},'failed','{}'::jsonb)`.execute(
                db,
              );
              expect((await make().status()).phase).toBe('needs-attention');
              expect(await make().progress()).toMatchObject({ phase: 'needs-attention', completedAt: null });
            } else {
              await sql`UPDATE job_run_item SET state=${outcome} WHERE "runId"=${id}::uuid AND stage=${JobName.SmartSearch}`.execute(
                db,
              );
              // FL-1165: one item's search step that ended badly is listed, never a reason to halt setup, and
              // counts as settled so the setup bar finishes.
              expect((await make().status()).phase).not.toBe('needs-attention');
              await sql`UPDATE system_metadata SET value=jsonb_set(value,'{quietSince}',${JSON.stringify(Date.now() - 11_000)}::text::jsonb)
                WHERE key=${`frameleaf-manager-library-setup:${installation}`}`.execute(db);
              expect((await make().status()).phase).toBe('complete');
              const finished = await make().progress();
              expect(finished.completedAt).toEqual(expect.any(String));
              expect(finished.stages.find(({ id }) => id === 'search')?.status).toBe('done');
            }
          }
        }
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
