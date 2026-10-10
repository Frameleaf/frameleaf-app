import { createPostgres } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetEditAction, AssetEditActionItem } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetLockReason,
  AssetType,
  JobName,
  JobStatus,
  MediaOperationStatus,
  QueueName,
  TranscodeHardwareAcceleration,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QUEUE_TIMING, QueueClaim, QueueExecution } from 'src/queue/types.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { MediaService } from 'src/services/media.service.js';
import { EditOperationEdit, editOperationCreate } from 'src/utils/edit-operation.js';
import { getEditedMasterLineagePath } from 'src/utils/media-policy.js';
import { seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

// Real PostgreSQL, native media I/O, entry guard, operation claim and adoption.
// This intentionally asserts the concurrent-save contract, rather than expecting
// the current generic input-snapshot refusal or serializing the two saves.
describe.sequential('retained video render entry publication (PR201)', () => {
  let db: Kysely<DB>;
  let databaseName: string;
  let folder: string;
  let originalRoot: string | undefined;

  beforeAll(() => {
    execFileSync('ffmpeg', ['-version'], { timeout: 10_000 });
    execFileSync('ffprobe', ['-version'], { timeout: 10_000 });
  });
  beforeEach(async () => {
    // A predicted RED must not leave unfinished operations in another control's database.
    databaseName = '';
    db = await getKyselyDB();
    databaseName = (await sql<{ name: string }>`select current_database() name`.execute(db)).rows[0].name;
    folder = mkdtempSync(join(tmpdir(), 'fl201-video-entry-'));
    try {
      originalRoot = StorageCore.getMediaLocation();
    } catch {
      originalRoot = undefined;
    }
    StorageCore.setMediaLocation(folder);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    StorageCore.setMediaLocation(originalRoot as string);
    if (folder) rmSync(folder, { recursive: true, force: true });
    await db?.destroy();
    if (databaseName) {
      // Only the disposable database this file actually created; never the template.
      expect(databaseName).toMatch(/^frameleaf_[a-z0-9]+$/);
      const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
      url.pathname = '/postgres';
      const admin = createPostgres({ maxConnections: 1, connection: { connectionType: 'url', url: url.href } });
      try {
        await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  });

  const recipeA: AssetEditActionItem[] = [
    { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 128, height: 80 } },
  ];
  const recipeB: AssetEditActionItem[] = [
    { action: AssetEditAction.Crop, parameters: { x: 16, y: 16, width: 96, height: 64 } },
  ];

  const prepare = async () => {
    const source = join(folder, 'original.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x96:rate=30:duration=0.4',
        '-an',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-colorspace',
        'bt709',
        source,
      ],
      { timeout: 15_000 },
    );
    const checksum = createHash('sha256').update(readFileSync(source)).digest();
    const { sut, ctx } = newMediumService(MediaService, {
      database: db,
      real: [
        AssetEditRepository,
        AssetJobRepository,
        AssetRepository,
        ConfigRepository,
        AssetChecksumRepository,
        MediaRepository,
        MediaOperationRepository,
        StorageRepository,
        SystemMetadataRepository,
        UserRepository,
      ],
      mock: [JobRepository, LoggingRepository],
    });
    // The medium factory cannot construct JobRepository's ModuleRef dependencies.
    // Inject the real repository, not a guard forwarding double or a SQL emulator.
    const jobs = new JobRepository({} as never, ctx.get(ConfigRepository), {} as never, LoggingRepository.create(), db);
    sut['jobRepository'] = jobs;
    jobs['handlers'][JobName.FileDelete] = {
      jobName: JobName.FileDelete,
      queueName: QueueName.BackgroundTask,
      label: 'StorageService.handleDeleteFiles',
      handler: () => Promise.resolve(JobStatus.Success),
    };
    const config = await ctx.getConfig({ withCache: false });
    Object.assign(config.ffmpeg, {
      accel: TranscodeHardwareAcceleration.Disabled,
      accelDecode: false,
      threads: 1,
      preset: 'ultrafast',
      crf: 30,
      targetResolution: '144',
      maxBitrate: '100k',
    });
    await ctx.updateConfig(config);
    const media = ctx.get(MediaRepository);
    const info = await media.probe(source);
    const video = info.videoStreams[0];
    expect(info.format.formatName).toBeTruthy();
    expect(info.format.formatLongName).toBeTruthy();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Video,
      originalPath: source,
      checksum,
      duration: 400,
    });
    await ctx.get(AssetRepository).upsertExif({
      exif: { assetId: asset.id, exifImageWidth: 160, exifImageHeight: 96, orientation: '1', fps: video.frameRate },
      video: {
        assetId: asset.id,
        bitrate: video.bitrate,
        frameCount: video.frameCount,
        timeBase: video.timeBase!,
        index: video.index,
        profile: video.profile,
        level: video.level,
        colorPrimaries: video.colorPrimaries,
        colorTransfer: video.colorTransfer,
        colorMatrix: video.colorMatrix,
        dvProfile: video.dvProfile,
        dvLevel: video.dvLevel,
        dvBlSignalCompatibilityId: video.dvBlSignalCompatibilityId,
        codecName: video.codecName!,
        formatName: info.format.formatName!,
        formatLongName: info.format.formatLongName!,
        pixelFormat: video.pixelFormat,
      },
      lockedPropertiesBehavior: 'override',
    });
    const edits = ctx.get(AssetEditRepository);
    await edits.replaceAll(asset.id, []);
    const previous = (await edits.getRequestedVideoVersion(asset.id))!;
    expect(
      (
        await edits.publishVideoVersion(previous, {
          masterPath: null,
          files: [],
          width: 160,
          height: 96,
          duration: 400,
        })
      ).published,
    ).toBe(true);
    const operations = ctx.get(MediaOperationRepository);
    const store = new SqlQueueStore(db);
    const worker = randomUUID();
    await store.initialize([QueueName.VideoConversion, QueueName.BackgroundTask], worker);
    const unlink = vi.spyOn(ctx.get(StorageRepository), 'unlink'); // Calls actual filesystem I/O.
    const transcode = vi.spyOn(media, 'transcode'); // Calls actual native I/O.
    const selection = async () =>
      (
        await sql<{ currentVersionId: string | null; requestedVersionId: string }>`
      select "currentVersionId", "requestedVersionId" from public.video_edit_selection
      where "assetId" = ${asset.id}::uuid`.execute(db)
      ).rows[0];
    const references = () =>
      db
        .selectFrom('asset_file')
        .select(['path', 'type', 'isEdited'])
        .where('assetId', '=', asset.id)
        .orderBy('path')
        .execute();
    const save = async (recipe: AssetEditActionItem[]) => {
      await edits.replaceAll(asset.id, recipe);
      const version = (await edits.getRequestedVideoVersion(asset.id))!;
      // Match normal AssetService.queueEditRender: the operation names its
      // revision, while the queued handler resolves the requested version.
      const data = { id: asset.id };
      const operation = await operations.create(
        editOperationCreate({
          ownerId: user.id,
          assetId: asset.id,
          edit: EditOperationEdit.VideoEdit,
          label: 'retained entry fixture',
          revisionId: version.id,
          job: { name: JobName.AssetVideoEditGeneration, data },
        }),
      );
      await store.enqueue([
        {
          queue: QueueName.VideoConversion,
          name: JobName.AssetVideoEditGeneration,
          data: { ...data, operationId: operation.id },
          safeToRetry: false,
          sensitive: false,
          deadlineMs: QUEUE_TIMING.opaqueDeadline,
        },
      ]);
      let claim: QueueClaim;
      let context: QueueExecution;
      const render = async () => {
        // Saving B must not require a second worker slot while A is active.
        // B acquires its genuine queue claim only when its render actually starts.
        const claims = await store.claim(QueueName.VideoConversion, worker, 1);
        expect(claims).toHaveLength(1);
        claim = claims[0];
        expect(claim.data.operationId).toBe(operation.id);
        context = {
          claim,
          signal: new AbortController().signal,
          progress: vi.fn(),
          progressUnits: 0,
          buffering: false,
          adoptions: [],
          followups: [],
        };
        return queueExecution.run(context, () =>
          sut.handleAssetVideoEditGeneration({
            ...data,
            operationId: operation.id,
          }),
        );
      };
      const commit = () =>
        store.complete(claim, context.followups, (tx) =>
          publicationTransaction.run(tx, () =>
            queueExecution.run(context, async () => {
              for (const adopt of context.adoptions) await adopt(tx);
            }),
          ),
        );
      const notify = async () => {
        for (const callback of context.afterCommit ?? []) await callback();
      };
      return {
        version,
        operation,
        get claim() {
          return claim;
        },
        get context() {
          return context;
        },
        render,
        commit,
        notify,
      };
    };
    return {
      asset,
      user,
      source,
      checksum,
      sut,
      media,
      edits,
      operations,
      store,
      selection,
      references,
      save,
      unlink,
      transcode,
      previous,
    };
  };

  it('supersedes A saved during rendering and publishes literal B under both real claims', async () => {
    const f = await prepare();
    const a = await f.save(recipeA);
    const { promise: captured, resolve: reached } = Promise.withResolvers<void>();
    const { promise: resume, resolve: release } = Promise.withResolvers<void>();
    const realProbe = f.media.probe.bind(f.media);
    let first = true;
    vi.spyOn(f.media, 'probe').mockImplementation(async (...args) => {
      if (first && args[0] === f.source) {
        first = false;
        reached();
        await resume;
      }
      return realProbe(...args);
    });
    const rendering = a.render();
    // Always release the actual in-flight handler, including a failed fixture save.
    let b: Awaited<ReturnType<typeof f.save>>;
    let admissionFailed = false;
    let admissionError: unknown;
    try {
      await Promise.race([
        captured,
        rendering.then(() => {
          throw new Error('Render returned before the real source-probe barrier');
        }),
      ]);
      expect((await f.operations.getForWorker(a.operation.id))?.status).toBe(MediaOperationStatus.Rendering);
      b = await f.save(recipeB);
    } catch (error) {
      admissionFailed = true;
      admissionError = error;
    } finally {
      release();
    }
    expect(await rendering).toBe(JobStatus.Success);
    if (admissionFailed) throw admissionError;
    // Thumbnail scoring may already have removed its own scratch files. Only
    // candidates still owned by the prepared publication are acceptance inputs.
    const candidates = f.transcode.mock.calls
      .map(([, output]) => output)
      .filter((path): path is string => typeof path === 'string' && existsSync(path));
    expect(candidates.length).toBeGreaterThan(0);
    const master = candidates.find((path) => path.endsWith('.master.mp4'));
    expect(master).toBeDefined();
    candidates.push(getEditedMasterLineagePath(master!));
    for (const path of candidates) expect(existsSync(path)).toBe(true);
    const unlinksBeforeAcceptance = f.unlink.mock.calls.length;
    // Original011 is expected to reject here with the generic mutable-input guard.
    expect(await a.commit()).toBe(true);
    expect(await f.selection()).toEqual({ currentVersionId: f.previous.id, requestedVersionId: b!.version.id });
    expect(await f.references()).toEqual([]);
    expect(await f.operations.getForWorker(a.operation.id)).toMatchObject({
      status: MediaOperationStatus.Completed,
      claimToken: null,
      resultAssetId: null,
      revisionId: a.version.id,
    });
    expect(f.unlink.mock.calls).toHaveLength(unlinksBeforeAcceptance);
    await a.notify();
    for (const path of candidates) expect(existsSync(path)).toBe(false);
    expect(await b!.render()).toBe(JobStatus.Success);
    expect(await b!.commit()).toBe(true);
    await b!.notify();
    expect(await f.selection()).toEqual({ currentVersionId: b!.version.id, requestedVersionId: b!.version.id });
    expect((await f.edits.getVideoVersion(f.asset.id, b!.version.id))?.recipe).toEqual(recipeB);
    expect(await f.operations.getForWorker(b!.operation.id)).toMatchObject({
      status: MediaOperationStatus.Completed,
      claimToken: null,
      resultAssetId: f.asset.id,
      revisionId: b!.version.id,
    });
    expect((await f.references()).length).toBeGreaterThan(0);
    expect(await f.store.hasUnfinishedWork(QueueName.VideoConversion)).toBe(false);
    expect(createHash('sha256').update(readFileSync(f.source)).digest()).toEqual(f.checksum);
  }, 60_000);

  it('publishes sequential A then B without changing the original', async () => {
    const f = await prepare();
    for (const recipe of [recipeA, recipeB]) {
      const run = await f.save(recipe);
      expect(await run.render()).toBe(JobStatus.Success);
      expect(await run.commit()).toBe(true);
      await run.notify();
      expect((await f.selection()).currentVersionId).toBe(run.version.id);
      expect((await f.edits.getVideoVersion(f.asset.id, run.version.id))?.recipe).toEqual(recipe);
      expect(await f.operations.getForWorker(run.operation.id)).toMatchObject({
        status: MediaOperationStatus.Completed,
        claimToken: null,
        resultAssetId: f.asset.id,
      });
    }
    expect(await f.store.hasUnfinishedWork(QueueName.VideoConversion)).toBe(false);
    expect(createHash('sha256').update(readFileSync(f.source)).digest()).toEqual(f.checksum);
  }, 60_000);

  it('allows a derivative-only file change without treating the immutable original as changed', async () => {
    const f = await prepare();
    const run = await f.save(recipeA);
    expect(await run.render()).toBe(JobStatus.Success);
    const derivative = join(folder, 'independent.webp');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', f.source, '-frames:v', '1', '-threads', '1', derivative], {
      timeout: 10_000,
    });
    await db
      .insertInto('asset_file')
      .values({
        assetId: f.asset.id,
        path: derivative,
        type: AssetFileType.Thumbnail,
        physicalFileId: null,
        isEdited: false,
        isProgressive: false,
        isTransparent: false,
      })
      .execute();
    expect(await run.commit()).toBe(true);
    await run.notify();
    expect((await f.selection()).currentVersionId).toBe(run.version.id);
    expect(await f.operations.getForWorker(run.operation.id)).toMatchObject({
      status: MediaOperationStatus.Completed,
      claimToken: null,
    });
  }, 60_000);

  it.each(['checksum', 'owner', 'deleted', 'lock', 'path', 'operation claim', 'queue claim'] as const)(
    'refuses %s changes at acceptance without adopting candidates or completing the operation',
    async (fault) => {
      const f = await prepare();
      const run = await f.save(recipeA);
      expect(await run.render()).toBe(JobStatus.Success);
      const before = await f.references();
      const unlinksBeforeAcceptance = f.unlink.mock.calls.length;
      switch (fault) {
        case 'checksum': {
          await db
            .updateTable('asset')
            .set({ checksum: Buffer.alloc(32, 9) })
            .where('id', '=', f.asset.id)
            .execute();
          break;
        }
        case 'owner': {
          const other = await seedCanonicalUser(db);
          await db.updateTable('asset').set({ ownerId: other.id }).where('id', '=', f.asset.id).execute();
          break;
        }
        case 'deleted': {
          await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', f.asset.id).execute();
          break;
        }
        case 'lock': {
          await db
            .insertInto('asset_lock')
            .values({
              assetId: f.asset.id,
              reason: AssetLockReason.Marked,
              lockedBy: f.user.id,
              previousVisibility: null,
            })
            .execute();
          break;
        }
        case 'path': {
          await db
            .updateTable('asset')
            .set({ originalPath: join(folder, 'replaced.mp4') })
            .where('id', '=', f.asset.id)
            .execute();
          break;
        }
        case 'operation claim': {
          await db
            .updateTable('media_operation')
            .set({ claimExpiresAt: new Date(0) })
            .where('id', '=', run.operation.id)
            .execute();
          break;
        }
        case 'queue claim': {
          await db
            .updateTable('job')
            .set({ leaseExpiresAt: new Date(0) })
            .where('id', '=', run.claim.id)
            .execute();
          break;
        }
      }
      if (fault === 'queue claim') expect(await run.commit()).toBe(false);
      else
        await expect(run.commit()).rejects.toThrow(
          fault === 'checksum'
            ? 'Prepared output source changed'
            : fault === 'operation claim'
              ? 'Edit operation lost its claim before publication'
              : 'Asset inputs changed before publication',
        );
      expect((await f.selection()).currentVersionId).toBe(f.previous.id);
      expect(await f.references()).toEqual(before);
      expect((await f.operations.getForWorker(run.operation.id))?.status).not.toBe(MediaOperationStatus.Completed);
      const retained = await sql<{ masterPath: string | null }>`select "masterPath" from public.video_edit_version
        where id = ${run.version.id}::uuid`.execute(db);
      expect(retained.rows).toEqual([{ masterPath: null }]);
      expect(f.unlink.mock.calls).toHaveLength(unlinksBeforeAcceptance);
    },
    60_000,
  );
});
